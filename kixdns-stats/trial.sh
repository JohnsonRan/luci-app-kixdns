#!/bin/sh
# Explicit unified-database trial. No service restart, API request or log reset.
set -eu
umask 077
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CORE=/usr/libexec/kixdns-stats-core
WRAPPER=/usr/libexec/kixdns-stats
VIEW=/www/luci-static/resources/view/kixdns/stats.js
ACL=/usr/share/rpcd/acl.d/luci-app-kixdns.json
LOCALE=/usr/share/luci/i18n/kixdns.zh-cn.lmo
BACKUP=/etc/kixdns/bbolt-trial-backup
if [ ! -d "$(dirname "$LOCALE")" ] && [ -d /usr/lib/lua/luci/i18n ]; then
 LOCALE=/usr/lib/lua/luci/i18n/kixdns.zh-cn.lmo
fi
fail() { echo "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || fail "Run as root on the router"
verify() {
 base=$1
 [ -s "$base/MD5SUMS" ] || return 1
 while read -r expected name; do
  case "$name" in core|wrapper|stats.js|acl.json|zh-cn.lmo|trial.sh|core.absent|locale.absent) ;; *) return 1 ;; esac
  actual=$(md5sum "$base/$name") || return 1
  [ "${actual%% *}" = "$expected" ] || return 1
 done < "$base/MD5SUMS"
}
verify_payload() {
 verify "$HERE" || fail "Payload checksum failed; nothing installed"
 for name in core wrapper stats.js acl.json zh-cn.lmo trial.sh; do
  [ -s "$HERE/$name" ] && grep -q "  $name\$" "$HERE/MD5SUMS" || fail "Missing payload: $name"
 done
}
stage() { cp "$1" "$2.kixdns-bbolt-new"; chmod "$3" "$2.kixdns-bbolt-new"; }
cleanup() {
 s=$?
 [ -z "${sandbox:-}" ] || rm -rf "$sandbox"
 if [ "${staging:-0}" = 1 ]; then
  rm -f "$CORE.kixdns-bbolt-new" "$WRAPPER.kixdns-bbolt-new" "$VIEW.kixdns-bbolt-new" "$ACL.kixdns-bbolt-new" "$LOCALE.kixdns-bbolt-new"
 fi
 if [ "$s" -ne 0 ] && [ -f "$BACKUP/ready" ]; then echo "Restore program files: sh $BACKUP/trial.sh rollback" >&2; fi
}
trap cleanup EXIT
check_payload() {
 # Synthetic data only; never open or copy the router's query history here.
 sandbox=$(mktemp -d /tmp/kixdns-bbolt-check.XXXXXX)
 (
  export TZ=UTC0 KIXDNS_NOW="$(date +%s)" KIXDNS_TYPESAFE_KEY=
  export KIXDNS_LOG="$sandbox/log" KIXDNS_STATEDIR="$sandbox/state" KIXDNS_PERSISTDIR="$sandbox/persist"
  export KIXDNS_DHCP_LEASES="$sandbox/leases" KIXDNS_HOSTS="$sandbox/hosts" KIXDNS_ODHCPD="$sandbox/odhcp"
  mkdir "$KIXDNS_STATEDIR"
  hour=$(date +%Y-%m-%dT%H)
  for ip in 192.0.2.1 192.0.2.1 192.0.2.2; do
   printf '%s:00:00 event=dns_response qname=demo.example.invalid client_ip=%s qtype=A rcode=NoError cache=true\n' "$hour" "$ip"
  done > "$KIXDNS_LOG"
  result=$("$HERE/core" snapshot '{"client":"192.0.2.1","domain":"demo","category":"pending"}')
  [ "$(printf '%s' "$result" | jsonfilter -e '@.queries')" = 2 ] || fail "Combined filter check failed"
  [ "$(printf '%s' "$result" | jsonfilter -e '@.totals.queries')" = 3 ] || fail "Reference total check failed"
  "$HERE/core" fold
  rm -rf "$KIXDNS_STATEDIR"
  result=$("$HERE/core" snapshot)
  [ "$(printf '%s' "$result" | jsonfilter -e '@.queries')" = 3 ] || fail "Persistence check failed"
 )
 rm -rf "$sandbox"; sandbox=
 echo "PASS: ARM64 execution, combined filters and isolated checkpoint recovery."
}
case "${1:-}" in
 check|apply)
  [ "$(uname -m)" = aarch64 ] || fail "This trial contains an ARM64 binary"
  verify_payload
  check_payload
  [ "$1" = apply ] || exit 0
  [ -s "$WRAPPER" ] && [ -s "$VIEW" ] && [ -s "$ACL" ] || fail "Restore the existing application first"
  if [ -e "$BACKUP" ]; then
   [ -f "$BACKUP/ready" ] && verify "$BACKUP" || fail "Existing backup is incomplete or corrupt; nothing installed"
  fi
  unset KIXDNS_STATS_CORE KIXDNS_LOG KIXDNS_STATEDIR KIXDNS_PERSISTDIR KIXDNS_NOW KIXDNS_TYPESAFE_KEY KIXDNS_STATS_PROFILE
  "$WRAPPER" fold || fail "Checkpoint failed; original program files and log kept"
  if [ ! -e "$BACKUP" ]; then
  mkdir "$BACKUP"
  cp -p "$WRAPPER" "$BACKUP/wrapper"; cp -p "$VIEW" "$BACKUP/stats.js"; cp -p "$ACL" "$BACKUP/acl.json"
  cp "$HERE/trial.sh" "$BACKUP/trial.sh"
  if [ -f "$CORE" ]; then cp -p "$CORE" "$BACKUP/core"; else : > "$BACKUP/core.absent"; fi
  if [ -f "$LOCALE" ]; then cp -p "$LOCALE" "$BACKUP/zh-cn.lmo"; else : > "$BACKUP/locale.absent"; fi
  (cd "$BACKUP"; for name in wrapper stats.js acl.json trial.sh core core.absent zh-cn.lmo locale.absent; do
   [ ! -f "$name" ] || md5sum "$name" || exit 1
  done > MD5SUMS) || fail "Cannot checksum backup"
  : > "$BACKUP/ready"
  else
   echo "Reusing original program backup without overwriting it: $BACKUP"
  fi
  mkdir -p "$(dirname "$LOCALE")"
  staging=1
  stage "$HERE/core" "$CORE" 0755; stage "$HERE/wrapper" "$WRAPPER" 0755
  stage "$HERE/stats.js" "$VIEW" 0644; stage "$HERE/acl.json" "$ACL" 0644; stage "$HERE/zh-cn.lmo" "$LOCALE" 0644
  mv -f "$CORE.kixdns-bbolt-new" "$CORE"; mv -f "$WRAPPER.kixdns-bbolt-new" "$WRAPPER"
  mv -f "$VIEW.kixdns-bbolt-new" "$VIEW"; mv -f "$ACL.kixdns-bbolt-new" "$ACL"; mv -f "$LOCALE.kixdns-bbolt-new" "$LOCALE"
  response=$("$WRAPPER" snapshot)
  [ -n "$response" ] || fail "Snapshot returned no JSON"
  printf '%s\n' "$response" | jsonfilter -e '@.queries' >/dev/null
  printf '%s\n' "$response" | jsonfilter -e '@.hours' >/dev/null
  echo "Applied. Log out/in to LuCI for the new ACL, then hard-refresh the page."
  echo "24h total includes imported history; linked results fill as new queries arrive."
  echo "Program-only rollback: sh $BACKUP/trial.sh rollback (no old-format data conversion)."
  if command -v busybox >/dev/null 2>&1; then
   for i in 1 2 3; do KIXDNS_STATS_PROFILE=1 busybox time -f 'snapshot real=%e s' "$WRAPPER" snapshot >/dev/null; done
  fi
  ;;
 rollback)
  [ -f "$BACKUP/ready" ] || fail "No complete backup found"
  verify "$BACKUP" || fail "Backup checksum failed; no files restored"
  staging=1
  stage "$BACKUP/wrapper" "$WRAPPER" 0755; stage "$BACKUP/stats.js" "$VIEW" 0644; stage "$BACKUP/acl.json" "$ACL" 0644
  if [ -f "$BACKUP/core" ]; then stage "$BACKUP/core" "$CORE" 0755; fi
  if [ -f "$BACKUP/zh-cn.lmo" ]; then stage "$BACKUP/zh-cn.lmo" "$LOCALE" 0644; fi
  mv -f "$WRAPPER.kixdns-bbolt-new" "$WRAPPER"; mv -f "$VIEW.kixdns-bbolt-new" "$VIEW"; mv -f "$ACL.kixdns-bbolt-new" "$ACL"
  if [ -f "$BACKUP/core" ]; then mv -f "$CORE.kixdns-bbolt-new" "$CORE"; else rm -f "$CORE"; fi
  if [ -f "$BACKUP/zh-cn.lmo" ]; then mv -f "$LOCALE.kixdns-bbolt-new" "$LOCALE"; else rm -f "$LOCALE"; fi
  echo "Program files restored; databases and logs untouched. stats.db is NOT converted for old code."
  echo "Backup kept at $BACKUP. Log out/in to LuCI and hard-refresh. Do not roll back across package upgrades."
  ;;
 *) fail "usage: sh trial.sh check|apply|rollback" ;;
esac
