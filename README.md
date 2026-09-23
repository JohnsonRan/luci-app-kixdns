# luci-app-kixdns

LuCI support for [KixDNS](https://github.com/olicesx/kixdns/), a high-performance DNS forwarding server written in Rust.

Targets OpenWrt 24.10 and 25.12 with JavaScript LuCI and firewall4/nftables.

## Features

- Service control and LAN DNS hijacking for UDP/TCP port 53.
- Optional GeoIP download before startup. An empty URL disables it.
- Local-first pipeline configuration with atomic saves, backups, and manual remote updates.
- Responsive visual editor with structured controls, editable JSON, flowcharts, dark mode, and section navigation.
- Dedicated log viewer with filters, highlighting, auto-refresh, and newest entries first.
- 24-hour query stats from service logs, with optional TypeSafe Jev domain classification.
- Bundled OpenWrt package for building the KixDNS core from source.

## Packages

```text
kixdns/            KixDNS core package
luci-app-kixdns/   LuCI application
```

## Install

One-click install on OpenWrt 24.10 or 25.12 (`x86_64`, `aarch64_generic`, or `aarch64_cortex-a53`):

```sh
wget -O - https://raw.githubusercontent.com/JohnsonRan/luci-app-kixdns/main/install.sh | sh
```

The installer interactively offers two release channels:

1. **stable** (default) — packages from the latest published [release](https://github.com/JohnsonRan/luci-app-kixdns/releases/latest).
2. **rolling** — packages built from the latest successfully built `main` branch.

> **Recommended: rolling.** KixDNS core updates do not always come with a new stable
> release, so choose rolling to receive ongoing core updates sooner. Rolling builds
> pass CI but may contain changes not yet included in a stable release. The installer
> still defaults to stable; select rolling explicitly or use the command below.

For unattended installation, select the channel with `KIXDNS_RELEASE_TAG`:

```sh
# Stable
wget -O - https://raw.githubusercontent.com/JohnsonRan/luci-app-kixdns/main/install.sh | KIXDNS_RELEASE_TAG=latest sh

# Rolling
wget -O - https://raw.githubusercontent.com/JohnsonRan/luci-app-kixdns/main/install.sh | KIXDNS_RELEASE_TAG=rolling sh
```

The script detects the OpenWrt release and architecture, then installs the core, LuCI application, and application translations matching the installed `luci-i18n-base-*` language packages (`.ipk` with `opkg` on OpenWrt 24.10 or `.apk` with `apk` on OpenWrt 25.12). Release archives include all available application translations; the installer selects only matching languages. If none match, including with older archives without translations, installation continues with a notice. If no interactive terminal is available and `KIXDNS_RELEASE_TAG` is unset, it defaults to stable. For other releases or targets, build from source below.

## Building

Place this repository under the OpenWrt `package/` tree, for example `package/kixdns-feed`, or add it as a custom feed.

Build the two native packages and LuCI:

```sh
make package/kixdns/compile package/kixdns-stats/compile package/luci-app-kixdns/compile V=s
```

The DNS core requires the Rust host toolchain from `feeds/packages/lang/rust`;
statistics requires `feeds/packages/lang/golang`. The architecture-independent
LuCI package depends on both native packages.

### Local core builds with Zig

For a faster local cross-compilation workflow, the root `Justfile` can fetch the
exact KixDNS revision pinned by `kixdns/Makefile` and build static musl binaries
with `cargo-zigbuild`:

```sh
# Install cargo-zigbuild and its bundled Zig toolchain, then verify the setup.
just setup
just doctor

# Build one target or both binary architectures used by this repository.
just core-build x86_64
just core-build aarch64
just core-build-all

# Native statistics helper (requires Go; no Zig or C library).
just stats-build x86_64
just stats-build aarch64
```

Generated binaries are written to `dist/core/`, while source and compiler caches
stay under `.cache/kixdns-core/`.

These commands are optional and are not part of a normal OpenWrt buildroot
build. When this repository is included as a package or feed, use the standard
OpenWrt `make` commands shown above; without a CI-provided prebuilt binary, the
package automatically compiles the pinned source through `rust-package.mk`.

The release workflow uses the same approach: it compiles one x86_64 and one
generic ARM64 static musl binary, verifies that they have no ELF interpreter or
dynamic dependencies, and passes them to both OpenWrt SDK builds. The same ARM64
binary is wrapped separately as `aarch64_generic` and `aarch64_cortex-a53` so the
package metadata matches each OpenWrt target. The SDK therefore only packages the
DNS/statistics binaries and builds the LuCI files; it no longer compiles Rust once for every OpenWrt
release. Keeping the final packaging in the SDK also guarantees native OpenWrt
`ipk` metadata and the APK v3 format required by OpenWrt 25.12.

## Statistics and privacy

The Stats page aggregates `dns_response` logs into the current and previous 23
hourly buckets (router time). Keep the recommended query log filter enabled;
requests absent from the log cannot be counted. Counters and the log cursor are
checkpointed together every five minutes, before log clearing, and on service
stop. Sudden power loss can lose the latest uncheckpointed interval. Unchanged
checkpoints are not rewritten. Runtime files are private and stored in tmpfs.
The pure Go helper uses one bbolt `stats.db` (no CGO), preserving the public Shell
interface. Statistics and classification cache share its transaction/checkpoint
machinery. Go owns selection, validation and storage; Shell only handles HTTP.
Client IP/hostname, domain keyword and category filters apply to every primary
card, curve and ranking. The separate 24h total is unfiltered. Old TSV totals and
cursor are imported once with an original-file backup; missing historical
correlations are marked rather than invented. Existing `stats.bolt` data and
classification TSV are adopted once; no ongoing TSV reads/writes or filename
aliases are maintained.
Idle polls skip database commits while refreshing hostnames/classifications.
Log identity and boundary checks require neither external `stat` nor `cksum`.
See [trial and rollback instructions](kixdns-stats/README.md).

A soft 8 MiB live association budget discards oldest associated hours, not full
query/cache/error totals. This is not a total RAM or file-size cap: bbolt's COW,
mmap and free pages, plus logs/cache, require headroom. Normal checkpoints update
only changed keys; initial copies and occasional compaction rewrite a database.
Log clearing uses copy-truncate: concurrent appends during truncation can be lost.

TypeSafe classification is **optional and external**: setting an API key sends
eligible queried domain names to TypeSafe Jev, in bounded batches from the
five-minute cron job or while a writable Stats page is open. Single-label names
and known local suffixes (such as `.lan`, `.local` and `.arpa`) are skipped; this
is not a guarantee that every remaining name is public. Leave the key empty to
disable requests. Cached parent-domain classifications may be inherited by
children; these are display hints, not security verdicts or public-suffix-aware
classification. Classification data lives in `/etc/kixdns/stats.db`, checkpointed
alongside statistics, not immediately after each API response. Uncheckpointed
cache updates can be lost on power loss. Network requests hold no database lock.
Page refresh finishes independently of slow classification requests; only one
background classification batch is allowed at a time.

Offline regression checks (Linux or WSL, Go 1.25+, Node, Bash/coreutils/awk/flock):

```sh
(cd kixdns-stats/src && go test -v ./... && go vet ./...)
export KIXDNS_STATS_CORE="$(mktemp -d)/kixdns-stats-core"
(cd kixdns-stats/src && CGO_ENABLED=0 go build -o "$KIXDNS_STATS_CORE" .)
node tests/log.test.cjs
node tests/stats.test.cjs
node tests/views.test.cjs
node tests/packages.test.cjs
node tests/trial.test.cjs
```

Log, view and archive tests also run under Windows/MSYS2. Native statistics and
trial tests require Linux; Windows can cross-compile Go test binaries for WSL.

The statistics suite mocks HTTP, but uses Go's production JSON validation.
Trial tests mock the router's `jsonfilter`; the on-device self-test uses the real
tool. `TEST_BASH` can select an alternative shell for the statistics suite.

Use the [separate bbolt trial](kixdns-stats/README.md) for manual router acceptance.
The retired Shell/TSV benchmark is not a test of this backend. Local tests and
synthetic measurements do not establish target-device performance. RSS includes
mmap pages and must not be added to tmpfs usage; logical writes are not physical
flash wear. Real rpcd/jsonfilter, SDK and reboot acceptance remain separate checks.

## Paths

- Pipeline configuration: `/etc/kixdns/pipeline.json`
- GeoIP database: `/etc/kixdns/geoip.dat`
- Service log: `/tmp/kixdns.log`
- Runtime statistics and classification cache: `/tmp/kixdns-stats/stats.db`
- Unified checkpoint: `/etc/kixdns/stats.db`
- Original imports: `/etc/kixdns/stats-import.tsv`, `/etc/kixdns/classify-import.tsv`
