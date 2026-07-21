#!/bin/sh
# luci-app-kixdns one-click installer
# Downloads the latest prebuilt release and installs it with apk.

set -e

REPO="JohnsonRan/luci-app-kixdns"

if ! command -v apk >/dev/null 2>&1; then
	echo "this installer requires the apk package manager (OpenWrt 24.10+)" >&2
	exit 1
fi

[ -f /etc/openwrt_release ] || {
	echo "/etc/openwrt_release not found, is this OpenWrt?" >&2
	exit 1
}
. /etc/openwrt_release

case "$DISTRIB_ARCH" in
	x86_64*) arch=x86_64 ;;
	aarch64_cortex-a53) arch=aarch64_cortex-a53 ;;
	aarch64*) arch=aarch64_generic ;;
	*)
		echo "unsupported architecture: $DISTRIB_ARCH (only x86_64, aarch64_generic and aarch64_cortex-a53 prebuilt packages are provided)" >&2
		exit 1
		;;
esac

if command -v curl >/dev/null 2>&1; then
	fetch() { curl -fsSL -o "$1" "$2"; }
elif command -v uclient-fetch >/dev/null 2>&1; then
	fetch() { uclient-fetch -q -O "$1" "$2"; }
elif command -v wget >/dev/null 2>&1; then
	fetch() { wget -q -O "$1" "$2"; }
else
	echo "no download tool found (need curl, uclient-fetch or wget)" >&2
	exit 1
fi

asset="kixdns_${arch}-openwrt-25.12.tar.gz"
url="https://github.com/$REPO/releases/latest/download/$asset"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT INT TERM

echo "downloading $asset..."
if ! fetch "$tmpdir/$asset" "$url"; then
	echo "failed to download $asset" >&2
	echo "no prebuilt package available for architecture: $arch" >&2
	exit 1
fi

tar -xzf "$tmpdir/$asset" -C "$tmpdir"

echo "installing packages..."
apk add --allow-untrusted "$tmpdir"/*.apk

echo "installed. Configure it under LuCI: Services > KixDNS"
