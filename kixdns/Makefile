# Copyright (C) 2026
# This is free software, licensed under the GNU General Public License v3.

include $(TOPDIR)/rules.mk

PKG_NAME:=kixdns
PKG_VERSION:=0.1.1
PKG_RELEASE:=2

PKG_SOURCE_PROTO:=git
PKG_SOURCE_URL:=https://github.com/olicesx/kixdns.git
PKG_SOURCE_DATE:=2026-08-04
PKG_SOURCE_VERSION:=e55f0a85805303d8665106d6ed7ffbd354e1e5e9
PKG_MIRROR_HASH:=dd7310fc03900e01d212e1814181e53fea406df2a7d80334f8e04a32a874c266

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
