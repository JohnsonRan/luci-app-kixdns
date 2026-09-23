//go:build linux

// Native statistics core. Classification transport remains in the shell wrapper.
package main

import (
	"bufio"
	"bytes"
	"crypto/md5" // Boundary fingerprint, not a security primitive; matches existing cursors.
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"math/bits"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type paths struct {
	log, state, persist, leases, hosts, odhcp string
}

type metric struct{ kind, hour, name string }
type cursor struct {
	id, mark string
	offset   int64
}
type counters struct {
	values   map[metric]int64
	keep     map[string]bool
	distinct map[[2]string]int
}
type classification struct {
	category   string
	confidence float64
}
type hour struct {
	Time    string `json:"t"`
	Queries int64  `json:"q"`
	Partial bool   `json:"partial,omitempty"`
}
type classificationStatus struct {
	Enabled bool `json:"enabled"`
	Cached  int  `json:"cached"`
	Pending int  `json:"pending"`
}
type totalReference struct {
	Queries   int64 `json:"queries"`
	CacheHits int64 `json:"cache_hits"`
	Errors    int64 `json:"errors"`
}
type snapshot struct {
	Until       string               `json:"until"`
	Queries     int64                `json:"queries"`
	CacheHits   int64                `json:"cache_hits"`
	Errors      int64                `json:"errors"`
	Unique      int                  `json:"unique"`
	Limited     bool                 `json:"limited"`
	Hours       []hour               `json:"hours"`
	TopQname    [][]any              `json:"top_qname"`
	TopClient   [][]any              `json:"top_client"`
	TopUpstream [][]any              `json:"top_upstream"`
	TopPipeline [][]any              `json:"top_pipeline"`
	Qtype       map[string]int64     `json:"qtype"`
	Rcode       map[string]int64     `json:"rcode"`
	Cats        map[string]int64     `json:"cats"`
	Classify    classificationStatus `json:"classify"`
	Filters     *queryFilter         `json:"filters,omitempty"`
	Coverage    *coverageInfo        `json:"coverage,omitempty"`
	Totals      *totalReference      `json:"totals,omitempty"`
	Partial     bool                 `json:"partial,omitempty"`
}

var (
	fieldPattern = regexp.MustCompile(`(^|[ \t])([A-Za-z_][A-Za-z0-9_.]*)=("([^"\\]|\\.)*"|[^ \t"]+)`)
	colorPattern = regexp.MustCompile("\x1b\\[[0-9;]*m")
	hourPattern  = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}`)
	hostPattern  = regexp.MustCompile(`^[0-9a-fA-F.:]+$`)
)

func envPath(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func runtimePaths() paths {
	return paths{
		envPath("KIXDNS_LOG", "/tmp/kixdns.log"),
		envPath("KIXDNS_STATEDIR", "/tmp/kixdns-stats"),
		envPath("KIXDNS_PERSISTDIR", "/etc/kixdns"),
		envPath("KIXDNS_DHCP_LEASES", "/tmp/dhcp.leases"),
		envPath("KIXDNS_HOSTS", "/etc/hosts"),
		envPath("KIXDNS_ODHCPD", "/tmp/hosts/odhcpd"),
	}
}

func hourKeys(now int64) ([]string, error) {
	// ponytail: one tiny strftime subprocess preserves OpenWrt's POSIX TZ/DST
	// semantics without reimplementing libc TZ parsing. No log data goes to awk.
	out, err := exec.Command("awk", "-v", "now="+strconv.FormatInt(now, 10),
		`BEGIN { for (i = 23; i >= 0; i--) print strftime("%Y-%m-%dT%H", now - i * 3600) }`).Output()
	if err != nil {
		return nil, fmt.Errorf("hour window: %w", err)
	}
	keys := strings.Fields(string(out))
	if len(keys) != 24 {
		return nil, errors.New("system awk must support strftime (expected 24 hours)")
	}
	for _, key := range keys {
		if len(key) != 13 || !hourPattern.MatchString(key) {
			return nil, errors.New("invalid system hour window")
		}
	}
	return keys, nil
}

func newCounters(hours []string) *counters {
	c := &counters{make(map[metric]int64), make(map[string]bool), make(map[[2]string]int)}
	for _, h := range hours {
		c.keep[h] = true
	}
	return c
}

func (c *counters) bump(kind, h, name string, n int64) {
	if !c.keep[h] {
		return
	}
	key := metric{kind, h, name}
	switch kind {
	case "qname", "client", "upstream", "pipeline", "qtype", "rcode":
		if _, exists := c.values[key]; !exists {
			bucket := [2]string{kind, h}
			// Match the existing 100-key/hour ceiling; totals remain unbounded.
			if c.distinct[bucket] >= 100 {
				c.bump("limit", h, "-", n)
				return
			}
			c.distinct[bucket]++
		}
	}
	c.values[key] += n
}

func scan(r io.Reader, completeOnly bool, visit func(string) error) error {
	s := bufio.NewScanner(r)
	// ponytail: 1 MiB/record; raise only for legitimate larger log lines.
	// Fail explicitly on oversized records; never silently lose counts.
	s.Buffer(make([]byte, 4096), 1024*1024)
	s.Split(func(data []byte, atEOF bool) (int, []byte, error) {
		if n := bytes.IndexByte(data, '\n'); n >= 0 {
			return n + 1, data[:n], nil
		}
		if atEOF {
			if !completeOnly && len(data) != 0 {
				return len(data), data, nil
			}
			return len(data), nil, nil
		}
		return 0, nil, nil
	})
	for s.Scan() {
		if err := visit(s.Text()); err != nil {
			return err
		}
	}
	return s.Err()
}

func (c *counters) load(r io.Reader) (cursor, error) {
	var cur cursor
	err := scan(r, false, func(line string) error {
		f := strings.Split(line, "\t")
		if len(f) >= 4 && f[0] == "cursor" {
			n, err := strconv.ParseInt(f[2], 10, 64)
			if err != nil || n < 0 || len(f[2]) > 11 {
				return errors.New("invalid cursor offset")
			}
			id := f[1][strings.LastIndex(f[1], ":")+1:]
			cur = cursor{id, f[3], n}
		} else if len(f) == 4 && c.keep[f[1]] {
			n, err := strconv.ParseUint(f[3], 10, 63)
			if err == nil {
				c.bump(f[0], f[1], f[2], int64(n))
			}
		}
		return nil
	})
	return cur, err
}

func fields(line string) map[string]string {
	out := make(map[string]string)
	for {
		m := fieldPattern.FindStringSubmatchIndex(line)
		if m == nil {
			return out
		}
		key, value := line[m[4]:m[5]], line[m[6]:m[7]]
		line = line[m[1]:]
		if strings.HasPrefix(value, `"`) {
			value = value[1 : len(value)-1]
		}
		if !strings.ContainsFunc(value, func(r rune) bool { return r < 32 || r == 127 }) {
			out[key] = value
		}
	}
}

func (c *counters) ingest(log *os.File, cur cursor) error {
	_, err := c.advance(log, cur, nil)
	return err
}

func fingerprint(log *os.File, offset int64, legacy bool) (string, error) {
	if offset == 0 {
		return "none", nil
	}
	start := max(int64(0), offset-128)
	boundary := make([]byte, offset-start)
	if _, err := log.ReadAt(boundary, start); err != nil {
		return "", err
	}
	if !legacy {
		return fmt.Sprintf("%x:-", md5.Sum(boundary)), nil
	}
	// POSIX cksum: non-reflected IEEE CRC, zero initial register, appended length.
	// Reverse the input/output bits to reuse the standard library's reflected CRC.
	n := len(boundary)
	for length := n; length != 0; length >>= 8 {
		boundary = append(boundary, byte(length))
	}
	for i := range boundary {
		boundary[i] = bits.Reverse8(boundary[i])
	}
	crc := bits.Reverse32(crc32.Update(^uint32(0), crc32.IEEETable, boundary))
	return fmt.Sprintf("%d:%d", crc, n), nil
}

func (c *counters) advance(log *os.File, cur cursor, visit func(string, string, map[string]string) error) (cursor, error) {
	info, err := log.Stat()
	if err != nil {
		return cur, err
	}
	if !info.Mode().IsRegular() {
		return cur, errors.New("log must be a regular file")
	}
	id := strconv.FormatUint(uint64(info.Sys().(*syscall.Stat_t).Ino), 10)
	offset := cur.offset
	if id != cur.id || info.Size() < offset {
		offset = 0
	} else if offset > 0 {
		mark, err := fingerprint(log, offset, !strings.HasSuffix(cur.mark, ":-"))
		if err != nil {
			return cur, err
		}
		if mark != cur.mark {
			offset = 0
		}
	}
	next := cursor{id: id, offset: offset}
	// ReadAt/SectionReader seeks directly; neither fingerprints nor append reads
	// scan bytes before the cursor. Ignore an unterminated final record.
	err = scan(io.NewSectionReader(log, offset, info.Size()-offset), true, func(line string) error {
		next.offset += int64(len(line) + 1)
		line = colorPattern.ReplaceAllString(line, "")
		h := strings.Replace(hourPattern.FindString(line), " ", "T", 1)
		if !c.keep[h] || !strings.Contains(line, "dns_response") {
			return nil
		}
		f := fields(line)
		name := strings.TrimSuffix(strings.ToLower(f["qname"]), ".")
		if f["event"] != "dns_response" || name == "" {
			return nil
		}
		c.bump("q", h, "-", 1)
		if f["cache"] == "true" {
			c.bump("cache", h, "-", 1)
		}
		if rc := f["rcode"]; rc != "" && rc != "NoError" {
			c.bump("err", h, "-", 1)
		}
		if visit != nil {
			return visit(h, name, f)
		}
		c.bump("qname", h, name, 1)
		for _, pair := range [][2]string{{"client", "client_ip"}, {"upstream", "upstream"}, {"pipeline", "pipeline"}, {"qtype", "qtype"}, {"rcode", "rcode"}} {
			if value := f[pair[1]]; value != "" {
				c.bump(pair[0], h, value, 1)
			}
		}
		return nil
	})
	if err != nil {
		return cur, err
	}
	next.mark, err = fingerprint(log, next.offset, false)
	return next, err
}

func openState(p paths, name string) (*os.File, error) {
	f, err := os.Open(filepath.Join(p.state, name))
	if errors.Is(err, os.ErrNotExist) {
		return os.Open(filepath.Join(p.persist, name))
	}
	return f, err
}

func readClasses(r io.Reader) (map[string]classification, int, error) {
	classes := make(map[string]classification)
	cached := 0
	err := scan(r, false, func(line string) error {
		f := strings.Split(line, "\t")
		if len(f) >= 2 && f[0] != "" {
			var confidence float64
			if len(f) >= 3 {
				confidence, _ = strconv.ParseFloat(f[2], 64)
			}
			classes[f[0]] = classification{f[1], confidence}
			cached++
		}
		return nil
	})
	return classes, cached, err
}

func resolve(q string, classes map[string]classification) (classification, bool) {
	if !strings.Contains(q, ".") {
		return classification{"lan", 1}, true
	}
	for _, suffix := range []string{".lan", ".local", ".home", ".internal", ".intranet", ".localdomain", ".arpa"} {
		if strings.HasSuffix(q, suffix) {
			return classification{"lan", 1}, true
		}
	}
	for {
		if item, ok := classes[q]; ok {
			return item, true
		}
		_, q, _ = strings.Cut(q, ".")
		if !strings.Contains(q, ".") {
			return classification{}, false
		}
	}
}

func readHosts(p paths) (map[string]string, error) {
	hosts := make(map[string]string)
	for i, name := range []string{p.leases, p.odhcp, p.hosts} {
		f, err := os.Open(name)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		err = scan(f, false, func(line string) error {
			v := strings.Fields(line)
			var ip, host string
			if i == 0 && len(v) >= 4 && v[3] != "*" {
				ip, host = v[2], v[3]
			} else if i != 0 && len(v) >= 2 && hostPattern.MatchString(v[0]) && v[1] != "localhost" && !strings.HasPrefix(v[1], "ip6-") {
				ip, host = v[0], v[1]
			}
			if ip != "" && hosts[ip] == "" {
				hosts[ip] = host
			}
			return nil
		})
		f.Close()
		if err != nil {
			return nil, err
		}
	}
	return hosts, nil
}

func ranked(values map[string]int64) [][]any {
	keys := make([]string, 0, len(values))
	for key := range values {
		if key != "" {
			keys = append(keys, key)
		}
	}
	sort.Slice(keys, func(i, j int) bool {
		a, b := keys[i], keys[j]
		return values[a] > values[b] || (values[a] == values[b] && a < b)
	})
	rows := make([][]any, 0, min(20, len(keys)))
	for _, key := range keys[:min(20, len(keys))] {
		rows = append(rows, []any{key, values[key]})
	}
	return rows
}

func (c *counters) render(hours []string, classes map[string]classification, cached int, hosts map[string]string, enabled bool) snapshot {
	s := snapshot{Until: hours[len(hours)-1], Cats: make(map[string]int64), Classify: classificationStatus{Enabled: enabled, Cached: cached}}
	totals := make(map[string]map[string]int64)
	qh := make(map[string]int64)
	for k, n := range c.values {
		switch k.kind {
		case "q":
			s.Queries += n
			qh[k.hour] += n
		case "cache":
			s.CacheHits += n
		case "err":
			s.Errors += n
		case "limit":
			s.Limited = true
		default:
			if totals[k.kind] == nil {
				totals[k.kind] = make(map[string]int64)
			}
			totals[k.kind][k.name] += n
		}
	}
	for _, kind := range []string{"qname", "client", "upstream", "pipeline", "qtype", "rcode"} {
		if totals[kind] == nil {
			totals[kind] = make(map[string]int64)
		}
	}
	for _, h := range hours {
		s.Hours = append(s.Hours, hour{Time: h, Queries: qh[h]})
	}
	s.Unique = len(totals["qname"])
	for q, n := range totals["qname"] {
		if item, ok := resolve(q, classes); ok {
			s.Cats[item.category] += n
		} else {
			s.Cats["pending"] += n
			s.Classify.Pending++
		}
	}
	s.TopQname = ranked(totals["qname"])
	for i, row := range s.TopQname {
		if item, ok := resolve(row[0].(string), classes); ok {
			confidence, _ := strconv.ParseFloat(fmt.Sprintf("%.4g", item.confidence), 64)
			s.TopQname[i] = append(row, item.category, confidence)
		}
	}
	s.TopClient = ranked(totals["client"])
	for i, row := range s.TopClient {
		if host, ok := hosts[row[0].(string)]; ok {
			s.TopClient[i] = append(row, host)
		}
	}
	s.TopUpstream, s.TopPipeline = ranked(totals["upstream"]), ranked(totals["pipeline"])
	s.Qtype, s.Rcode = totals["qtype"], totals["rcode"]
	return s
}

func collect(p paths, hours []string, enabled bool) (snapshot, error) {
	var empty snapshot
	if len(hours) != 24 {
		return empty, errors.New("expected 24 hour keys")
	}
	// Open the existing lock read-only. Do not bootstrap or mutate production state.
	lock, err := os.Open(filepath.Join(p.state, "state.lock"))
	if err != nil {
		return empty, fmt.Errorf("open existing state lock (run installed snapshot first): %w", err)
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_SH); err != nil {
		return empty, err
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)

	c := newCounters(hours)
	var cur cursor
	f, err := openState(p, "stats.tsv")
	if err == nil {
		cur, err = c.load(f)
		f.Close()
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return empty, err
	}
	log, err := os.Open(p.log)
	if err == nil {
		err = c.ingest(log, cur)
		log.Close()
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return empty, err
	}
	var classes map[string]classification
	cached := 0
	f, err = openState(p, "classify.tsv")
	if err == nil {
		classes, cached, err = readClasses(f)
		f.Close()
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return empty, err
	}
	hosts, err := readHosts(p)
	if err != nil {
		return empty, err
	}
	return c.render(hours, classes, cached, hosts, enabled), nil
}

func run() error {
	cmd := "snapshot"
	if len(os.Args) >= 2 {
		cmd = os.Args[1]
	}
	var filter queryFilter
	if cmd == "snapshot" && len(os.Args) == 3 {
		var err error
		filter, err = parseFilter(os.Args[2])
		if err != nil {
			return err
		}
	} else if cmd == "classify" {
		if len(os.Args) != 4 {
			return errors.New("classify requires transport path and domain (empty for batch)")
		}
	} else if cmd == "check" {
		if len(os.Args) != 3 {
			return errors.New("check requires transport path")
		}
	} else if len(os.Args) > 2 {
		return errors.New("unexpected command arguments")
	}
	if cmd != "snapshot" && cmd != "ingest" && cmd != "fold" && cmd != "clear" && cmd != "classify" && cmd != "check" {
		return errors.New("unknown statistics command")
	}
	if os.Getenv("KIXDNS_STATS_PROFILE") == "1" {
		defer reportMemory()
	}
	now := time.Now().Unix()
	if override := os.Getenv("KIXDNS_NOW"); override != "" {
		value, err := strconv.ParseInt(override, 10, 64)
		if err != nil || value < 0 {
			return errors.New("invalid KIXDNS_NOW")
		}
		now = value
	}
	hours, err := hourKeys(now)
	if err != nil {
		return err
	}
	if cmd == "classify" || cmd == "check" {
		domain := ""
		if cmd == "classify" {
			domain = os.Args[3]
		}
		result, err := classify(runtimePaths(), hours, os.Args[2], domain, cmd == "check")
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(result)
	}
	enabled := cmd == "snapshot" && classificationEnabled()
	s, err := updateFiltered(runtimePaths(), hours, enabled, cmd, filter)
	if err != nil {
		return err
	}
	if cmd == "snapshot" {
		return json.NewEncoder(os.Stdout).Encode(s)
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "kixdns-stats-core:", err)
		os.Exit(1)
	}
}
