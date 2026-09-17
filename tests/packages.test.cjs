// Offline regression checks: real archive recipe and installer, mocked download/package managers.
// Run with: node tests/packages.test.cjs (requires Bash, tar, find, and coreutils).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const bash = process.env.TEST_BASH || (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
const justfile = fs.readFileSync(path.join(root, 'Justfile'), 'utf8');
const recipe = /^package-output arch release package_ext:\r?\n((?:[ \t].*(?:\r?\n|$))+)/m.exec(justfile);
assert.ok(recipe, 'package-output recipe must exist');
const installer = fs.readFileSync(path.join(root, 'install.sh'), 'utf8')
	.replaceAll('/etc/openwrt_release', './openwrt_release');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kixdns-packages-'));

function run(script, cwd, env = {}) {
	const result = spawnSync(bash, ['-eu', '-o', 'pipefail', '-c', script], {
		cwd, encoding: 'utf8', env: { ...process.env, ...env }
	});
	if (result.error) throw result.error;
	return result;
}
function success(result) {
	assert.equal(result.status, 0, result.stdout + result.stderr);
	return result.stdout;
}
function install(cwd, ext, channel, expected, warning = false, languages = ['zh-cn', 'fr', 'pt-br']) {
	fs.rmSync(path.join(cwd, 'installed-args'), { force: true });
	const result = run(`
		curl() { printf '%s' "$4" > download-url; cp fixture.tar.gz "$3"; }
		opkg() {
			if [ "$1" = list-installed ]; then printf '%s\\n' "$TEST_INSTALLED_PACKAGES" | sed 's/$/ - 1.0/';
			else printf '%s\\n' "$@" > installed-args; fi
		}
		apk() {
			if [ "$1" = info ]; then printf '%s\\n' "$TEST_INSTALLED_PACKAGES";
			else printf '%s\\n' "$@" > installed-args; fi
		}
		${installer}
	`, cwd, {
		KIXDNS_RELEASE_TAG: channel,
		TEST_INSTALLED_PACKAGES: ['base-files', 'luci-app-kixdns', 'luci-i18n-other-de',
			...languages.map(language => 'luci-i18n-base-' + language)].join('\n')
	});
	if (!expected) {
		assert.notEqual(result.status, 0, 'Incomplete archive must fail installation');
		assert.ok(!fs.existsSync(path.join(cwd, 'installed-args')), 'Do not install partial packages');
		return;
	}
	success(result);
	const args = fs.readFileSync(path.join(cwd, 'installed-args'), 'utf8').trim().split('\n');
	const flags = ext === 'ipk' ? ['install'] : ['add', '--allow-untrusted'];
	assert.deepEqual(args.splice(0, flags.length), flags);
	assert.deepEqual(args.map(name => path.posix.basename(name)).sort(), expected.slice().sort());
	assert.equal(result.stderr.includes('installing without translations'), warning);
	const url = fs.readFileSync(path.join(cwd, 'download-url'), 'utf8');
	assert.ok(url.includes(channel === 'latest' ? '/releases/latest/download/' : '/releases/download/rolling/'));
}

try {
	for (const [ext, release, separator] of [['ipk', '24.10', '_'], ['apk', '25.12', '-']]) {
		const cwd = path.join(temp, ext);
		const packageDir = path.join(cwd, 'bin/packages/x86_64/kixdns');
		fs.mkdirSync(packageDir, { recursive: true });
		fs.writeFileSync(path.join(cwd, 'openwrt_release'), `DISTRIB_RELEASE='${release}.1'\nDISTRIB_ARCH='x86_64'\n`);
		const names = ['kixdns', 'luci-app-kixdns', 'luci-i18n-kixdns-zh-cn', 'luci-i18n-kixdns-fr', 'luci-i18n-kixdns-pt-br']
			.map(name => `${name}${separator}1.5.5-r1${separator}all.${ext}`);
		for (const language of ['zh_Hans', 'fr', 'pt_BR', 'templates']) {
			const dir = path.join(cwd, 'luci-app-kixdns/po', language);
			fs.mkdirSync(dir, { recursive: true });
			// Multiple catalogs in a language still produce one translation package.
			for (const file of ['kixdns.po', 'extra.po']) fs.writeFileSync(path.join(dir, file), 'fixture');
		}
		for (const name of names) fs.writeFileSync(path.join(packageDir, name), 'fixture');
		const unrelated = [`unrelated${separator}1.0.${ext}`, `luci-i18n-other-zh-cn${separator}1.0.${ext}`];
		for (const name of unrelated) fs.writeFileSync(path.join(packageDir, name), 'ignore');
		const values = { arch: 'x86_64', release, package_ext: ext };
		const command = recipe[1].replace(/^    @?/gm, '').replace(/{{(\w+)}}/g, (_, key) => values[key]);
		success(run(command, cwd));
		const archive = `kixdns_x86_64-openwrt-${release}.tar.gz`;
		const entries = success(run(`tar -tzf ${archive}`, cwd)).trim().split('\n')
			.filter(name => name !== './').map(name => name.replace(/^\.\//, '')).sort();
		assert.deepEqual(entries, names.slice().sort(), 'Publish the core, LuCI, and all application translations');
		fs.copyFileSync(path.join(cwd, archive), path.join(cwd, 'fixture.tar.gz'));
		for (const channel of ['latest', 'rolling']) install(cwd, ext, channel, names);
		for (const [language, index] of [['zh-cn', 2], ['fr', 3], ['pt-br', 4]])
			install(cwd, ext, 'latest', names.slice(0, 2).concat(names[index]), false, [language]);
		install(cwd, ext, 'latest', names.slice(0, 2), true, []);
		install(cwd, ext, 'latest', names.slice(0, 2), true, ['de']);
		install(cwd, ext, 'latest', names.slice(0, 2), true, ['pt']); // Must not match pt-br.
		success(run(`tar -czf fixture.tar.gz -C bin/packages/x86_64/kixdns ${names.concat(unrelated).join(' ')}`, cwd));
		install(cwd, ext, 'rolling', names); // Ignore unrelated packages even if present in an archive.

		// Older two-package releases remain installable, with an explicit translation warning.
		success(run(`tar -czf fixture.tar.gz -C bin/packages/x86_64/kixdns ${names.slice(0, 2).join(' ')}`, cwd));
		install(cwd, ext, 'latest', names.slice(0, 2), true);
		for (const missing of names.slice(0, 2)) {
			success(run(`tar -czf fixture.tar.gz -C bin/packages/x86_64/kixdns ${names.filter(n => n !== missing).join(' ')}`, cwd));
			install(cwd, ext, 'rolling', null);
		}

		fs.unlinkSync(path.join(cwd, archive));
		for (const missing of names.slice(2)) {
			fs.unlinkSync(path.join(packageDir, missing));
			const result = run(command, cwd);
			assert.notEqual(result.status, 0, 'A partial set of translations must fail publication');
			assert.match(result.stderr, /3 translation packages.*found 2 translations/);
			assert.ok(!fs.existsSync(path.join(cwd, archive)));
			fs.writeFileSync(path.join(packageDir, missing), 'fixture');
		}
		for (const name of names.slice(2)) fs.unlinkSync(path.join(packageDir, name));
		assert.notEqual(run(command, cwd).status, 0, 'Missing all translations must fail publication');
		assert.ok(!fs.existsSync(path.join(cwd, archive)));
		console.log(`PASS: ${ext} all translations archived, base-language selection, locale boundaries, unrelated packages excluded, legacy fallback, missing packages`);
	}
} finally {
	fs.rmSync(temp, { recursive: true, force: true });
}
