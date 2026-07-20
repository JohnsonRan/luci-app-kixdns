# luci-app-kixdns

LuCI support for [KixDNS](https://github.com/olicesx/kixdns/), a high-performance DNS forwarding server written in Rust.

Targets OpenWrt 25.12 with JavaScript LuCI and firewall4/nftables.

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
