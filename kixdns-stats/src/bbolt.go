//go:build linux

package main

import (
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	bolt "go.etcd.io/bbolt"
)

// ponytail: scan bounded hourly associations instead of maintaining indexes.
// This is a live key/value budget (including 16-byte leaf entries), NOT a
// process, mmap, file-size or tmpfs limit. COW/free pages need extra headroom.
const jointBudget = 8 * 1024 * 1024
const databaseName = "stats.db"

var bucketNames = []string{"totals", "hourly", "gaps", "classes", "meta"} // meta copied last

type queryFilter struct {
	Client   string `json:"client"`
	Domain   string `json:"domain"`
	Category string `json:"category"`
}

func (q queryFilter) active() bool { return q.Client != "" || q.Domain != "" || q.Category != "" }
func parseFilter(text string) (queryFilter, error) {
	var q queryFilter
	if strings.TrimSpace(text) == "null" {
		return q, errors.New("expected a filter object")
	}
	if len(text) > 2048 {
		return q, errors.New("filter is too long")
	}
	d := json.NewDecoder(strings.NewReader(text))
	d.DisallowUnknownFields()
	if err := d.Decode(&q); err != nil {
		return q, err
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return q, errors.New("expected one filter object")
	}
	for _, p := range []*string{&q.Client, &q.Domain, &q.Category} {
		*p = strings.ToLower(strings.TrimSpace(*p))
		if len(*p) > 256 || strings.ContainsFunc(*p, func(r rune) bool { return r < 32 || r == 127 }) {
			return q, errors.New("invalid filter")
		}
	}
	switch q.Category {
	case "", "ads", "trackers", "malware", "phishing", "adult", "social", "cdn", "pcdn", "p2p", "gaming", "cloud", "captive", "ai", "update", "streaming", "ok", "lan", "pending":
	default:
		return q, errors.New("unknown category")
	}
	return q, nil
}

type hourCoverage struct {
	Time        string `json:"t"`
	Stored      int64  `json:"stored"`
	Legacy      int64  `json:"legacy"`
	Capacity    int64  `json:"capacity"`
	Unsupported int64  `json:"unsupported"`
}
type coverageInfo struct {
	Hours      []hourCoverage `json:"hours"`
	LimitBytes int64          `json:"limit_bytes"`
}

// Flat buckets only. Triples hold queries/hits/errors, or unavailable/capacity/unsupported.
type triple [3]int64

func unpack(b []byte) (triple, error) {
	var n triple
	if b == nil {
		return n, nil
	}
	if len(b) != 24 {
		return n, errors.New("invalid statistics count")
	}
	for i := range n {
		n[i] = int64(binary.BigEndian.Uint64(b[i*8:]))
		if n[i] < 0 {
			return n, errors.New("invalid negative count")
		}
	}
	return n, nil
}
func pack(n triple) ([]byte, error) {
	b := make([]byte, 24)
	for i, v := range n {
		if v < 0 {
			return nil, errors.New("statistics count overflow")
		}
		binary.BigEndian.PutUint64(b[i*8:], uint64(v))
	}
	return b, nil
}
func meta(tx *bolt.Tx, key string) string { return string(tx.Bucket([]byte("meta")).Get([]byte(key))) }
func validateDB(tx *bolt.Tx) error {
	for _, name := range bucketNames {
		if tx.Bucket([]byte(name)) == nil {
			return errors.New("unrecognized statistics database")
		}
	}
	if meta(tx, "version") != "2" {
		return errors.New("unsupported statistics database version")
	}
	return nil
}

type boltStore struct {
	tx         *bolt.Tx
	dirty      bool
	jointBytes int64
}

func (s *boltStore) put(bucket string, key, value []byte) error {
	b := s.tx.Bucket([]byte(bucket))
	if bytes.Equal(b.Get(key), value) {
		return nil
	}
	if err := b.Put(key, value); err != nil {
		return err
	}
	s.dirty = true
	return nil
}
func (s *boltStore) setMeta(key, value string) error {
	return s.put("meta", []byte(key), []byte(value))
}
func (s *boltStore) putCount(bucket string, key []byte, n triple) error {
	b, err := pack(n)
	if err != nil {
		return err
	}
	return s.put(bucket, key, b)
}
func (s *boltStore) gap(h string, which int, n int64) error {
	key := []byte(h)
	v, err := unpack(s.tx.Bucket([]byte("gaps")).Get(key))
	if err != nil {
		return err
	}
	v[which] += n
	return s.putCount("gaps", key, v)
}
func (s *boltStore) saveCursor(cur cursor) error {
	for k, v := range map[string]string{"cursor_id": cur.id, "cursor_mark": cur.mark, "cursor_offset": strconv.FormatInt(cur.offset, 10)} {
		if err := s.setMeta(k, v); err != nil {
			return err
		}
	}
	return nil
}
func (s *boltStore) finish() error {
	if err := s.setMeta("joint_bytes", strconv.FormatInt(s.jointBytes, 10)); err != nil {
		return err
	}
	if !s.dirty {
		return s.tx.Rollback()
	} // Even an empty bbolt Commit writes metadata.
	n, err := strconv.ParseUint(meta(s.tx, "revision"), 10, 64)
	if err != nil {
		return err
	}
	if err = s.setMeta("revision", strconv.FormatUint(n+1, 10)); err != nil {
		return err
	}
	return s.tx.Commit()
}
func initializeStore(tx *bolt.Tx) (*boltStore, error) {
	s := &boltStore{tx: tx}
	if tx.Bucket([]byte("meta")) != nil {
		if err := validateDB(tx); err != nil {
			return nil, err
		}
		n, err := strconv.ParseInt(meta(tx, "joint_bytes"), 10, 64)
		if err != nil || n < 0 {
			return nil, errors.New("invalid joint byte count")
		}
		s.jointBytes = n
		return s, nil
	}
	if k, _ := tx.Cursor().First(); k != nil {
		return nil, errors.New("unrecognized statistics database")
	}
	for _, name := range bucketNames {
		if _, err := tx.CreateBucket([]byte(name)); err != nil {
			return nil, err
		}
	}
	s.dirty = true
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		return nil, err
	}
	for k, v := range map[string]string{"version": "2", "id": hex.EncodeToString(id), "revision": "0", "joint_bytes": "0"} {
		if err := s.setMeta(k, v); err != nil {
			return nil, err
		}
	}
	if err := s.saveCursor(cursor{}); err != nil {
		return nil, err
	}
	return s, nil
}
func (s *boltStore) loadMetrics(hours []string) (*counters, cursor, error) {
	c := newCounters(hours)
	err := s.tx.Bucket([]byte("totals")).ForEach(func(k, v []byte) error {
		n, err := unpack(v)
		if err != nil {
			return err
		}
		for i, kind := range []string{"q", "cache", "err"} {
			c.bump(kind, string(k), "-", n[i])
		}
		return nil
	})
	cur := cursor{id: meta(s.tx, "cursor_id"), mark: meta(s.tx, "cursor_mark")}
	if err != nil {
		return nil, cur, err
	}
	cur.offset, err = strconv.ParseInt(meta(s.tx, "cursor_offset"), 10, 64)
	if err != nil || cur.offset < 0 {
		return nil, cur, errors.New("invalid database cursor")
	}
	return c, cur, nil
}
func (s *boltStore) saveMetrics(c *counters) error {
	by := make(map[string]triple)
	for k, n := range c.values {
		v := by[k.hour]
		switch k.kind {
		case "q":
			v[0] = n
		case "cache":
			v[1] = n
		case "err":
			v[2] = n
		default:
			continue
		}
		by[k.hour] = v
	}
	for h, n := range by {
		if err := s.putCount("totals", []byte(h), n); err != nil {
			return err
		}
	}
	return nil
}

// Re-seek after delete: bbolt Cursor.Next can otherwise skip the following key.
func (s *boltStore) deleteKey(bucket string, k, v []byte) error {
	if err := s.tx.Bucket([]byte(bucket)).Delete(k); err != nil {
		return err
	}
	if bucket == "hourly" {
		s.jointBytes -= int64(len(k) + len(v) + 16)
	}
	s.dirty = true
	return nil
}
func (s *boltStore) pruneExpired(hours []string) error {
	keep := newCounters(hours).keep
	for _, name := range []string{"totals", "hourly", "gaps"} {
		c := s.tx.Bucket([]byte(name)).Cursor()
		for k, v := c.First(); k != nil; {
			if len(k) < 13 {
				return errors.New("invalid hour key")
			}
			if keep[string(k[:13])] {
				k, v = c.Next()
				continue
			}
			key := bytes.Clone(k)
			if err := s.deleteKey(name, key, v); err != nil {
				return err
			}
			k, v = c.Seek(key)
		}
	}
	return nil
}
func (s *boltStore) pruneCapacity(limit int64) error {
	c := s.tx.Bucket([]byte("hourly")).Cursor()
	for s.jointBytes > limit {
		k, _ := c.First()
		if len(k) < 14 {
			return errors.New("invalid joint byte count")
		}
		h := string(k[:13])
		prefix := []byte(h + "\x00")
		var removed int64
		for k, v := c.Seek(prefix); k != nil && bytes.HasPrefix(k, prefix); k, v = c.Seek(prefix) {
			n, err := unpack(v)
			if err != nil {
				return err
			}
			removed += n[0]
			if err = s.deleteKey("hourly", k, v); err != nil {
				return err
			}
		}
		if err := s.gap(h, 1, removed); err != nil {
			return err
		}
	}
	return nil
}
func (s *boltStore) recordJoint(h, domain string, f map[string]string) error {
	fields := [6]string{f["client_ip"], domain, f["upstream"], f["pipeline"], f["qtype"], f["rcode"]}
	for _, v := range fields {
		if len(v) > 4096 {
			return s.gap(h, 2, 1)
		}
	}
	data, err := json.Marshal(fields)
	if err != nil {
		return err
	}
	key := append([]byte(h+"\x00"), data...)
	if len(key) > bolt.MaxKeySize {
		return s.gap(h, 2, 1)
	}
	old := s.tx.Bucket([]byte("hourly")).Get(key)
	n, err := unpack(old)
	if err != nil {
		return err
	}
	n[0]++
	if f["cache"] == "true" {
		n[1]++
	}
	if f["rcode"] != "" && f["rcode"] != "NoError" {
		n[2]++
	}
	if err = s.putCount("hourly", key, n); err != nil {
		return err
	}
	if old == nil {
		s.jointBytes += int64(len(key) + 24 + 16)
	}
	return s.pruneCapacity(jointBudget)
}
func jointFields(k []byte) (string, []string, error) {
	var f []string
	if len(k) < 16 || k[13] != 0 {
		return "", nil, errors.New("invalid association key")
	}
	if err := json.Unmarshal(k[14:], &f); err != nil {
		return "", nil, err
	}
	if len(f) != 6 {
		return "", nil, errors.New("invalid association dimensions")
	}
	return string(k[:13]), f, nil
}
func filteredSnapshot(tx *bolt.Tx, hours []string, classes map[string]classification, cached int, hosts map[string]string, enabled bool, q queryFilter) (snapshot, error) {
	var empty snapshot
	matchingIPs := make(map[string]bool)
	_, addrErr := netip.ParseAddr(q.Client)
	if q.Client != "" && addrErr != nil {
		for ip, host := range hosts {
			if strings.Contains(strings.ToLower(host), q.Client) {
				matchingIPs[ip] = true
			}
		}
		if len(matchingIPs) > 1024 {
			return empty, errors.New("client search matches too many hostnames; narrow it")
		}
	}
	by := make(map[string]hourCoverage)
	err := tx.Bucket([]byte("gaps")).ForEach(func(k, v []byte) error {
		n, e := unpack(v)
		if e != nil {
			return e
		}
		h := string(k)
		by[h] = hourCoverage{Time: h, Legacy: n[0], Capacity: n[1], Unsupported: n[2]}
		return nil
	})
	if err != nil {
		return empty, err
	}
	c := newCounters(hours)
	categories := make(map[string]string)
	err = tx.Bucket([]byte("hourly")).ForEach(func(k, v []byte) error {
		h, f, e := jointFields(k)
		if e != nil {
			return e
		}
		n, e := unpack(v)
		if e != nil {
			return e
		}
		cover := by[h]
		cover.Stored += n[0]
		by[h] = cover
		cat, ok := categories[f[1]]
		if !ok {
			cat = "pending"
			if cl, found := resolve(f[1], classes); found {
				cat = cl.category
			}
			categories[f[1]] = cat
		}
		if !strings.Contains(f[1], q.Domain) || (q.Category != "" && q.Category != cat) {
			return nil
		}
		if q.Client != "" {
			if addrErr == nil {
				if f[0] != q.Client {
					return nil
				}
			} else if !strings.Contains(strings.ToLower(f[0]), q.Client) && !matchingIPs[f[0]] {
				return nil
			}
		}
		for i, kind := range []string{"q", "cache", "err"} {
			c.values[metric{kind, h, "-"}] += n[i]
		}
		for i, kind := range []string{"client", "qname", "upstream", "pipeline", "qtype", "rcode"} {
			if f[i] != "" {
				c.values[metric{kind, hours[len(hours)-1], f[i]}] += n[0]
			}
		}
		return nil
	})
	if err != nil {
		return empty, err
	}
	result := c.render(hours, classes, cached, hosts, enabled)
	result.Filters = &q
	result.Classify.Pending = 0
	for _, cat := range categories {
		if cat == "pending" {
			result.Classify.Pending++
		}
	}
	result.Coverage = &coverageInfo{LimitBytes: jointBudget}
	for i, h := range hours {
		v := by[h]
		v.Time = h
		result.Coverage.Hours = append(result.Coverage.Hours, v)
		if v.Legacy+v.Capacity+v.Unsupported > 0 {
			result.Partial = true
			result.Hours[i].Partial = true
		}
	}
	return result, nil
}

func connectBolt(name string, readonly bool) (*bolt.DB, error) {
	if info, err := os.Lstat(name); err == nil {
		if !info.Mode().IsRegular() || info.Sys().(*syscall.Stat_t).Uid != uint32(os.Geteuid()) {
			return nil, errors.New("unsafe statistics database")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	db, err := bolt.Open(name, 0600, &bolt.Options{ReadOnly: readonly, Timeout: 5 * time.Second})
	if err != nil {
		return nil, err
	}
	db.AllocSize = 1 << 20
	if !readonly {
		if err = os.Chmod(name, 0600); err != nil {
			db.Close()
			return nil, err
		}
	}
	return db, nil
}

// Copy/compact only for initialization, restoration or significant free space.
// Normal checkpoints diff keys in one transaction, not repeated full copies.
func compactReplace(db *bolt.DB, target string) error {
	f, err := os.CreateTemp(filepath.Dir(target), ".stats-db-")
	if err != nil {
		return err
	}
	name := f.Name()
	f.Close()
	defer os.Remove(name)
	dst, err := connectBolt(name, false)
	if err != nil {
		return err
	}
	err = bolt.Compact(dst, db, 1<<20)
	closeErr := dst.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = syncPath(name); err != nil {
		return err
	}
	if err = os.Rename(name, target); err != nil {
		return err
	}
	return syncPath(filepath.Dir(target))
}
func openManaged(name string) (*bolt.DB, error) {
	db, err := connectBolt(name, false)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(name)
	if err != nil {
		db.Close()
		return nil, err
	}
	// Deleted pages are reused, not truncated. Compact only a large, substantially
	// empty file, amortizing full rewrites instead of vacuuming every checkpoint.
	if info.Size() > 2*jointBudget {
		var used int64
		if err = db.View(func(tx *bolt.Tx) error { used = tx.Size(); return nil }); err != nil {
			db.Close()
			return nil, err
		}
		st := db.Stats()
		reclaim := int64(st.FreePageN+st.PendingPageN)*int64(db.Info().PageSize) + info.Size() - used
		if reclaim > info.Size()/3 {
			err = compactReplace(db, name)
			db.Close()
			if err != nil {
				return nil, err
			}
			return connectBolt(name, false)
		}
	}
	return db, nil
}
func openDatabase(p paths) (*bolt.DB, error) {
	name := filepath.Join(p.state, databaseName)
	if _, err := os.Stat(name); errors.Is(err, os.ErrNotExist) {
		source := filepath.Join(p.persist, databaseName)
		if _, e := os.Stat(source); e == nil {
			saved, e := connectBolt(source, true)
			if e != nil {
				return nil, e
			}
			e = saved.View(validateDB)
			if e == nil {
				e = compactReplace(saved, name)
			}
			saved.Close()
			if e != nil {
				return nil, e
			}
		} else if !errors.Is(e, os.ErrNotExist) && !errors.Is(e, syscall.ENOTDIR) {
			return nil, e
		} else {
			// Publish a fully initialized bbolt header, never a half-created live file.
			tmp, e := os.CreateTemp(p.state, ".stats-db-init-")
			if e != nil {
				return nil, e
			}
			tmpName := tmp.Name()
			tmp.Close()
			defer os.Remove(tmpName)
			fresh, e := connectBolt(tmpName, false)
			if e != nil {
				return nil, e
			}
			if e = fresh.Close(); e != nil {
				return nil, e
			}
			if e = os.Rename(tmpName, name); e != nil {
				return nil, e
			}
		}
	} else if err != nil {
		return nil, err
	}
	return openManaged(name)
}
func checkpointChanges(src, dst *bolt.Tx) error {
	for _, name := range bucketNames {
		from := src.Bucket([]byte(name))
		to := dst.Bucket([]byte(name))
		if from == nil || to == nil {
			return errors.New("missing statistics bucket")
		}
		c := to.Cursor()
		for k, _ := c.First(); k != nil; {
			if from.Get(k) != nil {
				k, _ = c.Next()
				continue
			}
			key := bytes.Clone(k)
			if err := to.Delete(key); err != nil {
				return err
			}
			k, _ = c.Seek(key)
		}
		if err := from.ForEach(func(k, v []byte) error {
			if v == nil {
				return errors.New("unexpected nested statistics bucket")
			}
			if bytes.Equal(to.Get(k), v) {
				return nil
			}
			return to.Put(k, v)
		}); err != nil {
			return err
		}
	}
	return nil
}
func checkpointDatabase(db *bolt.DB, p paths) error {
	if err := privateDir(p.persist); err != nil {
		return err
	}
	target := filepath.Join(p.persist, databaseName)
	if _, err := os.Stat(target); errors.Is(err, os.ErrNotExist) {
		return compactReplace(db, target)
	} else if err != nil {
		return err
	}
	saved, err := openManaged(target)
	if err != nil {
		return err
	}
	defer saved.Close()
	replace := false
	err = db.View(func(src *bolt.Tx) error {
		equal := false
		if e := saved.View(func(dst *bolt.Tx) error {
			if e := validateDB(dst); e != nil {
				return e
			}
			replace = meta(src, "id") != meta(dst, "id")
			equal = !replace && meta(src, "revision") == meta(dst, "revision")
			return nil
		}); e != nil {
			return e
		}
		if replace || equal {
			return nil
		}
		return saved.Update(func(dst *bolt.Tx) error { return checkpointChanges(src, dst) })
	})
	if err != nil {
		return err
	}
	if replace {
		if err = saved.Close(); err != nil {
			return err
		}
		return compactReplace(db, target)
	}
	return nil
}

func validDomain(q string) bool {
	if q == "" || len(q) > 253 {
		return false
	}
	for _, label := range strings.Split(q, ".") {
		if label == "" || len(label) > 63 || strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") {
			return false
		}
		for _, r := range label {
			if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '_' || r == '-') {
				return false
			}
		}
	}
	return true
}
