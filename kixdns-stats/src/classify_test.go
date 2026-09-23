//go:build linux

package main

import (
	"bytes"
	"math"
	"os"
	"path/filepath"
	"testing"

	bolt "go.etcd.io/bbolt"
)

func TestUnifiedClassCache(t *testing.T) {
	p, hours := jointFixture(t)
	jointCall(t, p, hours, "fold", queryFilter{})
	saved := filepath.Join(p.persist, databaseName)
	original, err := os.ReadFile(saved)
	if err != nil {
		t.Fatal(err)
	}
	entries := map[string]cachedClass{"safe.example": {"gaming", .75, "test"}}
	if err = writeClassCache(p, hours, entries); err != nil {
		t.Fatal(err)
	}
	s := jointCall(t, p, hours, "snapshot", queryFilter{Category: "gaming"})
	if s.Queries != 3 || s.Totals.Queries != 7 {
		t.Fatal("classification did not refresh filters", s)
	}
	after, err := os.ReadFile(saved)
	if err != nil || !bytes.Equal(original, after) {
		t.Fatal("classification wrote flash outside checkpoint", err)
	}
	live := filepath.Join(p.state, databaseName)
	before, _ := os.ReadFile(live)
	info, _ := os.Stat(live)
	if err = writeClassCache(p, hours, entries); err != nil {
		t.Fatal(err)
	}
	after, _ = os.ReadFile(live)
	next, _ := os.Stat(live)
	if !bytes.Equal(before, after) || !info.ModTime().Equal(next.ModTime()) {
		t.Fatal("identical cache update rewrote database")
	}
	for _, bad := range []cachedClass{{"invalid", 1, "test"}, {"ads", -1, "test"}, {"ads", math.NaN(), "test"}} {
		err = writeClassCache(p, hours, map[string]cachedClass{"first.example": {"cdn", 1, "test"}, "bad.example": bad})
		if err == nil {
			t.Fatal("accepted invalid cache entry")
		}
		after, _ = os.ReadFile(live)
		if !bytes.Equal(before, after) {
			t.Fatal("cache transaction partially committed")
		}
	}
	jointCall(t, p, hours, "fold", queryFilter{})
	os.RemoveAll(p.state)
	if s = jointCall(t, p, hours, "snapshot", queryFilter{Category: "gaming"}); s.Queries != 3 || s.Totals.Queries != 7 {
		t.Fatal("unified checkpoint lost cache/counters/cursor", s)
	}
	// Legacy files, even if changed later, are not a second live source.
	os.WriteFile(filepath.Join(p.state, "classify.tsv"), []byte("safe.example\tmalware\t1\tignored\n"), 0600)
	if s = jointCall(t, p, hours, "snapshot", queryFilter{Category: "gaming"}); s.Queries != 3 {
		t.Fatal("read old TSV after migration")
	}
}
func TestOneTimeDatabaseAdoption(t *testing.T) {
	p, hours := jointFixture(t)
	jointCall(t, p, hours, "fold", queryFilter{})
	raw, err := os.ReadFile(filepath.Join(p.state, "classify.tsv"))
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(p.persist, "classify.tsv"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	// Construct only the previous data layout, not a second production backend.
	for _, dir := range []string{p.state, p.persist} {
		name := filepath.Join(dir, databaseName)
		db, e := connectBolt(name, false)
		if e != nil {
			t.Fatal(e)
		}
		e = db.Update(func(tx *bolt.Tx) error {
			if e := tx.DeleteBucket([]byte("classes")); e != nil {
				return e
			}
			return tx.Bucket([]byte("meta")).Put([]byte("version"), []byte("1"))
		})
		db.Close()
		if e != nil {
			t.Fatal(e)
		}
		if e = os.Rename(name, filepath.Join(dir, "stats.bolt")); e != nil {
			t.Fatal(e)
		}
	}
	s := jointCall(t, p, hours, "snapshot", queryFilter{Category: "ads"})
	if s.Queries != 3 || s.Totals.Queries != 7 {
		t.Fatal("one-time adoption lost data", s)
	}
	for _, dir := range []string{p.state, p.persist} {
		if _, err = os.Stat(filepath.Join(dir, "stats.bolt")); !os.IsNotExist(err) {
			t.Fatal("kept old filename alias", err)
		}
	}
	backup, err := os.ReadFile(filepath.Join(p.persist, "classify-import.tsv"))
	if err != nil || !bytes.Equal(backup, raw) {
		t.Fatal("original cache backup", err)
	}
	jointCall(t, p, hours, "fold", queryFilter{})
	os.WriteFile(filepath.Join(p.persist, "classify.tsv"), []byte("ads.example\tmalware\t1\tignored\n"), 0600)
	os.RemoveAll(p.state)
	if s = jointCall(t, p, hours, "snapshot", queryFilter{Category: "ads"}); s.Queries != 3 || s.Totals.Queries != 7 {
		t.Fatal("reimported old cache on restore", s)
	}
}
