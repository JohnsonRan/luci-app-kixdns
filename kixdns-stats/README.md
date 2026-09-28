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
- All primary cards, chart and rankings use retained matching log associations.
  The separate 24h logged-response total is unfiltered and retains evicted
  associations' counts; it does not include requests absent from the source log.
  Coverage shows retained details before filters. Missing associations are
  marked, never treated as confirmed zeroes.
- Only explicit `cache_hit=true/false` is trusted. `cache_hits: null` means the
  selected hours contain legacy/unknown hit semantics, not zero hits.
  `legacy_logs` is always emitted and describes the whole window; an unaffected
  filtered hour can still have a numeric hit count. Quality is conservative per
  hour: mixing old and new records makes that entire hour's rate unavailable.
- Database schema 2 upgrades transactionally to schema 3 without discarding
  counts, categories or the log cursor. Existing hours are marked untrusted;
  normal expiry removes that marker. Lost logs or evicted details are not rebuilt.
  Older helpers reject schema 3: keep a pre-upgrade database backup if rollback
  is needed, and do not delete the database to hide this warning.
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
checks. These cover combined filters, transaction rollback, crash-before-commit,
compaction, idle writes, incremental checkpoints, concurrency and fail-closed
clearing. HTTP is mocked; classification JSON uses the real Go parser. Local
tests do not establish real rpcd ACL behavior or power-cut/device performance.
SDK source builds require Go 1.25+; release packaging uses static prebuilts.

The durable `/etc/kixdns/stats.db` is created at runtime, not shipped in a
package. Before upgrading, run `/usr/libexec/kixdns-stats fold` to checkpoint
statistics and classification; verify the package and a reboot before removing
any backups.
