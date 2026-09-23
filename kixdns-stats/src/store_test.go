//go:build linux

package main

import (
	"bytes"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestStateLifecycle(t *testing.T) {
	t.Setenv("TZ", "UTC")
	root := t.TempDir()
	p := paths{root + "/log", root + "/state", root + "/persist", root + "/leases", root + "/hosts", root + "/odhcp"}
	hours, err := hourKeys(time.Now().Unix())
	if err != nil {
		t.Fatal(err)
	}
	line := hours[23] + ":01:02 event=dns_response qname=writer.example qtype=A rcode=NoError\n"
	if err := os.WriteFile(p.log, []byte(line+"partial"), 0600); err != nil {
		t.Fatal(err)
	}
	call := func(command string) snapshot {
		t.Helper()
		s, err := update(p, hours, false, command)
		if err != nil {
			t.Fatal(command, err)
		}
		return s
	}
	if got := call("snapshot"); got.Queries != 1 {
		t.Fatal(got.Queries)
	}
	live := filepath.Join(p.state, databaseName)
	before, _ := os.ReadFile(live)
	beforeInfo, _ := os.Stat(live)
	if got := call("snapshot"); got.Queries != 1 {
		t.Fatal("recounted partial record")
	}
	after, _ := os.ReadFile(live)
	afterInfo, _ := os.Stat(live)
	if !bytes.Equal(before, after) || !beforeInfo.ModTime().Equal(afterInfo.ModTime()) {
		t.Fatal("idle snapshot rewrote state")
	}
	call("fold")
	persisted := filepath.Join(p.persist, databaseName)
	checkpoint, _ := os.ReadFile(persisted)
	checkpointInfo, _ := os.Stat(persisted)
	call("fold")
	after, _ = os.ReadFile(persisted)
	afterInfo, _ = os.Stat(persisted)
	if !bytes.Equal(checkpoint, after) || !checkpointInfo.ModTime().Equal(afterInfo.ModTime()) {
		t.Fatal("unchanged checkpoint rewritten")
	}
	if err := os.RemoveAll(p.state); err != nil {
		t.Fatal(err)
	}
	if got := call("snapshot"); got.Queries != 1 {
		t.Fatal("restore lost cursor/counters")
	}
	call("clear")
	b, _ := os.ReadFile(p.log)
	if len(b) != 0 {
		t.Fatal("clear did not truncate")
	}
	if err := os.WriteFile(p.log, []byte(line+line), 0600); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			cmd := "snapshot"
			if i%2 == 0 {
				cmd = "fold"
			}
			if _, err := update(p, hours, false, cmd); err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	if got := call("snapshot"); got.Queries != 3 {
		t.Fatal("concurrent commands recounted or lost records:", got.Queries)
	}
	if err := os.RemoveAll(p.state); err != nil {
		t.Fatal(err)
	}
	if got := call("snapshot"); got.Queries != 3 {
		t.Fatal("restart after clear/append lost data")
	}
	oldPersist := p.persist
	p.persist = root + "/blocked"
	if err := os.WriteFile(p.persist, []byte("not a directory"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := update(p, hours, false, "clear"); err == nil {
		t.Fatal("clear must fail closed")
	}
	b, _ = os.ReadFile(p.log)
	if string(b) != line+line {
		t.Fatal("checkpoint failure erased source log")
	}
	p.persist = oldPersist
	call("clear")
	if _, err := os.Stat(filepath.Join(p.state, "stats.tsv")); !os.IsNotExist(err) {
		t.Fatal("runtime TSV mirror must not exist", err)
	}
}
