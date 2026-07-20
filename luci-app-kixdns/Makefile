# Copyright (C) 2026
# This is free software, licensed under the GNU General Public License v3.

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-kixdns
PKG_VERSION:=1.4.4
PKG_RELEASE:=1

LUCI_TITLE:=LuCI Support for KixDNS
LUCI_DESCRIPTION:=LuCI interface for KixDNS - a high-performance DNS forwarding server
LUCI_DEPENDS:=+kixdns +jsonfilter +kmod-nft-nat
LUCI_PKGARCH:=all

define Package/luci-app-kixdns/conffiles
/etc/config/kixdns
/etc/kixdns/pipeline.json
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
