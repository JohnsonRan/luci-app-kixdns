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
	aarch64*) arch=aarch64_generic ;;
	*)
		echo "unsupported architecture: $DISTRIB_ARCH (only x86_64 and aarch64_generic prebuilt packages are provided)" >&2
		exit 1
		;;
esac

asset="kixdns_${arch}-openwrt-25.12.tar.gz"
url="https://github.com/$REPO/releases/latest/download/$asset"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT INT TERM

echo "downloading $asset..."
wget -O "$tmpdir/$asset" "$url"

tar -xzf "$tmpdir/$asset" -C "$tmpdir"

echo "installing packages..."
apk add --allow-untrusted "$tmpdir"/*.apk

cat <<-'EOF'

	installed. Enable and start the service with:
	  uci set kixdns.main.enabled=1
	  uci commit kixdns
	  /etc/init.d/kixdns enable
	  /etc/init.d/kixdns start

	Then configure it under LuCI: Services > KixDNS
EOF
