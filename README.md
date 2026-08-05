# luci-app-kixdns

LuCI support for [KixDNS](https://github.com/olicesx/kixdns/), a high-performance DNS forwarding server written in Rust.

Targets OpenWrt 24.10 and 25.12 with JavaScript LuCI and firewall4/nftables.

## Features

- Service control and LAN DNS hijacking for UDP/TCP port 53.
- Optional GeoIP download before startup. An empty URL disables it.
- Local-first pipeline configuration with atomic saves, backups, and manual remote updates.
- Responsive visual editor with structured controls, editable JSON, flowcharts, dark mode, and section navigation.
- Dedicated log viewer with filters, highlighting, auto-refresh, and newest entries first.
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

For unattended installation, select the channel with `KIXDNS_RELEASE_TAG`:

```sh
# Stable
wget -O - https://raw.githubusercontent.com/JohnsonRan/luci-app-kixdns/main/install.sh | KIXDNS_RELEASE_TAG=latest sh

# Rolling
wget -O - https://raw.githubusercontent.com/JohnsonRan/luci-app-kixdns/main/install.sh | KIXDNS_RELEASE_TAG=rolling sh
```

The script detects the OpenWrt release and architecture, then installs the `.ipk` with `opkg` on OpenWrt 24.10 or the `.apk` with `apk` on OpenWrt 25.12. If no interactive terminal is available and `KIXDNS_RELEASE_TAG` is unset, it defaults to stable. For other releases or targets, build from source below.

## Building

Place this repository under the OpenWrt `package/` tree, for example `package/kixdns-feed`, or add it as a custom feed.

Build both packages:

```sh
make package/kixdns/compile package/luci-app-kixdns/compile V=s
```

The core package requires the Rust host toolchain from `feeds/packages/lang/rust`.

## Paths

- Pipeline configuration: `/etc/kixdns/pipeline.json`
- GeoIP database: `/etc/kixdns/geoip.dat`
- Service log: `/tmp/kixdns.log`
