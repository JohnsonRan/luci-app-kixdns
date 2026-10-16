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

func TestDSTFallbackHourDeduplication(t *testing.T) {
	t.Setenv("TZ", "EST5EDT,M3.2.0,M11.1.0")
	now := time.Date(2026, 11, 1, 7, 15, 0, 0, time.UTC).Unix()
	hours, err := hourKeys(now)
	if err != nil {
		t.Fatal(err)
	}
	if hours[22] != hours[21] {
		t.Fatalf("expected duplicate local hour across DST fallback: %v", hours)
	}

	c := newCounters(hours)
	for _, h := range hours {
		c.bump("q", h, "-", 1)
	}
	snap := c.render(hours, nil, 0, nil, false)
	var barSum int64
	for _, h := range snap.Hours {
		barSum += h.Queries
	}
	if barSum != snap.Queries {
		t.Fatalf("bar sum %d does not match total queries %d (hours count: %d)", barSum, snap.Queries, len(snap.Hours))
	}
	if len(snap.Hours) != 23 {
		t.Fatalf("expected 23 distinct hours across DST fallback, got %d", len(snap.Hours))
	}

	root := t.TempDir()
	p := paths{root + "/log", root + "/state", root + "/persist", root + "/leases", root + "/hosts", root + "/odhcp"}
	if err = privateDir(p.state); err != nil {
		t.Fatal(err)
	}
	var logContent strings.Builder
	for _, h := range hours {
		logContent.WriteString(jointLine(h, "safe.example", "192.0.2.1", "A", "NoError", true, "dnsA", "p1"))
	}
	if err = os.WriteFile(p.log, []byte(logContent.String()), 0600); err != nil {
		t.Fatal(err)
	}
	s, err := updateFiltered(p, hours, false, "snapshot", queryFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Hours) != 23 || len(s.Coverage.Hours) != 23 {
		t.Fatalf("expected 23 hours in snapshot and coverage, got %d and %d", len(s.Hours), len(s.Coverage.Hours))
	}
	barSum = 0
	for _, h := range s.Hours {
		barSum += h.Queries
	}
	if barSum != s.Queries {
		t.Fatalf("snapshot bar sum %d does not match queries %d", barSum, s.Queries)
	}
	var storedSum int64
	for _, h := range s.Coverage.Hours {
		storedSum += h.Stored
	}
	if storedSum != s.Totals.Queries {
		t.Fatalf("coverage stored sum %d does not match totals.queries %d", storedSum, s.Totals.Queries)
	}
}

