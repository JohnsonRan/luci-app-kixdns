# KixDNS for LuCI

Manage [KixDNS](https://github.com/olicesx/kixdns/) on OpenWrt: DNS service,
local-first pipeline, logs and 24-hour statistics. Supports OpenWrt 24.10 and
25.12 on x86_64, aarch64_generic and aarch64_cortex-a53.

## Install

Run on router:

```sh
wget -O - https://raw.githubusercontent.com/JohnsonRan/luci-app-kixdns/main/install.sh | sh
```

Choose **stable** (default). Installer selects packages for your OpenWrt version
and architecture, plus a matching translation if available. To try latest
successfully built `main` version instead, choose **rolling** at prompt or run:

```sh
wget -O - https://raw.githubusercontent.com/JohnsonRan/luci-app-kixdns/main/install.sh | KIXDNS_RELEASE_TAG=rolling sh
```

Open **Services → KixDNS** in LuCI. For other targets, see [Build from source](#build-from-source).

## What you get

- Service controls and optional LAN DNS interception (UDP/TCP port 53).
- Pipeline editor with local-first configuration, backups and optional manual
  remote updates; optional GeoIP download before startup.
- Searchable log viewer and 24-hour statistics by client, domain and category.
  One filter applies to cards, chart and rankings. Separate **24h total** is
  unaffected by filters; incomplete hours are marked rather than shown as zero.
- Optional TypeSafe Jev classification. Add an API key in LuCI to enable it.
  Eligible queried domains are sent to TypeSafe; leave key blank for no requests.
  Local names such as `router`, `.lan`, `.local` and `.arpa` are excluded, but
  exclusion is not a guarantee that every other name is public. Categories are
  hints, not security verdicts.

Statistics come from KixDNS `dns_response` logs. Keep recommended query-log
filter enabled: queries absent from log cannot be counted. Stats retain 24 hours;
when association storage fills, oldest client/domain associations are dropped
while full query totals remain available. See [statistics details](kixdns-stats/README.md).

## Data and upgrades

- Persistent statistics **and** category cache: `/etc/kixdns/stats.db`.
  Live working copy: `/tmp/kixdns-stats/stats.db`. Database is created by
  KixDNS, not shipped in an installation package.
- Ordinary package updates leave this database untouched. Before updating,
  `/usr/libexec/kixdns-stats fold` saves current statistics and categories.
  Automatic checkpoints also run every five minutes and on service stop.
- OpenWrt **firmware** upgrades with **Keep settings** include `stats.db` via
  package's sysupgrade keep list. Before flashing, run:

  ```sh
  /usr/libexec/kixdns-stats fold
  sysupgrade -l | grep -F 'etc/kixdns/stats.db'
  ```

  If file is not listed, do not assume it will survive; save a backup elsewhere
  first. **Reset settings / `sysupgrade -n` does not preserve it.** Firmware
  upgrades may also require reinstalling KixDNS packages.
- Sudden power loss can discard last uncheckpointed interval. Do not manually
  delete or replace `stats.db` while service is running.

## Build from source

Add this repository under OpenWrt `package/` or as a feed, then build:

```sh
make package/kixdns/compile package/kixdns-stats/compile package/luci-app-kixdns/compile V=s
```

Source builds need Rust and Go host toolchains from OpenWrt feeds. The optional
root `Justfile` can build static DNS and statistics helpers locally:

```sh
just core-build aarch64
just stats-build aarch64
```

## Development checks

On Linux/WSL with Go 1.25+, Node and POSIX tools:

```sh
(cd kixdns-stats/src && CGO_ENABLED=0 go test ./... && go vet ./...)
export KIXDNS_STATS_CORE="$(mktemp -d)/kixdns-stats-core"
(cd kixdns-stats/src && CGO_ENABLED=0 go build -o "$KIXDNS_STATS_CORE" .)
node tests/log.test.cjs
node tests/stats.test.cjs
node tests/views.test.cjs
node tests/packages.test.cjs
```

Tests mock classification HTTP. They do not establish actual router performance,
full firmware-upgrade behavior or power-cut safety.
