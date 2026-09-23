//go:build linux

package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

func privateDir(dir string) error {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Sys().(*syscall.Stat_t).Uid != uint32(os.Geteuid()) {
		return fmt.Errorf("unsafe statistics directory: %s", dir)
	}
	return os.Chmod(dir, 0700)
}
func optionalFile(name string) ([]byte, error) {
	b, err := os.ReadFile(name)
	if errors.Is(err, os.ErrNotExist) || errors.Is(err, syscall.ENOTDIR) {
		return nil, nil
	}
	return b, err
}
func syncPath(name string) error {
	f, err := os.Open(name)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}
func atomicFile(name string, data []byte, durable bool) error {
	current, err := os.ReadFile(name)
	if err == nil && bytes.Equal(current, data) {
		if durable {
			if err := syncPath(name); err != nil {
				return err
			}
			return syncPath(filepath.Dir(name))
		}
		return nil
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(name), "."+filepath.Base(name)+"-")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if _, err = f.Write(data); err != nil {
		f.Close()
		return err
	}
	if durable {
		if err = f.Sync(); err != nil {
			f.Close()
			return err
		}
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = os.Rename(tmp, name); err != nil {
		return err
	}
	if durable {
		return syncPath(filepath.Dir(name))
	}
	return nil
}

// Closing this descriptor releases the lock; HTTP transport never owns it.
func lockState(p paths) (*os.File, error) {
	if err := privateDir(p.state); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(p.state, "state.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}
func update(p paths, hours []string, enabled bool, command string) (snapshot, error) {
	return updateFiltered(p, hours, enabled, command, queryFilter{})
}
func updateFiltered(p paths, hours []string, enabled bool, command string, q queryFilter) (snapshot, error) {
	var empty snapshot
	if len(hours) != 24 {
		return empty, errors.New("expected 24 hour keys")
	}
	if command != "snapshot" && command != "ingest" && command != "fold" && command != "clear" {
		return empty, errors.New("unknown state operation")
	}
	lock, err := lockState(p)
	if err != nil {
		return empty, err
	}
	defer lock.Close()
	db, err := openDatabase(p)
	if err != nil {
		return empty, err
	}
	defer db.Close()
	tx, err := db.Begin(true)
	if err != nil {
		return empty, err
	}
	defer tx.Rollback()
	store, err := initializeStore(tx, p, hours)
	if err != nil {
		return empty, err
	}
	if err = store.pruneExpired(hours); err != nil {
		return empty, err
	}
	c, cur, err := store.loadMetrics(hours)
	if err != nil {
		return empty, err
	}
	log, err := os.Open(p.log)
	if errors.Is(err, os.ErrNotExist) {
		cur = cursor{id: "none", mark: "none"}
	} else if err != nil {
		return empty, err
	} else {
		cur, err = c.advance(log, cur, store.recordJoint)
		log.Close()
		if err != nil {
			return empty, err
		}
	}
	if err = store.saveMetrics(c); err != nil {
		return empty, err
	}
	if err = store.saveCursor(cur); err != nil {
		return empty, err
	}
	result := empty
	if command == "snapshot" {
		classes, e := readClassCache(tx)
		if e != nil {
			return empty, e
		}
		hosts, e := readHosts(p)
		if e != nil {
			return empty, e
		}
		result, err = filteredSnapshot(tx, hours, classes, len(classes), hosts, enabled, q)
		if err != nil {
			return empty, err
		}
		result.Totals = &totalReference{}
		for k, n := range c.values {
			switch k.kind {
			case "q":
				result.Totals.Queries += n
			case "cache":
				result.Totals.CacheHits += n
			case "err":
				result.Totals.Errors += n
			}
		}
	}
	if err = store.finish(); err != nil {
		return empty, err
	}
	if command == "snapshot" || command == "ingest" {
		return result, nil
	}
	if err = checkpointDatabase(db, p); err != nil {
		return empty, err
	}
	if command != "clear" {
		return empty, nil
	}
	// Never truncate before the unified statistics/classification checkpoint succeeds.
	log, err = os.OpenFile(p.log, os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		return empty, err
	}
	info, err := log.Stat()
	if err != nil || !info.Mode().IsRegular() {
		log.Close()
		return empty, errors.New("cannot clear a non-regular log")
	}
	if err = log.Truncate(0); err != nil {
		log.Close()
		return empty, err
	}
	log.Close()
	cur = cursor{id: strconv.FormatUint(uint64(info.Sys().(*syscall.Stat_t).Ino), 10), mark: "none"}
	tx, err = db.Begin(true)
	if err != nil {
		return empty, err
	}
	defer tx.Rollback()
	store, err = initializeStore(tx, p, hours)
	if err != nil {
		return empty, err
	}
	if err = store.saveCursor(cur); err != nil {
		return empty, err
	}
	if err = store.finish(); err != nil {
		return empty, err
	}
	if err = checkpointDatabase(db, p); err != nil {
		return empty, err
	}
	return empty, nil
}

func reportMemory() {
	// Process I/O counts are not physical flash wear. VmHWM includes mmap pages;
	// adding it to database/tmpfs file sizes can double-count those same pages.
	defer func() {
		data, err := os.ReadFile("/proc/self/io")
		if err != nil {
			return
		}
		values := map[string]string{}
		for _, line := range strings.Split(string(data), "\n") {
			f := strings.Fields(line)
			if len(f) == 2 {
				values[f[0]] = f[1]
			}
		}
		fmt.Fprintf(os.Stderr, "STATS_IO wchar=%s write_bytes=%s\n", values["wchar:"], values["write_bytes:"])
	}()
	data, err := os.ReadFile("/proc/self/status")
	if err != nil {
		fmt.Fprintln(os.Stderr, "STATS_MEMORY unavailable")
		return
	}
	for _, line := range strings.Split(string(data), "\n") {
		f := strings.Fields(line)
		if len(f) == 3 && f[0] == "VmHWM:" && f[2] == "kB" {
			fmt.Fprintf(os.Stderr, "STATS_MEMORY self_vm_hwm_kib=%s\n", f[1])
			return
		}
	}
	fmt.Fprintln(os.Stderr, "STATS_MEMORY unavailable")
}
