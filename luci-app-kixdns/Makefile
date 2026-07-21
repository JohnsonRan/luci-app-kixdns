# Copyright (C) 2026
# This is free software, licensed under the GNU General Public License v3.

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-kixdns
PKG_VERSION:=1.4.9
PKG_RELEASE:=1

LUCI_TITLE:=LuCI Support for KixDNS
LUCI_DESCRIPTION:=LuCI interface for KixDNS - a high-performance DNS forwarding server
LUCI_DEPENDS:=+kixdns +jsonfilter +kmod-nft-nat
LUCI_PKGARCH:=all

# Do NOT let luci.mk run csstidy/jsmin over htdocs at build time.
# The vendored bootstrap/vue/mermaid assets are already minified; csstidy
# cannot parse modern CSS (e.g. calc(var(...))) and corrupts bootstrap's
# .modal-header .btn-close rule, which makes browsers drop every rule after
# it (including .d-flex / gap / text-* utilities) and breaks the editor layout.
LUCI_MINIFY_CSS:=0
LUCI_MINIFY_JS:=0

define Package/luci-app-kixdns/conffiles
/etc/config/kixdns
/etc/kixdns/pipeline.json
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
