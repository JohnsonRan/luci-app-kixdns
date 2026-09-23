//go:build linux

package main

import (
	"bytes"
	"math"
	"os"
	"path/filepath"
	"testing"
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
	if err = writeClassCache(p, entries); err != nil {
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
	if err = writeClassCache(p, entries); err != nil {
		t.Fatal(err)
	}
	after, _ = os.ReadFile(live)
	next, _ := os.Stat(live)
	if !bytes.Equal(before, after) || !info.ModTime().Equal(next.ModTime()) {
		t.Fatal("identical cache update rewrote database")
	}
	for _, bad := range []cachedClass{{"invalid", 1, "test"}, {"ads", -1, "test"}, {"ads", math.NaN(), "test"}} {
		err = writeClassCache(p, map[string]cachedClass{"first.example": {"cdn", 1, "test"}, "bad.example": bad})
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
}
