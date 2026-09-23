//go:build linux

package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if os.Getenv("STATS_GO_TEST_HELPER") == "1" {
		main()
		return
	}
	os.Exit(m.Run())
}

func TestSnapshotMatchesShellAndDoesNotWrite(t *testing.T) {
	t.Setenv("TZ", "UTC")
	root := t.TempDir()
	p := paths{root + "/log", root + "/state", root + "/persist", root + "/leases", root + "/hosts", root + "/odhcp"}
	write := func(name, text string) {
		t.Helper()
		if err := os.WriteFile(name, []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
	}
	for _, dir := range []string{p.state, p.persist, root + "/bin"} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	write(p.state+"/state.lock", "")
	write(p.log, "")
	write(p.leases, "0 mac 192.0.2.1 dhcp-host *\n0 mac 192.0.2.2 * *\n")
	write(p.odhcp, "192.0.2.1 second-priority\n192.0.2.2 ipv6-lease\n")
	write(p.hosts, "192.0.2.1 third-priority\n127.0.0.1 localhost\n192.0.2.3 <img-src=x>\n")
	write(root+"/bin/date", "#!/bin/sh\nif [ \"$1\" = +%s ]; then printf '%s\\n' \"$TEST_EPOCH\"; else exec /usr/bin/date \"$@\"; fi\n")
	if err := os.Chmod(root+"/bin/date", 0700); err != nil {
		t.Fatal(err)
	}
	appendLog := func(text string) {
		t.Helper()
		f, err := os.OpenFile(p.log, os.O_APPEND|os.O_WRONLY, 0600)
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		if _, err := f.WriteString(text); err != nil {
			t.Fatal(err)
		}
	}
	epoch := int64(1790078400)
	h := time.Unix(epoch, 0).UTC().Format("2006-01-02T15")
	line := func(q string) string {
		return h + ":00:00Z INFO event=dns_response qname=" + q + " client_ip=192.0.2.1 upstream=up pipeline=main qtype=A rcode=NoError cache=true\n"
	}
	shell, err := filepath.Abs("../../tests/fixtures/kixdns-stats-legacy")
	if err != nil {
		t.Fatal(err)
	}
	fingerprints := func() map[string]string {
		t.Helper()
		out := make(map[string]string)
		err := filepath.WalkDir(root, func(name string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return err
			}
			b, err := os.ReadFile(name)
			if err != nil {
				return err
			}
			info, err := d.Info()
			if err != nil {
				return err
			}
			out[name] = fmt.Sprintf("%x/%d/%s", sha256.Sum256(b), info.ModTime().UnixNano(), info.Mode())
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	check := func(label string) snapshot {
		t.Helper()
		hours, err := hourKeys(epoch)
		if err != nil {
			t.Fatal(err)
		}
		before := fingerprints()
		got, err := collect(p, hours, true)
		if err != nil {
			t.Fatalf("%s: %v", label, err)
		}
		if !reflect.DeepEqual(before, fingerprints()) {
			t.Fatalf("%s: prototype changed input files", label)
		}
		cmd := exec.Command("sh", shell, "snapshot")
		cmd.Env = append(os.Environ(),
			"PATH="+root+"/bin:"+os.Getenv("PATH"), "TEST_EPOCH="+fmt.Sprint(epoch),
			"KIXDNS_LOG="+p.log, "KIXDNS_STATEDIR="+p.state, "KIXDNS_PERSISTDIR="+p.persist,
			"KIXDNS_DHCP_LEASES="+p.leases, "KIXDNS_HOSTS="+p.hosts, "KIXDNS_ODHCPD="+p.odhcp,
			"KIXDNS_TYPESAFE_KEY=offline-test-only")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("%s: shell: %v: %s", label, err, out)
		}
		var wantJSON, gotJSON any
		if err := json.Unmarshal(out, &wantJSON); err != nil {
			t.Fatal(err)
		}
		b, err := json.Marshal(got)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(b, &gotJSON); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(wantJSON, gotJSON) {
			t.Fatalf("%s:\nshell=%s\ngo=%s", label, out, b)
		}
		t.Log(label)
		return got
	}
	check("empty snapshot")
	write(p.state+"/classify.tsv", "example.org\tcdn\t0.123456\t0\nprinter.lan\tads\t0.9\t0\nempty.example\t\t0.5\t0\n")
	appendLog(line("EXAMPLE.ORG.") + line("child.example.org") + line("PRINTER.LAN.") + line("router") + line("time.home.arpa") + line("empty.example"))
	appendLog(strings.Replace(line("error.example"), "rcode=NoError", "rcode=ServFail", 1))
	appendLog("\x1b[32m" + strings.Replace(line(`"quote\"name.example"`), "upstream=up", `upstream="<img src=x>"`, 1))
	appendLog(strings.Replace(line("ignored.example"), "dns_response", "dns_request", 1))
	appendLog("2000-01-01T01:00:00Z event=dns_response qname=expired.example\n")
	s := check("parser, inheritance, LAN priority, JSON escaping, host precedence")
	if s.Queries != 8 || s.Cats["lan"] != 3 || s.Errors != 1 {
		t.Fatalf("unexpected totals: %+v", s)
	}
	check("idle cursor")
	partial := line("partial.example")
	appendLog(partial[:len(partial)/2])
	check("partial record ignored")
	appendLog(partial[len(partial)/2:])
	check("completed partial record counted once")
	b, _ := os.ReadFile(p.log)
	write(p.log, strings.ReplaceAll(string(b), "example", "replace"))
	check("same-size rewrite")
	b, _ = os.ReadFile(p.log)
	if err := os.Rename(p.log, p.log+".old"); err != nil {
		t.Fatal(err)
	}
	write(p.log, string(b))
	check("same-content inode replacement")
	write(p.log, line("short.example"))
	check("shrink")
	var many strings.Builder
	for i := 0; i < 130; i++ {
		many.WriteString(line(fmt.Sprintf("cap-%03d.example", i)))
	}
	appendLog(many.String())
	s = check("bounded breakdowns, full totals and stable top-20 ties")
	if !s.Limited || len(s.TopQname) != 20 {
		t.Fatal("missing cap or ranking")
	}
	var window, cache strings.Builder
	hours, _ := hourKeys(epoch)
	for i, bucket := range hours {
		for j := 0; j < 100; j++ {
			window.WriteString(strings.Replace(line(fmt.Sprintf("window-%02d-%03d.example", i, j)), h, bucket, 1))
		}
	}
	for i := 0; i < 5000; i++ {
		fmt.Fprintf(&cache, "cached-%04d.example\tcdn\t0.8\t0\n", i)
	}
	appendLog(window.String())
	write(p.state+"/classify.tsv", cache.String())
	s = check("full 24-hour window and 5,000 cached domains")
	if s.Unique != 2400 || s.Classify.Cached != 5000 {
		t.Fatalf("unexpected full-window totals: unique=%d cached=%d", s.Unique, s.Classify.Cached)
	}
	// Data formerly emitted with the cursor at the end remains readable.
	b, _ = os.ReadFile(p.state + "/stats.tsv")
	rows := strings.Split(string(b), "\n")
	write(p.state+"/stats.tsv", strings.Join(rows[1:], "\n")+rows[0]+"\n")
	check("legacy tail cursor")
	epoch += 25 * 3600
	s = check("hour expiry")
	if s.Queries != 0 {
		t.Fatal("old counters did not expire")
	}
	for _, name := range []string{"stats.tsv", "classify.tsv"} {
		if err := os.Rename(p.state+"/"+name, p.persist+"/"+name); err != nil {
			t.Fatal(err)
		}
	}
	check("persistent fallback without writes")
	if err := os.Remove(p.log); err != nil {
		t.Fatal(err)
	}
	check("missing log")
}

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
	c := newCounters(hours)
	if _, err := c.load(strings.NewReader("cursor\t1\t-1\tx\n")); err == nil {
		t.Fatal("accepted invalid cursor")
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
	info, _ := f.Stat()
	id := fmt.Sprint(info.Sys().(*syscall.Stat_t).Ino)
	mark, err := fingerprint(f, 2, true)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("cksum")
	cmd.Stdin = strings.NewReader("x\n")
	out, err := cmd.Output()
	if err != nil || mark != strings.Join(strings.Fields(string(out)), ":") {
		t.Fatalf("POSIX CRC mismatch: got=%s want=%s err=%v", mark, out, err)
	}
	if err := c.ingest(f, cursor{id, mark, 2}); err != nil {
		t.Fatal("legacy CRC migration failed:", err)
	}
}
