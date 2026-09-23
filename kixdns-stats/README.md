# KixDNS statistics core — bbolt

Pure Go, using `go.etcd.io/bbolt v1.5.0`; Go **1.25+**, no CGO, C compiler,
SQLite library, daemon or inference model required. CI uses Go 1.27.x.
Go owns statistics, classification selection/validation, cache and transactions.
The Shell wrapper only supplies the existing bounded TypeSafe HTTP transport.

## Data and durability

- One database: `/tmp/kixdns-stats/stats.db`, checkpointed to `/etc/kixdns/stats.db`.
  Statistics and classification cache use separate buckets, not separate stores.
- Hourly client/domain/upstream/pipeline/type/response associations, global totals
  and the log cursor commit in one transaction. No individual request history.
- All primary cards, chart and rankings use retained matching associations.
  The separate 24h total is complete and unfiltered. Missing associations are
  marked, never treated as confirmed zeroes.
- Old TSV counters/cursor are imported once. The original is backed up as
  `/etc/kixdns/stats-import.tsv`. Old client/domain correlations cannot be invented.
  Existing bbolt data is adopted once from `stats.bolt` by atomic rename;
  `classify.tsv` is imported once with a `classify-import.tsv` backup. Original
  TSV files are not updated or consulted after import. There is no double-write,
  permanent filename alias, export or SQLite migration.
- A soft **8 MiB live key/value budget** evicts oldest associated hours while
  preserving full totals. This is **not** an 8 MiB RAM or file-size guarantee.
  COW pages, mmap, free pages, logs and classification cache need extra space.
- `fold` runs every five minutes/on stop/before log clearing. Normal checkpoints
  synchronize changed/deleted keys transactionally; unchanged checkpoints do not
  write. Initial copies and large, substantially empty files use full compaction.
  Deleting bbolt keys alone does not shrink its file.
- `clear` checkpoints before truncating and saves the reset cursor afterward.
  Power loss can lose uncheckpointed data. Copy-truncate can lose concurrent log
  appends; same-inode rewrites with identical 128-byte boundaries can evade detection.
- Classification cache shares the same transaction/checkpoint machinery. Updates
  do not write flash immediately; recent uncheckpointed cache entries can be lost
  on power loss, like statistics. HTTP holds no database handle or state lock.
- Statistics snapshots do not make classification requests. The optional
  page/background classification batch may use TypeSafe.

## Build and offline checks

```sh
just stats-build aarch64
# Or, from kixdns-stats/src:
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 GOARM64=v8.0 \
  go build -trimpath -ldflags='-s -w' -o /tmp/kixdns-stats-core .
```

On Linux/WSL, run `go test ./...`, `go vet ./...`, and the root README's Node
checks. These cover combined filters, import, rollback, crash-before-commit,
compaction, idle writes, incremental checkpoints, concurrency and fail-closed
clearing. HTTP is mocked; classification JSON uses the real Go parser. Trial
checks mock jsonfilter locally and use the real tool on-device. Local tests do
not establish real rpcd ACL behavior or power-cut/device performance.
SDK source builds require Go 1.25+; release packaging uses static prebuilts.
Full SDK and router acceptance remain separate gates.

## ARM64 router trial

The **new, separate** `kixdns-stats-db-arm64.tar.gz` contains the helper,
wrapper, view, RPC ACL, Simplified Chinese translation, trial script and notices.
The previously accepted Go/TSV archive is unchanged and is not a bbolt benchmark.

Upload the new archive to `/tmp`, close the statistics page, then run:

```sh
mkdir -p /tmp/kixdns-bbolt-trial
tar -xzf /tmp/kixdns-stats-db-arm64.tar.gz -C /tmp/kixdns-bbolt-trial
sh /tmp/kixdns-bbolt-trial/trial.sh apply
```

`apply` checks checksums and synthetic filtering/recovery first, checkpoints the
installed backend, saves original program files in `/etc/kixdns/bbolt-trial-backup`,
and stages all replacements before installing. It does **not** restart services,
clear the real log or request classification. `check` runs only the synthetic
self-test. Re-running `apply` updates program files while keeping the verified
original backup unchanged. There is no separate upgrade/compatibility backend.

Log out/in to LuCI to load the new ACL, then hard-refresh. Confirm tooltip and
combined filters, reset, and continued counting. Imported history appears in the
24h total; new filterable results accumulate with new traffic. Share the printed
timings/memory and observed behavior, not domain/client snapshots. RSS includes
mmap pages; do not add it to tmpfs size. I/O counters are not physical flash wear.

To restore program files:

```sh
sh /etc/kixdns/bbolt-trial-backup/trial.sh rollback
```

Rollback leaves databases/logs untouched but **does not convert `stats.db` to
old filenames, schemas or TSV**. Old program versions may not read this database. Do not roll back across a
package upgrade. Keep the backup until the trial is accepted.

## Switch from trial to managed packages

Do **not** run the online installer until a release containing unified
`kixdns-stats` and LuCI 1.6.0 packages is published: older releases would
replace trial executables. Before installing new packages, run
`/usr/libexec/kixdns-stats fold` to checkpoint statistics and classification.
Then use the normal `install.sh` path for your OpenWrt release/architecture;
`/etc/kixdns/stats.db` is a conffile. Never invoke trial rollback after a
package installation. Keep the trial backup until reboot verification.

Before production acceptance, verify real RPC permissions, response time and
memory/storage headroom on the router, then checkpoint/reboot continuity during
a user-chosen maintenance window. Local/WSL results are not router measurements.
