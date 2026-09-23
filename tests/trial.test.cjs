// Offline trial-script checks. All absolute router paths are rebound to a temp root.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
assert.equal(process.platform, 'linux', 'Run this suite in Linux/WSL');
const source = fs.readFileSync(path.join(__dirname, '../kixdns-stats/trial.sh'), 'utf8');
const nativeCore = fs.readFileSync(process.env.KIXDNS_STATS_CORE);
const oldWrapper = '#!/bin/sh\n[ "${FAIL_FOLD:-0}" != 1 ] || exit 1\n';
const newWrapper = '#!/bin/sh\n[ "${BAD_SMOKE:-0}" != 1 ] || exit 0\nprintf \'{"queries":1,"hours":[]}\\n\'\n';
for (const scenario of ['absent-core', 'existing-core', 'checksum', 'checkpoint', 'staging', 'empty-smoke']) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kixdns-trial-test-'));
	try {
		const root = dir + '/root', payload = dir + '/payload', bin = dir + '/bin';
		const core = root + '/usr/libexec/kixdns-stats-core';
		const wrapper = root + '/usr/libexec/kixdns-stats';
		const view = root + '/www/luci-static/resources/view/kixdns/stats.js';
		const backup = root + '/etc/kixdns/bbolt-trial-backup';
		const acl = root + '/usr/share/rpcd/acl.d/luci-app-kixdns.json';
		const locale = root + '/usr/share/luci/i18n/kixdns.zh-cn.lmo';
		for (const d of [path.dirname(core), path.dirname(view), path.dirname(backup), path.dirname(acl), path.dirname(locale), payload, bin, root + '/tmp/kixdns-stats']) fs.mkdirSync(d, { recursive: true });
		const write = (f, s) => fs.writeFileSync(f, s, { mode: 0o755 });
		write(wrapper, oldWrapper); write(view, 'original view'); write(acl, 'original ACL');
		if (scenario === 'existing-core') write(locale, 'original translation');
		if (scenario === 'existing-core') write(core, 'old native core');
		const data = root + '/tmp/kixdns-stats/stats.db';
		write(data, 'live counters must survive');
		write(root + '/tmp/kixdns.log', 'original log');
		write(bin + '/id', '#!/bin/sh\necho 0\n');
		write(bin + '/uname', '#!/bin/sh\necho aarch64\n');
		write(bin + '/cp', '#!/bin/sh\nif [ "${FAIL_STAGE:-0}" = 1 ]; then\n for arg do case "$arg" in */stats.js.kixdns-bbolt-new) exit 1;; esac; done\nfi\nexec /bin/cp "$@"\n');
		write(bin + '/jsonfilter', `#!${process.execPath}\nconst fs=require('fs'),a=process.argv.slice(2); const s=JSON.parse(fs.readFileSync(0,'utf8')); const v=a[a.indexOf('-e')+1].slice(2).split('.').reduce((v,k)=>v?.[k],s); if(v===undefined)process.exit(1); console.log(typeof v==='object'?JSON.stringify(v):String(v));\n`);
		const files = {
			core: nativeCore, wrapper: newWrapper, 'stats.js': 'new view', 'acl.json': 'new ACL', 'zh-cn.lmo': 'new translation',
			'trial.sh': source.replace(/^CORE=.+$/m, 'CORE=' + core).replace(/^WRAPPER=.+$/m, 'WRAPPER=' + wrapper).replace(/^VIEW=.+$/m, 'VIEW=' + view).replace(/^BACKUP=.+$/m, 'BACKUP=' + backup).replace(/^ACL=.+$/m, 'ACL=' + acl).replace(/^LOCALE=.+$/m, 'LOCALE=' + locale)
		};
		for (const [name, text] of Object.entries(files)) write(payload + '/' + name, text);
		write(payload + '/MD5SUMS', Object.entries(files).map(([n, s]) => crypto.createHash('md5').update(s).digest('hex') + '  ' + n).join('\n') + '\n');
		const env = { ...process.env, PATH: bin + ':' + process.env.PATH,
			FAIL_FOLD: scenario === 'checkpoint' ? '1' : '0', FAIL_STAGE: scenario === 'staging' ? '1' : '0', BAD_SMOKE: scenario === 'empty-smoke' ? '1' : '0' };
		if (scenario === 'checksum') write(payload + '/core', 'corrupt');
		const run = (script, command) => spawnSync('/bin/sh', [script, command], { env, encoding: 'utf8', timeout: 10000 });
		let r = run(payload + '/trial.sh', 'apply');
		assert.equal(r.status === 0, ['absent-core', 'existing-core'].includes(scenario), scenario + ': ' + r.stdout + r.stderr);
		if (['checksum', 'checkpoint', 'staging'].includes(scenario)) {
			assert.equal(fs.readFileSync(wrapper, 'utf8'), oldWrapper);
			assert.equal(fs.readFileSync(view, 'utf8'), 'original view');
			assert.equal(fs.existsSync(core), false);
		} else {
			assert.equal(fs.readFileSync(wrapper, 'utf8'), newWrapper);
			assert.deepEqual(fs.readFileSync(core), nativeCore);
			assert.equal(fs.readFileSync(acl, 'utf8'), 'new ACL');
			assert.equal(fs.readFileSync(locale, 'utf8'), 'new translation');
			// Updating reuses the original backup; it must never save the trial over it.
			const beforeBackup = fs.readFileSync(backup + '/MD5SUMS');
			const repeated = run(payload + '/trial.sh', 'apply');
			assert.equal(repeated.status === 0, scenario !== 'empty-smoke', repeated.stdout + repeated.stderr);
			assert.deepEqual(fs.readFileSync(backup + '/MD5SUMS'), beforeBackup);
			assert.equal(fs.readFileSync(backup + '/wrapper', 'utf8'), oldWrapper);
			r = run(backup + '/trial.sh', 'rollback');
			assert.equal(r.status, 0, r.stdout + r.stderr);
			assert.equal(fs.readFileSync(wrapper, 'utf8'), oldWrapper);
			assert.equal(fs.readFileSync(view, 'utf8'), 'original view');
			assert.equal(fs.existsSync(core), scenario === 'existing-core');
			assert.equal(fs.readFileSync(acl, 'utf8'), 'original ACL');
			assert.equal(fs.existsSync(locale), scenario === 'existing-core');
			if (scenario === 'existing-core') assert.equal(fs.readFileSync(locale, 'utf8'), 'original translation');
			if (scenario === 'existing-core') assert.equal(fs.readFileSync(core, 'utf8'), 'old native core');
		}
		assert.equal(fs.readFileSync(data, 'utf8'), 'live counters must survive');
		assert.equal(fs.readFileSync(root + '/tmp/kixdns.log', 'utf8'), 'original log');
		assert.equal(fs.existsSync(core + '.kixdns-bbolt-new'), false);
		console.log('PASS: trial ' + scenario);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
