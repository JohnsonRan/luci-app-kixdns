//go:build linux

package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	bolt "go.etcd.io/bbolt"
)

func TestCacheHitLogContract(t *testing.T) {
	p, hours := jointFixture(t)
	forward := strings.TrimSuffix(jointLine(hours[23], "forward.example", "192.0.2.1", "A", "NoError", false, "dnsA", "p1"), "\n") + " cache=true\n"
	hit := strings.TrimSuffix(jointLine(hours[23], "hit.example", "192.0.2.1", "A", "NoError", true, "dnsA", "p1"), "\n") + " cache=false\n"
	cancelled := hours[23] + ":00:00 event=dns_request_finished qname=cancelled.example status=cancelled cache_hit=false\n"
	if err := os.WriteFile(p.log, []byte(forward+hit+cancelled), 0600); err != nil {
		t.Fatal(err)
	}
	s := jointCall(t, p, hours, "snapshot", queryFilter{})
	if s.Queries != 2 || s.CacheHits == nil || *s.CacheHits != 1 || s.Totals.CacheHits == nil || *s.Totals.CacheHits != 1 || s.LegacyLogs {
		t.Fatalf("cache_hit must override the ambiguous cache flag: %+v", s)
	}
	legacy := strings.Replace(jointLine(hours[22], "old.example", "192.0.2.1", "A", "NoError", true, "dnsA", "p1"), "cache_hit=true", "cache=true", 1)
	appendJoint(t, p, legacy)
	s = jointCall(t, p, hours, "snapshot", queryFilter{})
	if s.Queries != 3 || s.CacheHits != nil || s.Totals.CacheHits != nil || !s.LegacyLogs {
		t.Fatal("legacy logs must not produce a claimed hit rate", s)
	}
	encoded, err := json.Marshal(s)
	if err != nil || !bytes.Contains(encoded, []byte(`"cache_hits":null`)) {
		t.Fatal("unknown hit count must serialize as null, not zero", string(encoded), err)
	}
	known := jointCall(t, p, hours, "snapshot", queryFilter{Domain: "hit.example"})
	if known.Queries != 1 || known.CacheHits == nil || *known.CacheHits != 1 || known.Totals.CacheHits != nil {
		t.Fatal("a filter restricted to a verified hour keeps its valid hit count", known)
	}
	jointCall(t, p, hours, "fold", queryFilter{})
	if err := os.RemoveAll(p.state); err != nil {
		t.Fatal(err)
	}
	s = jointCall(t, p, hours, "snapshot", queryFilter{})
	if s.Queries != 3 || !s.LegacyLogs || s.CacheHits != nil {
		t.Fatal("quality flags and cursor must survive reboot", s)
	}
}

func TestMigrateLegacyHitCountsWithoutLosingHistory(t *testing.T) {
	p, hours := jointFixture(t)
	before := jointCall(t, p, hours, "snapshot", queryFilter{})
	jointCall(t, p, hours, "fold", queryFilter{})
	// Version 2 has the same buckets/count layout but no trustworthy hit semantics.
	db, err := connectBolt(filepath.Join(p.persist, databaseName), false)
	if err != nil {
		t.Fatal(err)
	}
	err = db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket([]byte("meta")).Put([]byte("version"), []byte("2"))
	})
	db.Close()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(p.state); err != nil {
		t.Fatal(err)
	}
	after := jointCall(t, p, hours, "snapshot", queryFilter{})
	if after.Queries != before.Queries || after.Unique != before.Unique || !reflect.DeepEqual(after.Cats, before.Cats) || after.Errors != before.Errors {
		t.Fatal("migration lost history or classifications", before, after)
	}
	if !after.LegacyLogs || after.CacheHits != nil || after.Totals.CacheHits != nil {
		t.Fatal("old database hit counts must remain unavailable", after)
	}
	jointCall(t, p, hours, "fold", queryFilter{})
	if err := os.RemoveAll(p.state); err != nil {
		t.Fatal(err)
	}
	if restored := jointCall(t, p, hours, "snapshot", queryFilter{}); restored.Queries != before.Queries || restored.CacheHits != nil {
		t.Fatal("checkpoint lost migration state or replayed old records", restored)
	}
	next, err := hourKeys(time.Date(2026, 9, 23, 12, 0, 0, 0, time.UTC).Unix())
	if err != nil {
		t.Fatal(err)
	}
	appendJoint(t, p, jointLine(next[23], "new.example", "192.0.2.1", "A", "NoError", false, "dnsA", "p1"))
	fresh := jointCall(t, p, next, "snapshot", queryFilter{})
	if fresh.Queries != 1 || fresh.CacheHits == nil || *fresh.CacheHits != 0 || fresh.LegacyLogs {
		t.Fatal("quality must recover when legacy hours expire", fresh)
	}
}
