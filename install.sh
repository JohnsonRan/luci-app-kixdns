#!/bin/sh
# luci-app-kixdns one-click installer
# Downloads a stable or rolling prebuilt release and installs it with opkg or apk.

set -e

REPO="JohnsonRan/luci-app-kixdns"

release_tag="${KIXDNS_RELEASE_TAG:-}"
if [ -z "$release_tag" ]; then
	if (exec </dev/tty) 2>/dev/null; then
		while :; do
			{
				echo "Select a release channel:"
				echo "  1) stable  - latest published release"
				echo "  2) rolling - latest successful main branch build"
				printf "Choice [1]: "
			} >/dev/tty

			if ! IFS= read -r choice </dev/tty; then
				choice=1
			fi

			case "$choice" in
				""|1|stable|latest)
					release_tag=latest
					break
					;;
				2|rolling)
					release_tag=rolling
					break
					;;
				*) echo "invalid choice: $choice" >/dev/tty ;;
			esac
		done
	else
		release_tag=latest
		echo "no interactive terminal detected; using the stable release channel"
	fi
fi

case "$release_tag" in
	latest)
		release_channel=stable
		release_base_url="https://github.com/$REPO/releases/latest/download"
		;;
	rolling)
		release_channel=rolling
		release_base_url="https://github.com/$REPO/releases/download/rolling"
		;;
	*)
		echo "unsupported release tag: $release_tag (supported: latest and rolling)" >&2
		exit 1
		;;
esac

[ -f /etc/openwrt_release ] || {
	echo "/etc/openwrt_release not found, is this OpenWrt?" >&2
	exit 1
}
. /etc/openwrt_release

release="${DISTRIB_RELEASE:-}"
case "$release" in
	24.10|24.10.*)
		asset_release=24.10
		package_ext=ipk
		package_manager=opkg
		;;
	25.12|25.12.*|SNAPSHOT)
		asset_release=25.12
		package_ext=apk
		package_manager=apk
		;;
	*)
		echo "unsupported OpenWrt release: ${release:-unknown} (supported: 24.10 and 25.12)" >&2
		exit 1
		;;
esac

if ! command -v "$package_manager" >/dev/null 2>&1; then
	echo "OpenWrt $release requires the $package_manager package manager, but it was not found" >&2
	exit 1
fi

case "${DISTRIB_ARCH:-}" in
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

asset="kixdns_${arch}-openwrt-${asset_release}.tar.gz"
url="$release_base_url/$asset"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT INT TERM

echo "downloading $asset from the $release_channel release channel..."
if ! fetch "$tmpdir/$asset" "$url"; then
	echo "failed to download $asset" >&2
	echo "no prebuilt package available for OpenWrt $asset_release on architecture $arch" >&2
	exit 1
fi

tar -xzf "$tmpdir/$asset" -C "$tmpdir"

core_package=""
luci_package=""
for package in "$tmpdir"/*."$package_ext"; do
	[ -f "$package" ] || continue
	case "${package##*/}" in
		kixdns[-_]*) core_package=$package ;;
		luci-app-kixdns[-_]*) luci_package=$package ;;
	esac
done

if [ -z "$core_package" ] || [ -z "$luci_package" ]; then
	echo "downloaded archive does not contain both kixdns and luci-app-kixdns .$package_ext packages" >&2
	exit 1
fi

echo "installing packages for OpenWrt $asset_release with $package_manager..."
case "$package_manager" in
	opkg) opkg install "$core_package" "$luci_package" ;;
	apk) apk add --allow-untrusted "$core_package" "$luci_package" ;;
esac

echo "installed. Configure it under LuCI: Services > KixDNS"
