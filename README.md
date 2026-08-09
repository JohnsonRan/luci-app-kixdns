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
core and builds the LuCI files; it no longer compiles Rust once for every OpenWrt
release. Keeping the final packaging in the SDK also guarantees native OpenWrt
`ipk` metadata and the APK v3 format required by OpenWrt 25.12.

## Paths

- Pipeline configuration: `/etc/kixdns/pipeline.json`
- GeoIP database: `/etc/kixdns/geoip.dat`
- Service log: `/tmp/kixdns.log`
