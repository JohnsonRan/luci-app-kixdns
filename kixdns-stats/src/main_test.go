//go:build linux

package main

import (
	"os"
	"strings"
	"testing"
	"time"
)

func TestGuardsAndSystemTimezone(t *testing.T) {
	t.Setenv("TZ", "EST5EDT,M3.2.0,M11.1.0")
	now := time.Date(2026, 11, 1, 7, 15, 0, 0, time.UTC).Unix()
	hours, err := hourKeys(now)
	if err != nil {
		t.Fatal(err)
	}
	if hours[23] != "2026-11-01T02" || hours[22] != hours[21] {
		t.Fatalf("lost system POSIX TZ / DST semantics: %v", hours)
	}
	if err := scan(strings.NewReader(strings.Repeat("x", 1024*1024+1)+"\n"), true, func(string) error { return nil }); err == nil {
		t.Fatal("oversized record was silently accepted")
	}
	f, err := os.CreateTemp(t.TempDir(), "log")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString("x\n"); err != nil {
		t.Fatal(err)
	}
	mark, err := fingerprint(f, 2)
	if err != nil || len(mark) != 34 || !strings.HasSuffix(mark, ":-") {
		t.Fatal("invalid cursor fingerprint", mark, err)
	}
}
