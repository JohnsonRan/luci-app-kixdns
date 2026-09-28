# Copyright (C) 2026
# This is free software, licensed under the GNU General Public License v3.

include $(TOPDIR)/rules.mk

PKG_NAME:=kixdns
PKG_VERSION:=0.2.0
PKG_RELEASE:=3

# CI places a static musl binary here so the SDK only needs to package it.
# Source builds remain the fallback for normal OpenWrt feed users.
KIXDNS_PREBUILT:=$(CURDIR)/prebuilt/kixdns
KIXDNS_USE_PREBUILT:=$(if $(wildcard $(KIXDNS_PREBUILT)),1)

ifeq ($(KIXDNS_USE_PREBUILT),)
PKG_SOURCE_PROTO:=git
PKG_SOURCE_URL:=https://github.com/olicesx/kixdns.git
PKG_SOURCE_DATE:=2026-09-28
PKG_SOURCE_VERSION:=42981abe52ce53271be50b430594e02601e8b615
PKG_MIRROR_HASH:=805f0237b39b3f08233bcff6bdbd663181b4e7bbc6494ebacdc8b1bb52c4da81

PKG_BUILD_DEPENDS:=rust/host
endif

PKG_LICENSE:=GPL-3.0-only
PKG_LICENSE_FILES:=LICENSE
PKG_BUILD_PARALLEL:=1

include $(INCLUDE_DIR)/package.mk

ifeq ($(KIXDNS_USE_PREBUILT),)
include $(TOPDIR)/feeds/packages/lang/rust/rust-package.mk

# aws-lc-sys runs C compiler probes during its build script. Force those probes
# onto OpenWrt's target compiler instead of rust-package.mk's host CC.
KIXDNS_AWS_LC_CC_ENV:=AWS_LC_SYS_CC_$(subst -,_,$(RUSTC_TARGET_ARCH))
CARGO_PKG_VARS += $(KIXDNS_AWS_LC_CC_ENV)=$(TARGET_CC_NOCACHE)
else
# No source archive or Rust toolchain is needed when CI supplied the binary.
define Build/Prepare
	rm -rf $(PKG_BUILD_DIR)
	$(INSTALL_DIR) $(PKG_BUILD_DIR)
endef

define Build/Compile
	$(INSTALL_DIR) $(PKG_INSTALL_DIR)/bin
	$(INSTALL_BIN) $(KIXDNS_PREBUILT) $(PKG_INSTALL_DIR)/bin/kixdns
endef
endif

define Package/kixdns
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=IP Addresses and Names
  TITLE:=High-performance non-recursive DNS forwarding server
  URL:=https://github.com/olicesx/kixdns
  DEPENDS:=$(if $(KIXDNS_USE_PREBUILT),,$(RUST_ARCH_DEPENDS))
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
