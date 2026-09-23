//go:build linux

package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"

	bolt "go.etcd.io/bbolt"
)

// The Go core owns selection, validation and persistence; the wrapper only posts HTTP.
var criteria = map[string]string{
	"ads": "Ad networks, ad CDNs, advertising measurement", "trackers": "Analytics, telemetry, fingerprinting",
	"malware": "Malware distribution or C2", "phishing": "Phishing or scam", "adult": "Pornography or adult",
	"social": "Social networks", "cdn": "Generic commercial CDN or static hosting, not residential",
	"pcdn":   "Commercial residential/P2P CDN that shares home uplink (Xunlei PCDN, video platform PCDN). Not BitTorrent.",
	"p2p":    "BitTorrent, DHT, magnet, generic P2P file sharing. Not commercial PCDN.",
	"gaming": "Game platforms, launchers, matchmaking", "cloud": "Cloud provider APIs (AWS, Azure, Aliyun, Tencent Cloud)",
	"captive": "Captive-portal or connectivity checks (detectportal, generate_204)",
	"ai":      "AI chat/API hosts (OpenAI, Gemini, Claude, and similar)", "update": "OS or application updates",
	"streaming": "Video or audio streaming services", "ok": "Ordinary content or unknown benign",
}

type cachedClass struct {
	Category   string  `json:"category"`
	Confidence float64 `json:"confidence"`
	Model      string  `json:"model,omitempty"`
}

func (c cachedClass) valid() bool {
	_, ok := criteria[c.Category]
	return (ok || c.Category == "lan") && !math.IsNaN(c.Confidence) && !math.IsInf(c.Confidence, 0) && c.Confidence >= 0 && c.Confidence <= 1 && len(c.Model) <= 256
}
func readClassCache(tx *bolt.Tx) (map[string]classification, error) {
	out := make(map[string]classification)
	err := tx.Bucket([]byte("classes")).ForEach(func(k, v []byte) error {
		var c cachedClass
		if err := json.Unmarshal(v, &c); err != nil {
			return err
		}
		if !validDomain(string(k)) || !c.valid() {
			return errors.New("invalid classification cache entry")
		}
		out[string(k)] = classification{c.Category, c.Confidence}
		return nil
	})
	return out, err
}
func (s *boltStore) putClasses(entries map[string]cachedClass) error {
	for q, c := range entries {
		if !validDomain(q) || !c.valid() {
			return errors.New("invalid classification")
		}
		data, err := json.Marshal(c)
		if err != nil {
			return err
		}
		if err = s.put("classes", []byte(q), data); err != nil {
			return err
		}
	}
	return nil
}
func (s *boltStore) importClasses(p paths) error {
	data, err := importFile(p, "classify.tsv")
	if err != nil {
		return err
	}
	entries := make(map[string]cachedClass)
	err = scan(bytes.NewReader(data), false, func(line string) error {
		f := strings.Split(line, "\t")
		if len(f) < 3 {
			return nil
		}
		q := strings.ToLower(strings.TrimSuffix(f[0], "."))
		confidence, e := strconv.ParseFloat(f[2], 64)
		if e != nil {
			return nil
		}
		c := cachedClass{Category: f[1], Confidence: confidence}
		if len(f) > 3 {
			c.Model = f[3]
		}
		if validDomain(q) && c.valid() {
			entries[q] = c
		}
		return nil
	})
	if err != nil {
		return err
	}
	return s.putClasses(entries)
}
func writeClassCache(p paths, hours []string, entries map[string]cachedClass) error {
	lock, err := lockState(p)
	if err != nil {
		return err
	}
	defer lock.Close()
	db, err := openDatabase(p)
	if err != nil {
		return err
	}
	defer db.Close()
	tx, err := db.Begin(true)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	s, err := initializeStore(tx, p, hours)
	if err != nil {
		return err
	}
	if err = s.putClasses(entries); err != nil {
		return err
	}
	if err = s.finish(); err != nil {
		return err
	}
	return nil // Same periodic checkpoint policy as all other database data.
}
func domainCounts(tx *bolt.Tx) (map[string]int64, error) {
	counts := make(map[string]int64)
	err := tx.Bucket([]byte("hourly")).ForEach(func(k, v []byte) error {
		_, f, err := jointFields(k)
		if err != nil {
			return err
		}
		n, err := unpack(v)
		if err != nil {
			return err
		}
		counts[f[1]] += n[0]
		return nil
	})
	return counts, err
}
func classificationState(p paths) (map[string]int64, map[string]classification, error) {
	lock, err := lockState(p)
	if err != nil {
		return nil, nil, err
	}
	defer lock.Close()
	db, err := connectBolt(filepath.Join(p.state, databaseName), true)
	if err != nil {
		return nil, nil, err
	}
	defer db.Close()
	var counts map[string]int64
	var classes map[string]classification
	err = db.View(func(tx *bolt.Tx) error {
		if e := validateDB(tx); e != nil {
			return e
		}
		var e error
		counts, e = domainCounts(tx)
		if e != nil {
			return e
		}
		classes, e = readClassCache(tx)
		return e
	})
	return counts, classes, err
}
func pendingDomains(counts map[string]int64, classes map[string]classification) []string {
	pending := make(map[string]bool)
	for q := range counts {
		if validDomain(q) {
			if _, ok := resolve(q, classes); !ok {
				pending[q] = true
			}
		}
	}
	out := make([]string, 0, len(pending))
	for q := range pending {
		parent := q
		covered := false
		for {
			_, parent, _ = strings.Cut(parent, ".")
			if !strings.Contains(parent, ".") {
				break
			}
			if pending[parent] {
				covered = true
				break
			}
		}
		if !covered {
			out = append(out, q)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if counts[out[i]] != counts[out[j]] {
			return counts[out[i]] > counts[out[j]]
		}
		return out[i] > out[j]
	})
	return out
}
func classificationEnabled() bool {
	if os.Getenv("KIXDNS_TYPESAFE_KEY") != "" {
		return true
	}
	key, _ := exec.Command("uci", "-q", "get", "kixdns.main.typesafe_api_key").Output()
	return len(bytes.TrimSpace(key)) != 0
}
func classifyError(reason string) map[string]any {
	return map[string]any{"error": reason, "did": 0, "pending": 0}
}
func classify(p paths, hours []string, transport, domain string, probe bool) (map[string]any, error) {
	if _, err := update(p, hours, false, "ingest"); err != nil {
		return nil, err
	}
	lock, err := os.OpenFile(filepath.Join(p.state, "classify.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	defer lock.Close()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return classifyError("busy"), nil
		}
		return nil, err
	}
	if !classificationEnabled() {
		return classifyError("no_key"), nil
	}
	if probe {
		domain = "example.com"
	}
	single := domain != ""
	domain = strings.ToLower(strings.TrimSuffix(domain, "."))
	if single && !validDomain(domain) {
		return classifyError("bad_qname"), nil
	}
	counts, classes, err := classificationState(p)
	if err != nil {
		return nil, err
	}
	var domains []string
	if single {
		if !probe && counts[domain] == 0 {
			return classifyError("not_in_stats"), nil
		}
		if c, ok := resolve(domain, nil); ok && c.category == "lan" {
			return map[string]any{"ok": true, "qname": domain, "cat": "lan", "conf": 1, "did": 0}, nil
		}
		domains = []string{domain}
	} else {
		domains = pendingDomains(counts, classes)
		batch := 16
		if n, e := strconv.Atoi(os.Getenv("KIXDNS_CLASSIFY_BATCH")); e == nil && n >= 0 && len(os.Getenv("KIXDNS_CLASSIFY_BATCH")) <= 3 {
			batch = max(1, min(32, n))
		}
		domains = domains[:min(batch, len(domains))]
		if len(domains) == 0 {
			return map[string]any{"ok": true, "did": 0, "pending": 0}, nil
		}
	}
	questions := make(map[string]any)
	var state any = map[string]any{"domains": domains}
	for i := range domains {
		key := fmt.Sprintf("d%d", i)
		instruction := fmt.Sprintf("Classify `domains[%d]` by typical client intent. Pick one.", i)
		if single {
			key = "cat"
			instruction = "Classify this DNS domain by typical client intent. Pick one."
			state = domain
		}
		questions[key] = map[string]any{"type": "choice", "instructions": instruction, "criteria": criteria}
	}
	data, err := json.Marshal(map[string]any{"state": state, "model": "jev-latest", "questions": questions})
	if err != nil {
		return nil, err
	}
	request, err := os.CreateTemp(p.state, "classify.req-")
	if err != nil {
		return nil, err
	}
	defer os.Remove(request.Name())
	if _, err = request.Write(data); err != nil {
		request.Close()
		return nil, err
	}
	if err = request.Close(); err != nil {
		return nil, err
	}
	body, err := os.CreateTemp(p.state, "classify.body-")
	if err != nil {
		return nil, err
	}
	defer os.Remove(body.Name())
	body.Close()
	// No state.lock, bbolt handle or transaction spans the network request.
	post := exec.Command("/bin/sh", transport, "_post", request.Name(), body.Name())
	post.Stderr = os.Stderr
	status, err := post.Output()
	code := strings.TrimSpace(string(status))
	if err != nil {
		code = "000"
	}
	if code == "no_key" {
		return classifyError("no_key"), nil
	}
	if code != "200" {
		if code != "bad_key" && (len(code) != 3 || strings.ContainsFunc(code, func(r rune) bool { return r < '0' || r > '9' })) {
			code = "000"
		}
		return classifyError("http_" + code), nil
	}
	f, err := os.Open(body.Name())
	if err != nil {
		return nil, err
	}
	response, err := io.ReadAll(io.LimitReader(f, 131073))
	f.Close()
	if err != nil {
		return nil, err
	}
	if len(response) > 131072 {
		return classifyError("bad_response"), nil
	}
	var decoded struct {
		Answers map[string]json.RawMessage `json:"answers"`
	}
	if err = json.Unmarshal(response, &decoded); err != nil {
		return classifyError("bad_response"), nil
	}
	hits := make(map[string]cachedClass)
	for i, q := range domains {
		key := fmt.Sprintf("d%d", i)
		if single {
			key = "cat"
		}
		var answer struct {
			Choice     string   `json:"choice"`
			Confidence *float64 `json:"confidence"`
		}
		if json.Unmarshal(decoded.Answers[key], &answer) != nil || answer.Confidence == nil {
			continue
		}
		if _, ok := criteria[answer.Choice]; !ok {
			continue
		}
		c := cachedClass{answer.Choice, *answer.Confidence, "jev-latest"}
		if c.valid() {
			hits[q] = c
		}
	}
	if len(hits) == 0 {
		return classifyError("bad_response"), nil
	}
	if !probe {
		if err = writeClassCache(p, hours, hits); err != nil {
			return nil, err
		}
	}
	if single {
		c := hits[domain]
		return map[string]any{"ok": true, "qname": domain, "cat": c.Category, "conf": c.Confidence, "did": 1}, nil
	}
	counts, classes, err = classificationState(p)
	if err != nil {
		return nil, err
	}
	pending := len(pendingDomains(counts, classes))
	return map[string]any{"ok": true, "did": len(hits), "pending": pending}, nil
}
