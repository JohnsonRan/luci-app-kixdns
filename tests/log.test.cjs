const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const source = read('luci-app-kixdns/htdocs/luci-static/resources/view/kixdns/log.js');
new Function(source); // LuCI modules use a top-level return.
const { highlightLine, getRule } = new Function(
	source.slice(0, source.indexOf('return view.extend(')) +
	'return { highlightLine, getRule };'
)();

const response = '2026-09-17 11:16:38 forwarded event="dns_response" upstream=doh:dns.google/dns-query qname=api.msn.com qtype=AAAA rcode=NoError latency_ms=5 client_ip=192.168.1.110 pipeline=global_doh cache=true resp_match=false transport=Some(Udp)';
const matcher = '2026-09-17 11:16:38 event="matcher_log" rule=global_doh_forward qname=api.msn.com client_ip=192.168.1.110 level="info"';
const special = String.raw`2026-09-17T11:16:38.123+08:00 WARN message="rule=fake event=\"<img src=x onerror=alert(1)>\" & '" rule="real rule" constructor=unknown`;

function plainText(html) {
	const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
	return html.replace(/<\/?span\b[^>]*>/g, '').replace(/&(amp|lt|gt|quot|#39);/g, entity => entities[entity]);
}

for (const line of [response, matcher, special, '', 'plain <script>alert(1)</script>',
	'event="a&b" rule="quote\\\"inside" level="<bad>"',
	'Mon Jul 20 01:15:22 2026 daemon.info kixdns[1615]: 2026-07-20T01:15:22Z INFO ready']) {
	const html = highlightLine(line);
	assert.equal(plainText(html), line, 'Formatting must preserve all log text');
	assert.doesNotMatch(html, /<(?!\/?span\b)/, 'Only generated span tags allowed');
	assert.equal((html.match(/<span\b/g) || []).length, (html.match(/<\/span>/g) || []).length);
}

for (const [key, cls] of Object.entries({
	upstream: 'ip', qname: 'qname', qtype: 'event', rcode: 'lvl-info',
	latency_ms: 'number', client_ip: 'ip', pipeline: 'rule', cache: 'bool',
	resp_match: 'bool', transport: 'event'
})) {
	assert.ok(highlightLine(response).includes(`>${key}=</span><span class="kx-${cls}">`), key);
}
assert.equal(getRule(matcher), 'global_doh_forward');
assert.equal(getRule(special), 'real rule');
assert.equal(getRule('message="has rule=fake inside"'), null);
assert.equal(getRule(response), null);
assert.match(highlightLine(special), /kixdns-log-line lvl-warn/);
assert.match(highlightLine('2026-09-17 11:16:38 ERROR failed'), /kixdns-log-line lvl-error/);
assert.match(highlightLine('level="WARNING" message="slow"'), /kixdns-log-line lvl-warn/);
assert.match(highlightLine('qname=error.example level="invalid"'), /kixdns-log-line lvl-info/);
assert.match(highlightLine('rcode=ServFail'), /kx-lvl-warn/);
assert.match(highlightLine('event="matcher_log" level="debug"'), /kx-lvl-debug/);
assert.match(highlightLine('message="qname=example event=bad"'), /kx-value/);
assert.doesNotMatch(highlightLine('message="qname=example event=bad"'), /kx-qname|kx-event/);

const filter = 'warn,kixdns::engine::matcher_adapter=info,kixdns::engine::phases=info';
for (const file of [
	'luci-app-kixdns/root/etc/config/kixdns',
	'luci-app-kixdns/root/etc/init.d/kixdns',
	'luci-app-kixdns/htdocs/luci-static/resources/view/kixdns/overview.js'
]) {
	assert.ok(read(file).includes(`'${filter}'`), `${file}: default filter`);
	assert.ok(!read(file).includes('error,kixdns::engine::matcher_adapter=info'), `${file}: stale filter`);
}
console.log('PASS: log formatting, escaping, levels, rule parsing, and default filters');
