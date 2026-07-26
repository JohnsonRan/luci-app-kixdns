# Copyright (C) 2026
# This is free software, licensed under the GNU General Public License v3.

include $(TOPDIR)/rules.mk

PKG_NAME:=kixdns
PKG_VERSION:=0.1.0
PKG_RELEASE:=5

PKG_SOURCE_PROTO:=git
PKG_SOURCE_URL:=https://github.com/olicesx/kixdns.git
PKG_SOURCE_DATE:=2026-07-26
PKG_SOURCE_VERSION:=adc813de0d87737de13c52f4b63cf359b5223565
PKG_MIRROR_HASH:=83a29905c161091015f9d0f681340f50f0c650e43d4e71d817dde8241d39c248

PKG_LICENSE:=GPL-3.0-only
PKG_LICENSE_FILES:=LICENSE

PKG_BUILD_DEPENDS:=rust/host
PKG_BUILD_PARALLEL:=1

include $(INCLUDE_DIR)/package.mk
include $(TOPDIR)/feeds/packages/lang/rust/rust-package.mk

# aws-lc-sys runs C compiler probes during its build script. Force those probes
# onto OpenWrt's target compiler instead of rust-package.mk's host CC.
KIXDNS_AWS_LC_CC_ENV:=AWS_LC_SYS_CC_$(subst -,_,$(RUSTC_TARGET_ARCH))
CARGO_PKG_VARS += $(KIXDNS_AWS_LC_CC_ENV)=$(TARGET_CC_NOCACHE)

define Package/kixdns
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=IP Addresses and Names
  TITLE:=High-performance non-recursive DNS forwarding server
  URL:=https://github.com/olicesx/kixdns
  DEPENDS:=$(RUST_ARCH_DEPENDS)
endef

define Package/kixdns/description
  KixDNS is a high-performance, non-recursive DNS forwarding server written
  in Rust, with hot-reloadable pipeline configuration, advanced routing
  rules, GeoIP/GeoSite matching and DoH/DoT/DoQ upstream support.
endef

define Package/kixdns/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(PKG_INSTALL_DIR)/bin/kixdns $(1)/usr/bin/kixdns
endef

$(eval $(call BuildPackage,kixdns))
