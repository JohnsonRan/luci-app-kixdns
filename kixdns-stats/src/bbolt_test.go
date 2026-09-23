//go:build linux

package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"time"

	bolt "go.etcd.io/bbolt"
)

func jointFixture(t *testing.T) (paths, []string) {
	t.Helper()
	t.Setenv("TZ", "UTC")
	root := t.TempDir()
	p := paths{root + "/log", root + "/state", root + "/persist", root + "/leases", root + "/hosts", root + "/odhcp"}
	hours, err := hourKeys(time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC).Unix())
	if err != nil {
		t.Fatal(err)
	}
	if err = privateDir(p.state); err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string]string{
		p.leases: "0 aa:bb:cc:dd:ee:ff 192.0.2.1 Laptop *\n0 aa:bb:cc:dd:ee:01 192.0.2.2 Phone *\n",
		p.log: strings.Repeat(jointLine(hours[22], "ads.example", "192.0.2.1", "A", "NoError", true, "dnsA", "p1"), 2) +
			jointLine(hours[23], "api.ads.example", "192.0.2.1", "AAAA", "ServFail", false, "dnsB", "p2") +
			strings.Repeat(jointLine(hours[23], "safe.example", "192.0.2.2", "A", "NoError", true, "dnsA", "p1"), 3) +
			jointLine(hours[23], "printer.lan", "192.0.2.1", "A", "NoError", false, "dnsB", "p2"),
	} {
		if err = os.WriteFile(name, []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := writeClassCache(p, map[string]cachedClass{
		"ads.example":  {"ads", .9, "model"},
		"safe.example": {"ok", 1, "model"},
		"printer.lan":  {"malware", 1, "stale"},
	}); err != nil {
		t.Fatal(err)
	}
	return p, hours
}
func jointLine(h, domain, client, qtype, rcode string, hit bool, up, pipe string) string {
	return fmt.Sprintf("%s:01:02 event=dns_response qname=%s client_ip=%s qtype=%s rcode=%s cache=%t upstream=%s pipeline=%s\n", h, domain, client, qtype, rcode, hit, up, pipe)
}
func jointCall(t *testing.T, p paths, hours []string, cmd string, q queryFilter) snapshot {
	t.Helper()
	s, err := updateFiltered(p, hours, true, cmd, q)
	if err != nil {
		t.Fatal(cmd, err)
	}
	return s
}
func appendJoint(t *testing.T, p paths, text string) {
	t.Helper()
	f, err := os.OpenFile(p.log, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.WriteString(text); err != nil {
		t.Fatal(err)
	}
	if err = f.Close(); err != nil {
		t.Fatal(err)
	}
}
func TestLinkedStatistics(t *testing.T) {
	p, hours := jointFixture(t)
	cases := []struct {
		name                                 string
		q                                    queryFilter
		total, hits, errs, previous, current int64
		unique                               int
	}{
		{"all", queryFilter{}, 7, 5, 1, 2, 5, 4},
		{"client IP", queryFilter{Client: "192.0.2.1"}, 4, 2, 1, 2, 2, 3},
		{"hostname", queryFilter{Client: "laptop"}, 4, 2, 1, 2, 2, 3},
		{"keyword", queryFilter{Domain: "safe"}, 3, 3, 0, 0, 3, 1},
		{"category", queryFilter{Category: "ads"}, 3, 2, 1, 2, 1, 2},
		{"combined", queryFilter{Client: "laptop", Domain: "ads", Category: "ads"}, 3, 2, 1, 2, 1, 2},
		{"intranet", queryFilter{Category: "lan"}, 1, 0, 0, 0, 1, 1},
		{"no match", queryFilter{Client: "missing"}, 0, 0, 0, 0, 0, 0},
		{"literal punctuation", queryFilter{Domain: "' OR 1=1 --"}, 0, 0, 0, 0, 0, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := jointCall(t, p, hours, "snapshot", tc.q)
			if s.Queries != tc.total || s.CacheHits != tc.hits || s.Errors != tc.errs || s.Unique != tc.unique {
				t.Fatalf("wrong summary: %+v", s)
			}
			if s.Hours[22].Queries != tc.previous || s.Hours[23].Queries != tc.current || s.Partial || s.Totals.Queries != 7 {
				t.Fatal("hours/coverage", s)
			}
			var sum int64
			for _, h := range s.Hours {
				sum += h.Queries
				if h.Partial {
					t.Fatal("invented gap")
				}
			}
			if sum != tc.total {
				t.Fatal("curve")
			}
			for _, m := range []map[string]int64{s.Qtype, s.Rcode, s.Cats} {
				sum = 0
				for _, n := range m {
					sum += n
				}
				if sum != tc.total {
					t.Fatal("group total", m)
				}
			}
			for _, rows := range [][][]any{s.TopQname, s.TopClient, s.TopUpstream, s.TopPipeline} {
				sum = 0
				for _, r := range rows {
					sum += r[1].(int64)
				}
				if sum != tc.total {
					t.Fatal("ranking total", rows)
				}
			}
			if tc.name == "combined" {
				if !reflect.DeepEqual(s.TopQname, [][]any{{"ads.example", int64(2), "ads", 0.9}, {"api.ads.example", int64(1), "ads", 0.9}}) {
					t.Fatal(s.TopQname)
				}
				if !reflect.DeepEqual(s.TopClient, [][]any{{"192.0.2.1", int64(3), "Laptop"}}) {
					t.Fatal(s.TopClient)
				}
				if !reflect.DeepEqual(s.Qtype, map[string]int64{"A": 2, "AAAA": 1}) || !reflect.DeepEqual(s.Rcode, map[string]int64{"NoError": 2, "ServFail": 1}) {
					t.Fatal(s)
				}
				if !reflect.DeepEqual(s.TopUpstream, [][]any{{"dnsA", int64(2)}, {"dnsB", int64(1)}}) || !reflect.DeepEqual(s.TopPipeline, [][]any{{"p1", int64(2)}, {"p2", int64(1)}}) {
					t.Fatal(s)
				}
			}
		})
	}
	db, err := connectBolt(filepath.Join(p.state, databaseName), true)
	if err != nil {
		t.Fatal(err)
	}
	err = db.View(func(tx *bolt.Tx) error {
		if n := tx.Bucket([]byte("hourly")).Stats().KeyN; n != 4 {
			t.Fatalf("seven requests must form four rows: %d", n)
		}
		return nil
	})
	db.Close()
	if err != nil {
		t.Fatal(err)
	}
	if err := writeClassCache(p, map[string]cachedClass{"ads.example": {"cdn", 1, "new"}, "safe.example": {"ok", 1, "new"}}); err != nil {
		t.Fatal(err)
	}
	for cat, want := range map[string]int64{"ads": 0, "cdn": 3, "lan": 1} {
		if s := jointCall(t, p, hours, "snapshot", queryFilter{Category: cat}); s.Queries != want {
			t.Fatal("fresh parent/LAN category", cat, s)
		}
	}
	appendJoint(t, p, jointLine(hours[23], "safe.example", "192.0.2.10", "A", "NoError", false, "dnsA", "p1"))
	for client, want := range map[string]int64{"192.0.2.1": 4, "192.0.2.10": 1, "192.0.2.": 8, "laptop": 4} {
		if s := jointCall(t, p, hours, "snapshot", queryFilter{Client: client}); s.Queries != want {
			t.Fatal(client, s.Queries, want)
		}
	}
}
func TestCheckpointAndRecovery(t *testing.T) {
	p, hours := jointFixture(t)
	s := jointCall(t, p, hours, "snapshot", queryFilter{Domain: "example"})
	if s.Queries != 6 || s.Totals.Queries != 7 || s.Partial {
		t.Fatal("initial counters", s)
	}
	jointCall(t, p, hours, "fold", queryFilter{})
	saved := filepath.Join(p.persist, databaseName)
	before, _ := os.ReadFile(saved)
	st, _ := os.Stat(saved)
	jointCall(t, p, hours, "fold", queryFilter{})
	after, _ := os.ReadFile(saved)
	ast, _ := os.Stat(saved)
	if !bytes.Equal(before, after) || !st.ModTime().Equal(ast.ModTime()) {
		t.Fatal("idle checkpoint writes")
	}
	os.RemoveAll(p.state)
	if s = jointCall(t, p, hours, "snapshot", queryFilter{Domain: "example"}); s.Queries != 6 || s.Partial {
		t.Fatal("lost checkpoint", s)
	}
	jointCall(t, p, hours, "clear", queryFilter{})
	log, _ := os.ReadFile(p.log)
	if len(log) != 0 {
		t.Fatal("clear")
	}
	appendJoint(t, p, jointLine(hours[23], "new.example", "192.0.2.1", "A", "NoError", false, "dnsA", "p1"))
	s = jointCall(t, p, hours, "snapshot", queryFilter{})
	if s.Queries != 8 || s.Totals.Queries != 8 {
		t.Fatal("clear lost totals", s)
	}
	os.RemoveAll(p.state)
	for i := 0; i < 2; i++ {
		if s = jointCall(t, p, hours, "snapshot", queryFilter{}); s.Queries != 8 || s.Totals.Queries != 8 {
			t.Fatal("restart replay/loss", s)
		}
	}
}
func TestRollbackAndCapacity(t *testing.T) {
	p, hours := jointFixture(t)
	jointCall(t, p, hours, "snapshot", queryFilter{})
	name := filepath.Join(p.state, databaseName)
	before, _ := os.ReadFile(name)
	log, _ := os.ReadFile(p.log)
	appendJoint(t, p, jointLine(hours[23], "good.example", "192.0.2.1", "A", "NoError", false, "dnsA", "p1")+strings.Repeat("x", 1<<20)+"\n")
	if _, err := update(p, hours, false, "snapshot"); err == nil {
		t.Fatal("oversized record must abort after the earlier valid record")
	}
	after, _ := os.ReadFile(name)
	if !bytes.Equal(before, after) {
		t.Fatal("failed ingestion committed counts/cursor")
	}
	os.WriteFile(p.log, log, 0600)
	appendJoint(t, p, jointLine(hours[23], "good.example", "192.0.2.1", "A", "NoError", false, "dnsA", "p1"))
	if s := jointCall(t, p, hours, "snapshot", queryFilter{}); s.Queries != 8 {
		t.Fatal("retry lost/replayed", s)
	}
	// Overlong association fields still contribute to complete totals.
	appendJoint(t, p, jointLine(hours[23], "oversize.example", "192.0.2.1", "A", "NoError", false, strings.Repeat("x", 4097), "p1"))
	s := jointCall(t, p, hours, "snapshot", queryFilter{})
	if s.Queries != 8 || s.Totals.Queries != 9 || s.Coverage.Hours[23].Unsupported != 1 {
		t.Fatal("unsupported field", s)
	}
	db, err := connectBolt(name, false)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := db.Begin(true)
	if err != nil {
		t.Fatal(err)
	}
	store, err := initializeStore(tx)
	if err != nil {
		t.Fatal(err)
	}
	if err = store.pruneCapacity(store.jointBytes - 1); err != nil {
		t.Fatal(err)
	}
	if err = store.finish(); err != nil {
		t.Fatal(err)
	}
	db.Close()
	s = jointCall(t, p, hours, "snapshot", queryFilter{})
	if s.Queries != 6 || s.Totals.Queries != 9 || !s.Partial || s.Coverage.Hours[22].Capacity != 2 || !s.Hours[22].Partial || s.Hours[22].Queries != 0 {
		t.Fatal("oldest eviction", s)
	}
	// Expiry prunes multiple adjacent keys (a cursor-delete regression risk).
	next, err := hourKeys(time.Date(2026, 9, 23, 12, 0, 0, 0, time.UTC).Unix())
	if err != nil {
		t.Fatal(err)
	}
	if s = jointCall(t, p, next, "snapshot", queryFilter{}); s.Queries != 0 || s.Totals.Queries != 0 || s.Partial {
		t.Fatal("expiry", s)
	}
	os.MkdirAll(filepath.Join(p.persist, databaseName), 0700)
	before, _ = os.ReadFile(p.log)
	if _, err = update(p, next, false, "clear"); err == nil {
		t.Fatal("checkpoint failure swallowed")
	}
	after, _ = os.ReadFile(p.log)
	if !bytes.Equal(before, after) {
		t.Fatal("failed checkpoint erased source log")
	}
}
func TestIncrementalCheckpoint(t *testing.T) {
	p, hours := jointFixture(t)
	jointCall(t, p, hours, "fold", queryFilter{})
	path := filepath.Join(p.persist, databaseName)
	old, _ := os.ReadFile(path)
	info, _ := os.Stat(path)
	appendJoint(t, p, jointLine(hours[23], "safe.example", "192.0.2.2", "A", "NoError", true, "dnsA", "p1"))
	jointCall(t, p, hours, "snapshot", queryFilter{})
	if err := writeClassCache(p, map[string]cachedClass{"extra.example": {"cdn", 1, "test"}}); err != nil {
		t.Fatal(err)
	}
	live, err := connectBolt(filepath.Join(p.state, databaseName), false)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := live.Begin(true)
	if err != nil {
		t.Fatal(err)
	}
	store, err := initializeStore(tx)
	if err != nil {
		t.Fatal(err)
	}
	if err = store.pruneCapacity(store.jointBytes - 1); err != nil {
		t.Fatal(err)
	}
	if err = store.finish(); err != nil {
		t.Fatal(err)
	}
	saved, err := connectBolt(path, false)
	if err != nil {
		t.Fatal(err)
	}
	failure := errors.New("abort after final metadata update")
	err = live.View(func(src *bolt.Tx) error {
		return saved.Update(func(dst *bolt.Tx) error {
			if e := checkpointChanges(src, dst); e != nil {
				return e
			}
			if meta(src, "cursor_offset") != meta(dst, "cursor_offset") || meta(src, "revision") != meta(dst, "revision") {
				t.Fatal("metadata not staged")
			}
			return failure
		})
	})
	saved.Close()
	live.Close()
	if !errors.Is(err, failure) {
		t.Fatal(err)
	}
	unchanged, _ := os.ReadFile(path)
	if !bytes.Equal(old, unchanged) {
		t.Fatal("late failure persisted partial counts/cursor/gaps/deletions")
	}
	jointCall(t, p, hours, "fold", queryFilter{})
	afterInfo, _ := os.Stat(path)
	if info.Sys().(*syscall.Stat_t).Ino != afterInfo.Sys().(*syscall.Stat_t).Ino {
		t.Fatal("normal checkpoint replaced the whole file")
	}
	os.RemoveAll(p.state)
	s := jointCall(t, p, hours, "snapshot", queryFilter{})
	if s.Queries != 6 || s.Totals.Queries != 8 || s.Coverage.Hours[22].Capacity != 2 || s.Classify.Cached != 4 {
		t.Fatal("deletions/gaps/cursor lost on restore", s)
	}
	if s = jointCall(t, p, hours, "snapshot", queryFilter{Category: "ok"}); s.Queries != 4 || s.CacheHits != 4 {
		t.Fatal("changed existing aggregate lost", s)
	}
}
func TestCrashRecovery(t *testing.T) {
	if name := os.Getenv("KIXDNS_CRASH_DB"); name != "" {
		db, err := connectBolt(name, false)
		if err != nil {
			panic(err)
		}
		tx, err := db.Begin(true)
		if err != nil {
			panic(err)
		}
		if err = tx.Bucket([]byte("meta")).Put([]byte("cursor_offset"), []byte("broken")); err != nil {
			panic(err)
		}
		if err = tx.Bucket([]byte("totals")).Put([]byte("invalid"), make([]byte, 1<<20)); err != nil {
			panic(err)
		}
		os.Exit(86) // Terminate with a dirty, uncommitted transaction; no Close/Rollback.
	}
	p, hours := jointFixture(t)
	jointCall(t, p, hours, "fold", queryFilter{})
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe, "-test.run=^TestCrashRecovery$")
	cmd.Env = append(os.Environ(), "KIXDNS_CRASH_DB="+filepath.Join(p.persist, databaseName))
	if err = cmd.Run(); err == nil || cmd.ProcessState.ExitCode() != 86 {
		t.Fatal("crash helper", err)
	}
	os.RemoveAll(p.state)
	if s := jointCall(t, p, hours, "snapshot", queryFilter{}); s.Queries != 7 || s.Totals.Queries != 7 || s.Partial {
		t.Fatal("restored uncommitted checkpoint", s)
	}
}
func TestFileCompaction(t *testing.T) {
	p, hours := jointFixture(t)
	jointCall(t, p, hours, "snapshot", queryFilter{})
	name := filepath.Join(p.state, databaseName)
	db, err := connectBolt(name, false)
	if err != nil {
		t.Fatal(err)
	}
	err = db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket([]byte("hourly")).Put([]byte("temporary-test-value"), make([]byte, 24<<20))
	})
	if err != nil {
		t.Fatal(err)
	}
	err = db.Update(func(tx *bolt.Tx) error { return tx.Bucket([]byte("hourly")).Delete([]byte("temporary-test-value")) })
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	before, _ := os.Stat(name)
	if before.Size() <= 2*jointBudget {
		t.Fatal("fixture did not leave a large empty file")
	}
	if s := jointCall(t, p, hours, "snapshot", queryFilter{}); s.Queries != 7 {
		t.Fatal("compaction lost data", s)
	}
	after, _ := os.Stat(name)
	if after.Size() >= before.Size()/2 {
		t.Fatal("free pages not reclaimed", before.Size(), after.Size())
	}
}
func TestFilterValidation(t *testing.T) {
	for _, text := range []string{`null`, `[]`, `{"command":"clear"}`, `{"client":true}`, `{"category":"ads|trackers"}`, `{"client":"\u0000"}`, `{} {}`, `{"domain":"` + strings.Repeat("x", 257) + `"}`} {
		if _, err := parseFilter(text); err == nil {
			t.Fatal("invalid filter", text)
		}
	}
	q, err := parseFilter(`{"client":" LAPTOP ","domain":"ADS","category":"ADS"}`)
	if err != nil || q != (queryFilter{Client: "laptop", Domain: "ads", Category: "ads"}) {
		t.Fatal(q, err)
	}
}
