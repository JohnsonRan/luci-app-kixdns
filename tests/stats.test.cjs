// Offline integration checks. Requires Linux, POSIX tools, Node and the native Go core.
// Set KIXDNS_STATS_CORE to the compiled helper; on Windows run this suite in WSL.
// TypeSafe transport is always mocked; response JSON is parsed by the real Go core.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const core = process.env.KIXDNS_STATS_CORE;
assert.ok(process.platform === 'linux' && core && fs.existsSync(core),
	'Run on Linux/WSL with KIXDNS_STATS_CORE pointing to the compiled Go helper');
const bash = process.env.TEST_BASH || '/bin/bash';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kixdns stats '));
const unix = p => path.resolve(p).replace(/\\/g, '/').replace(process.platform === 'win32' ? /^([A-Za-z]):/ : /$^/, (_, d) => '/' + d.toLowerCase());
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
const scriptPath = path.join(root, 'luci-app-kixdns/root/usr/libexec/kixdns-stats');
const script = 'sh ' + quote(unix(scriptPath));
const bin = path.join(temp, 'bin');
fs.mkdirSync(bin);

function tool(name, code) {
	fs.writeFileSync(path.join(bin, name + '.cjs'), code);
	fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexec ' + quote(unix(process.execPath)) + ' ' + quote(unix(path.join(bin, name + '.cjs'))) + ' "$@"\n', { mode: 0o755 });
}
tool('uci', 'process.exit(1);');
fs.writeFileSync(path.join(bin, 'date'), '#!/bin/sh\ncase "$1" in +%s) printf "%s\\n" "$TEST_EPOCH" ;; *) exec /usr/bin/date "$@" ;; esac\n', { mode: 0o755 });
tool('curl', `
const fs = require('fs'), path = require('path'), a = process.argv.slice(2);
const state = process.env.TEST_STATE, countFile = path.join(state, 'calls');
const count = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0;
fs.writeFileSync(countFile, String(count + 1));
const req = JSON.parse(fs.readFileSync(a[a.indexOf('--data-binary') + 1].slice(1), 'utf8'));
fs.writeFileSync(path.join(state, 'request.json'), JSON.stringify(req));
fs.writeFileSync(path.join(state, 'curl-args.json'), JSON.stringify(a));
const mode = process.env.TEST_HTTP || '200';
if (mode === 'slow') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
if (count === 0 && (mode === '429' || mode === '000')) {
 fs.writeFileSync(a[a.indexOf('-D') + 1], 'Retry-After: 0\\r\\n');
 process.stdout.write(mode);
 process.exit(mode === '000' ? 7 : 0);
}
const response = path.join(state, 'response.json');
const answers = Object.fromEntries(Object.keys(req.questions).map(k => [k, {choice: 'ok', confidence: .91}]));
fs.writeFileSync(a[a.indexOf('-o') + 1], fs.existsSync(response) ? fs.readFileSync(response) : JSON.stringify({model: 'jev-test', answers}));
process.stdout.write(mode === '401' ? mode : '200');
`);

const epoch = Math.floor(Date.now() / 3600000) * 3600 + 1800;
const hour = new Date(epoch * 1000).toISOString().slice(0, 13);
const line = (q, extra = '') => `${hour}:16:38Z forwarded event="dns_response" qname=${q} qtype=A rcode=NoError ${extra}\n`;
let sequence = 0;
function fixture() {
	const dir = path.join(temp, String(++sequence));
	fs.mkdirSync(dir);
	const state = path.join(dir, 'state'), log = path.join(dir, 'log');
	fs.mkdirSync(state);
	fs.writeFileSync(log, '');
	const env = {
		...process.env, TZ: 'UTC0', PATH: unix(bin) + ':/usr/bin:/bin:' +
			(process.platform === 'win32' ? '/c/Program Files/Git/usr/bin:' : '') + (process.env.PATH || ''),
		KIXDNS_STATS_CORE: core, KIXDNS_NOW: String(epoch),
		KIXDNS_LOG: unix(log), KIXDNS_STATEDIR: unix(state), KIXDNS_PERSISTDIR: unix(path.join(dir, 'persist')),
		KIXDNS_TYPESAFE_KEY: '', KIXDNS_TYPESAFE_URL: 'https://invalid.test/mocked', KIXDNS_CLASSIFY_BATCH: '16',
		KIXDNS_DHCP_LEASES: unix(path.join(dir, 'leases')), KIXDNS_HOSTS: unix(path.join(dir, 'hosts')),
		KIXDNS_ODHCPD: unix(path.join(dir, 'odhcp')), TEST_STATE: state, TEST_HTTP: '200', TEST_EPOCH: String(epoch)
	};
	function shell(command) {
		const r = spawnSync(bash, ['-eu', '-o', 'pipefail', '-c', command], { env, encoding: 'utf8', timeout: 30000 });
		if (r.error) throw r.error;
		return r;
	}
	function exec(args = 'snapshot') {
		const r = shell(script + ' ' + args);
		assert.equal(r.status, 0, args + ': ' + r.stdout + r.stderr);
		return r.stdout.trim() ? JSON.parse(r.stdout) : null;
	}
	return { dir, state, log, env, shell, exec,
		append: text => fs.appendFileSync(log, text),
		response: value => fs.writeFileSync(path.join(state, 'response.json'), typeof value === 'string' ? value : JSON.stringify(value, null, 2)),
		calls: () => Number(fs.existsSync(path.join(state, 'calls')) && fs.readFileSync(path.join(state, 'calls'), 'utf8'))
	};
}

try {
	const portable = fixture();
	portable.append(line('portable-a.example'));
	assert.equal(portable.exec().queries, 1);
	assert.ok(!fs.existsSync(path.join(portable.state, 'stats.tsv')), 'bbolt has no runtime TSV mirror');
	const portableBin = path.join(portable.dir, 'bin');
	fs.mkdirSync(portableBin);
	for (const name of ['sh', 'awk', 'chmod', 'cmp', 'cp', 'flock', 'head', 'ls', 'md5sum', 'mkdir', 'mv', 'rm', 'sort', 'tail', 'tr', 'wc']) {
		const resolved = portable.shell('command -v ' + name);
		assert.equal(resolved.status, 0, name + ': ' + resolved.stderr);
		fs.writeFileSync(path.join(portableBin, name), '#!/bin/sh\nexec ' + quote(resolved.stdout.trim()) + ' "$@"\n', { mode: 0o755 });
	}
	const fullPath = portable.env.PATH;
	portable.env.PATH = unix(bin) + ':' + unix(portableBin);
	assert.equal(portable.shell('command -v stat || command -v cksum || true').stdout, '', 'optional applets really are absent');
	assert.equal(portable.exec().queries, 1, 'native cursor must not replay when optional applets are missing');
	const idlePortable = portable.shell('sh -x ' + quote(unix(scriptPath)) + ' snapshot');
	assert.equal(idlePortable.status, 0, idlePortable.stderr);
	assert.doesNotMatch(idlePortable.stderr, /^\++ (?:ingest_awk|sort) /m, 'snapshot delegates to native code, not shell aggregation');
	portable.append(line('portable-b.example'));
	assert.equal(portable.exec().queries, 2);
	fs.writeFileSync(portable.log, line('portable-c.example') + line('portable-d.example'));
	assert.equal(portable.exec().queries, 4, 'same-size truncate/regrow without stat or cksum');
	const rotatedContents = fs.readFileSync(portable.log);
	fs.renameSync(portable.log, portable.log + '.old');
	fs.writeFileSync(portable.log, rotatedContents);
	assert.equal(portable.exec().queries, 6, 'inode replacement with identical content must still be detected');
	portable.exec('fold');
	fs.rmSync(portable.state, { recursive: true });
	assert.equal(portable.exec().queries, 6, 'stat-less checkpoint restore');
	portable.exec('clear');
	assert.equal(fs.readFileSync(portable.log, 'utf8'), '');
	portable.append(line('portable-e.example'));
	assert.equal(portable.exec().queries, 7);
	portable.env.PATH = fullPath;
	fs.writeFileSync(portable.log, line('portable-f.example'));
	assert.equal(portable.exec().queries, 8, 'rewrite after clear');
	console.log('PASS: missing stat/cksum, native idle path, same-size rewrite, inode replacement, persistence');

	const f = fixture();
	fs.writeFileSync(path.join(f.dir, 'leases'), '0 aa:bb:cc:dd:ee:ff 192.168.1.110 iPhone *\n');
	f.append(line('API.MSN.COM.', 'cache=true client_ip=192.168.1.110 pipeline=global_doh upstream=doh:dns.google'));
	f.append(line('api.msn.com').replace('qtype=A', 'qtype=AAAA'));
	f.append(line('bad.example').replace('rcode=NoError', 'rcode=ServFail'));
	f.append(`${hour}:00:00Z message="event=\\"dns_response\\" qname=fake.example" event="matcher_log"\n`);
	const first = f.exec();
	assert.equal(first.queries, 3);
	assert.equal(first.cache_hits, 1);
	assert.equal(first.errors, 1);
	assert.equal(first.unique, 2);
	assert.equal(first.hours.length, 24);
	assert.equal(first.hours.reduce((n, h) => n + h.q, 0), 3);
	assert.deepEqual(first.top_qname[0], ['api.msn.com', 2]);
	assert.deepEqual(first.top_client[0], ['192.168.1.110', 1, 'iPhone']);
	assert.deepEqual(first.qtype, { A: 2, AAAA: 1 });
	assert.equal(first.rcode.ServFail, 1);
	assert.equal(first.classify.enabled, false);
	assert.equal(first.classify.pending, 2);
	assert.deepEqual(f.exec(), first, 'repeat snapshot must not replay');
	const filtered = f.exec('snapshot ' + quote(JSON.stringify({ client: 'iPhone', domain: 'msn', category: 'pending' })));
	assert.equal(filtered.queries, 1);
	assert.equal(filtered.totals.queries, 3, 'whole-window reference is not filtered');
	assert.equal(filtered.hours.reduce((n, h) => n + h.q, 0), 1);
	assert.deepEqual(filtered.top_qname[0], ['api.msn.com', 1]);
	assert.equal(f.exec('snapshot ' + quote(JSON.stringify({ domain: "' OR 1=1 --" }))).queries, 0, 'filter parameters are data');
	const unchangedLog = fs.readFileSync(f.log);
	assert.notEqual(f.shell(script + ' snapshot ' + quote('{"command":"clear"}')).status, 0, 'unsupported filter field is rejected');
	assert.deepEqual(fs.readFileSync(f.log), unchangedLog, 'invalid filter cannot clear the log');
	f.append(line('appended.example'));
	assert.equal(f.exec().queries, 4, 'first appended complete line must not be skipped');
	const partial = line('partial.example');
	f.append(partial.slice(0, -5));
	assert.equal(f.exec().queries, 4, 'partial record waits for newline');
	f.append(partial.slice(-5));
	assert.equal(f.exec().queries, 5, 'completed partial record is counted exactly once');
	assert.equal(f.exec().queries, 5);
	f.exec('fold');
	const persist = path.join(f.dir, 'persist/stats.db');
	const mtime = fs.statSync(persist).mtimeMs;
	const checkpoint = fs.readFileSync(persist);
	f.exec('fold');
	assert.deepEqual(fs.readFileSync(persist), checkpoint, 'idle checkpoint contents must be stable');
	assert.equal(fs.statSync(persist).mtimeMs, mtime, 'unchanged checkpoint must not rewrite flash');
	fs.rmSync(f.state, { recursive: true });
	assert.equal(f.exec().queries, 5, 'checkpoint includes cursor, not just counters');
	f.exec('clear');
	assert.equal(fs.readFileSync(f.log, 'utf8'), '');
	f.append(line('after-clear.example'));
	assert.equal(f.exec().queries, 6);
	fs.writeFileSync(f.log, line('regrown.example').repeat(10));
	assert.equal(f.exec().queries, 16, 'copy-truncate/regrow above old size must not lose records');
	fs.renameSync(f.log, f.log + '.old');
	f.append(line('rotated.example').repeat(11));
	assert.equal(f.exec().queries, 27, 'inode replacement must reset cursor');
	console.log('PASS: log fields, increment, partial lines, prune, rotation, checkpoint cursor, idle writes');

	const idle = fixture();
	idle.append(line('idle-a.example', 'client_ip=192.0.2.1'));
	const idleStats = idle.exec();
	const live = path.join(idle.state, 'stats.db');
	const stableState = fs.readFileSync(live), stableMtime = fs.statSync(live).mtimeMs;
	const trace = idle.shell('sh -x ' + quote(unix(scriptPath)) + ' snapshot');
	assert.equal(trace.status, 0, trace.stderr);
	assert.deepEqual(JSON.parse(trace.stdout), idleStats);
	assert.doesNotMatch(trace.stderr, /^\++ (?:ingest_awk|sort) /m, 'idle polls do not run shell aggregation');
	assert.deepEqual(fs.readFileSync(live), stableState);
	assert.equal(fs.statSync(live).mtimeMs, stableMtime, 'idle state file is untouched');
	fs.writeFileSync(path.join(idle.dir, 'leases'), '0 aa:bb:cc:dd:ee:ff 192.0.2.1 new-host *\n');
	idle.env.KIXDNS_TYPESAFE_KEY = 'test';
	const refreshed = idle.exec();
	assert.equal(refreshed.top_client[0][2], 'new-host', 'idle fast path still refreshes DHCP names');
	assert.equal(refreshed.classify.enabled, true, 'idle fast path still reads classification settings');
	idle.response({answers:{cat:{choice:'cdn',confidence:.9}}});
	assert.equal(idle.exec('classify idle-a.example').did, 1);
	assert.equal(idle.exec().top_qname[0][2], 'cdn', 'idle fast path sees database classification updates');
	assert.ok(!fs.existsSync(path.join(idle.state, 'classify.tsv')), 'no runtime TSV cache');
	assert.ok(!fs.existsSync(path.join(idle.dir, 'persist/classify.tsv')), 'no persistent TSV cache');
	fs.writeFileSync(idle.log, line('idle-b.example', 'client_ip=192.0.2.1'));
	assert.equal(idle.exec().queries, 2, 'same-size rewrite must not take the idle fast path');
	assert.equal(idle.exec().queries, 2, 'updated database cursor must not replay');

	const rollover = fixture();
	const oldest = new Date((epoch - 23 * 3600) * 1000).toISOString().slice(0, 13);
	rollover.append(line('old.example').replace(hour, oldest) + line('current.example'));
	assert.equal(rollover.exec().queries, 2);
	rollover.env.KIXDNS_NOW = rollover.env.TEST_EPOCH = String(epoch + 3600);
	assert.equal(rollover.exec().queries, 1, 'hour change expires old counters even without new log data');
	assert.ok(!rollover.exec().top_qname.some(row => row[0] === 'old.example'));
	rollover.env.KIXDNS_NOW = rollover.env.TEST_EPOCH = String(epoch + 24 * 3600);
	assert.equal(rollover.exec().queries, 0, 'clock jump invalidates the entire old window');
	console.log('PASS: stable idle database, fresh metadata, same-size rewrite, hour rollover');

	const bounded = fixture();
	bounded.append(Array.from({ length: 110 }, (_, i) => line(`domain${i}.example`)).join(''));
	assert.equal(bounded.exec().unique, 110);
	bounded.append(Array.from({ length: 110 }, (_, i) => line(`new${i}.example`)).join(''));
	const bs = bounded.exec();
	assert.equal(bs.queries, 220);
	assert.equal(bs.unique, 220, 'joint statistics are not truncated at the retired 100-key cap');
	assert.equal(bs.partial, undefined, 'small complete data set has no capacity gap');
	const concurrent = fixture();
	concurrent.append(line('parallel.example').repeat(20));
	let r = concurrent.shell(`${script} snapshot > /dev/null &\np1=$!\n${script} fold &\np2=$!\n${script} snapshot > /dev/null &\np3=$!\nwait "$p1"; wait "$p2"; wait "$p3"`);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(concurrent.exec().queries, 20, 'parallel folds must neither replay nor drop counts');
	const failure = fixture();
	failure.append(line('keep.example'));
	fs.writeFileSync(path.join(failure.dir, 'persist'), 'not a directory');
	r = failure.shell(script + ' clear');
	assert.notEqual(r.status, 0, 'failed persistence must fail clear');
	assert.ok(fs.readFileSync(failure.log, 'utf8').includes('keep.example'), 'keep source log on checkpoint failure');
	console.log('PASS: bounded aggregation, concurrent access, fail-closed log clear');

	const c = fixture();
	c.append(line('hot.example').repeat(5) + line('mid.example').repeat(2) + line('skip.example') + line('api.hot.example'));
	assert.equal(c.exec('classify').error, 'no_key');
	c.env.KIXDNS_TYPESAFE_KEY = 'test-secret';
	for (const q of ['.', 'bad name', 'a..example', '-bad.example', 'bad-.example', 'x'.repeat(64) + '.example', 'a.example\nb.example'])
		assert.equal(c.exec('classify ' + quote(q)).error, 'bad_qname', q);
	assert.equal(c.exec('classify not-in-stats.example').error, 'not_in_stats');
	assert.equal(c.calls(), 0);
	// Out of order, pretty-printed JSON, missing answer and unrelated nested choices.
	c.response({ model: 'jev-test', decoy: { choice: 'malware' }, answers: {
		d2: { choice: 'nope', confidence: .8 }, d1: { type: 'choice', confidence: .75, choice: 'cdn' },
		d0: { choice: 'ads', confidence: .9 }
	} });
	assert.equal(c.exec('classify').did, 2);
	assert.equal(c.calls(), 1);
	const req = JSON.parse(fs.readFileSync(path.join(c.state, 'request.json'), 'utf8'));
	assert.deepEqual(req.state.domains, ['hot.example', 'mid.example', 'skip.example']);
	const cs = c.exec(), by = Object.fromEntries(cs.top_qname.map(row => [row[0], row]));
	assert.equal(by['hot.example'][2], 'ads');
	assert.equal(by['mid.example'][2], 'cdn');
	assert.equal(by['api.hot.example'][2], 'ads');
	assert.equal(by['skip.example'].length, 2);
	assert.equal(cs.classify.pending, 1);
	assert.ok(!fs.readFileSync(path.join(c.state, 'curl-args.json'), 'utf8').includes('test-secret'), 'no key in process arguments');
	assert.ok(!fs.readdirSync(c.state).some(name => /^classify\.(body|req)[.-]/.test(name)), 'clean temporary credentials');
	c.exec('fold');
	assert.equal(c.calls(), 1, 'fold must never make a network request');
	fs.rmSync(c.state, { recursive: true });
	assert.equal(c.exec().classify.pending, 1, 'classification cache survives reboot');
	for (const response of ['{"answers":', { answers: { d0: { choice: 'ads', confidence: 9 } } }, { answers: { d1: { choice: 'ads', confidence: .7 } } }]) {
		c.response(response);
		assert.equal(c.exec('classify').error, 'bad_response');
		assert.equal(c.exec().classify.pending, 1);
	}
	c.response({ answers: { cat: { choice: 'ok', confidence: 1e-7 } }, decoy: { choice: 'malware' } });
	assert.equal(c.exec('classify SKIP.EXAMPLE.').conf, 1e-7);
	assert.equal(c.exec('check').qname, 'example.com');
	console.log('PASS: domain validation, Go JSON validation, batch mapping, bad responses, unified cache, key handling');

	const inheritance = fixture();
	inheritance.env.KIXDNS_TYPESAFE_KEY = 'test';
	inheritance.append(['cdn.example.com', 'img.cdn.example.com', 'a.img.cdn.example.com', 'other.example.com',
		'www.example.com', 'example.com', 'printer.lan', 'nas.local', 'time.home.arpa', 'router'].map(q => line(q)).join(''));
	fs.writeFileSync(path.join(inheritance.state, 'classify.tsv'), 'cdn.example.com\tcdn\t0.90\tjev-test\ncom\tmalware\t0.99\tjev-test\n');
	const before = inheritance.exec();
	assert.equal(before.classify.pending, 3);
	assert.equal(before.cats.cdn, 3);
	assert.equal(before.cats.lan, 4);
	assert.equal(inheritance.exec('classify').did, 1);
	const after = inheritance.exec();
	assert.equal(after.classify.pending, 0);
	assert.equal(after.cats.cdn, 3, 'nearest cached parent wins');
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(inheritance.state, 'request.json'), 'utf8')).state.domains, ['example.com']);
	for (const mode of ['429', '000']) {
		const retry = fixture();
		retry.env.KIXDNS_TYPESAFE_KEY = 'test'; retry.env.TEST_HTTP = mode;
		retry.append(line('retry.example'));
		assert.equal(retry.exec('classify').did, 1);
		assert.equal(retry.calls(), 2, mode + ' retries once');
	}
	const slow = fixture();
	slow.env.KIXDNS_TYPESAFE_KEY = 'test'; slow.env.TEST_HTTP = 'slow';
	slow.append(line('slow.example'));
	r = slow.shell(`${script} classify > "$KIXDNS_STATEDIR/first" &\npid=$!\nfor i in $(seq 1 100); do [ ! -f "$KIXDNS_STATEDIR/calls" ] || break; sleep .05; done\n${script} classify > "$KIXDNS_STATEDIR/second"\n${script} snapshot > "$KIXDNS_STATEDIR/snapshot"\nwait "$pid"`);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(JSON.parse(fs.readFileSync(path.join(slow.state, 'second'), 'utf8')).error, 'busy');
	assert.equal(JSON.parse(fs.readFileSync(path.join(slow.state, 'snapshot'), 'utf8')).queries, 1);
	assert.equal(slow.calls(), 1, 'parallel classification must not spend API quota twice');
	console.log('PASS: suffix inheritance, LAN privacy, rate-limit/network retry, classification lock');

	const acl = JSON.parse(fs.readFileSync(path.join(root, 'luci-app-kixdns/root/usr/share/rpcd/acl.d/luci-app-kixdns.json'), 'utf8'))['luci-app-kixdns'];
	assert.deepEqual(acl.read.file['/usr/libexec/kixdns-stats snapshot'], ['exec']);
	assert.equal(acl.read.file['/usr/libexec/kixdns-stats'], undefined);
	assert.equal(acl.read.file['/tmp/kixdns-stats/*'], undefined);
	assert.deepEqual(acl.write.file['/usr/libexec/kixdns-stats clear'], ['exec']);
	const init = fs.readFileSync(path.join(root, 'luci-app-kixdns/root/etc/init.d/kixdns'), 'utf8');
	assert.match(init, /kixdns-stats fold/);
	assert.match(init, /kixdns-stats clear/);
	assert.doesNotMatch(init.slice(init.indexOf('start_service()')), /kixdns-stats classify/);
	const syntax = f.shell('sh -n ' + quote(unix(scriptPath)));
	assert.equal(syntax.status, 0, syntax.stderr);
	console.log('PASS: restricted RPC commands, lifecycle integration, POSIX syntax');
} finally {
	fs.rmSync(temp, { recursive: true, force: true });
}
