# Copyright (C) 2026
# SPDX-License-Identifier: GPL-3.0-only

include $(TOPDIR)/rules.mk

PKG_NAME:=kixdns-stats
PKG_VERSION:=1.6.0
PKG_RELEASE:=1
PKG_LICENSE:=GPL-3.0-only
PKG_BUILD_PARALLEL:=1

KIXDNS_STATS_PREBUILT:=$(CURDIR)/prebuilt/kixdns-stats-core
KIXDNS_STATS_USE_PREBUILT:=$(if $(wildcard $(KIXDNS_STATS_PREBUILT)),1)

ifeq ($(KIXDNS_STATS_USE_PREBUILT),)
PKG_BUILD_DEPENDS:=golang/host
PKG_BUILD_FLAGS:=no-mips16
GO_PKG:=kixdns-stats
GO_PKG_BUILD_PKG:=kixdns-stats
GO_PKG_LDFLAGS:=-s -w
endif

include $(INCLUDE_DIR)/package.mk

ifeq ($(KIXDNS_STATS_USE_PREBUILT),)
include $(TOPDIR)/feeds/packages/lang/golang/golang-package.mk
# Match the static, CGO-free prebuilts rather than external-linker/PIE defaults.
GO_PKG_BUILD_VARS+=CGO_ENABLED=0
GO_PKG_DEFAULT_LDFLAGS:=-linkmode internal
GO_PKG_ENABLE_PIE:=

define Build/Prepare
	$(INSTALL_DIR) $(PKG_BUILD_DIR)
	$(CP) ./src/. $(PKG_BUILD_DIR)/
endef
else
define Build/Prepare
	$(INSTALL_DIR) $(PKG_BUILD_DIR)
endef

define Build/Configure
endef

define Build/Compile
	$(INSTALL_DIR) $(PKG_INSTALL_DIR)/bin
	$(INSTALL_BIN) $(KIXDNS_STATS_PREBUILT) $(PKG_INSTALL_DIR)/bin/kixdns-stats
endef
endif

define Package/kixdns-stats
  SECTION:=net
  CATEGORY:=Network
  TITLE:=Native KixDNS statistics core
  DEPENDS:=$(if $(KIXDNS_STATS_USE_PREBUILT),,$(GO_ARCH_DEPENDS))
endef

define Package/kixdns-stats/description
  bbolt hourly DNS associations with atomic counters/cursor checkpoints.
  Classification transport and LuCI integration are provided by luci-app-kixdns.
endef

define Package/kixdns-stats/install
	$(INSTALL_DIR) $(1)/usr/libexec
	$(INSTALL_BIN) $(if $(KIXDNS_STATS_USE_PREBUILT),$(PKG_INSTALL_DIR)/bin,$(GO_PKG_BUILD_BIN_DIR))/kixdns-stats $(1)/usr/libexec/kixdns-stats-core
	$(INSTALL_DIR) $(1)/usr/share/licenses/kixdns-stats
	$(INSTALL_DATA) ./COPYING ./LICENSE.go ./LICENSE.bbolt ./LICENSE.x-sys $(1)/usr/share/licenses/kixdns-stats/
endef

$(eval $(call BuildPackage,kixdns-stats))
