// Dependency-free LuCI DOM/RPC and Mermaid async regression checks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
String.prototype.format = function (value) { return this.replace(/%[ds]/, value); };

class Element {
	constructor(tag, attrs = {}) { this.tag = tag; this.attrs = attrs; this.children = []; this.text = ''; this.html = ''; }
	appendChild(child) { this.children.push(child); return child; }
	set textContent(value) { this.children = []; this.html = ''; this.text = String(value); }
	get textContent() { return this.text + this.children.map(c => c instanceof Element ? c.textContent : c).join(''); }
	set innerHTML(value) { this.children = []; this.html = String(value); }
	get innerHTML() { return this.html; }
	replaceChildren(...children) { this.children = children; }
}
// Match LuCI dom.append: strings are HTML unless passed in an array.
function E(tag, attrs, children) {
	const node = new Element(tag, attrs);
	if (Array.isArray(children)) node.children.push(...children);
	else if (children instanceof Element) node.appendChild(children);
	else if (children != null) node.innerHTML = String(children);
	return node;
}
function nodes(node) { return [node, ...node.children.filter(c => c instanceof Element).flatMap(nodes)]; }
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

async function statsTests() {
	const source = read('luci-app-kixdns/htdocs/luci-static/resources/view/kixdns/stats.js');
	const attack = '<img src=x onerror=alert(1)>';
	const stats = {
		queries: 5, cache_hits: 2, errors: 0, unique: 1, hours: [{ t: '2026-09-22T08', q: 5 }, { t: '2026-09-22T09', q: 0 }],
		top_qname: [[attack, 5]], top_client: [['192.0.2.1', 5, attack]], top_pipeline: [[attack, 5]],
		top_upstream: [[attack, 5]], qtype: { [attack]: 5 }, rcode: {}, cats: {},
		classify: { enabled: true, pending: 1 }
	};
	let callback, writable = true, queue = [], calls = [], argumentsSeen = [];
	const view = new Function('view', 'fs', 'poll', 'ui', 'L', 'E', '_', source)(
		{ extend: v => v }, { exec: (_, args) => { calls.push(args[0]); argumentsSeen.push(args); return queue.shift()(); } },
		{ add: fn => { callback = fn; } }, {}, { hasViewPermission: () => writable }, E, s => s
	);
	const result = value => () => Promise.resolve({ code: 0, stdout: JSON.stringify(value) });
	const page = view.render(stats);
	assert.ok(nodes(page).some(n => n.textContent.includes(attack)), 'show literal external text');
	assert.ok(nodes(page).every(n => !n.innerHTML.includes(attack)), 'no log/hostname strings interpreted as HTML');
	const hourButtons = nodes(page).filter(n => n.attrs.class === 'kixdns-hour');
	assert.equal(hourButtons.length, 2);
	assert.equal(hourButtons[0].attrs['aria-label'], '2026-09-22 08:00–08:59\nQueries: 5');
	assert.equal(hourButtons[1].tag, 'button', 'zero-count hour remains keyboard/pointer reachable');
	assert.equal(hourButtons[1].children[0].attrs.style, 'height:0%');
	assert.equal(hourButtons[1].children.find(n => n instanceof Element && n.attrs.role === 'tooltip').textContent, '2026-09-22 09:00–09:59\nQueries: 0');
	const classes = new Set();
	let focused = false;
	const target = { classList: { add: c => classes.add(c), remove: c => classes.delete(c) }, focus: () => { focused = true; } };
	hourButtons[0].attrs.keydown({ key: 'Escape', currentTarget: target });
	assert.ok(classes.has('kixdns-tip-hidden'), 'Escape dismisses without losing focus');
	hourButtons[0].attrs.focus({ currentTarget: target });
	assert.equal(classes.size, 0, 'focus reopens tooltip');
	hourButtons[0].attrs.click({ currentTarget: target });
	assert.equal(focused, true, 'tap focuses the hour');
	const button = nodes(page).find(n => n.tag === 'button');
	const wait = deferred();
	queue = [() => wait.promise, result({ did: 1 }), result({ ...stats, classify: { enabled: true, pending: 0 } })];
	const p1 = callback(), p2 = callback();
	assert.equal(p1, p2, 'manual refresh and poll coalesce');
	assert.equal(button.disabled, true);
	wait.resolve({ code: 0, stdout: JSON.stringify(stats) });
	await p1;
	await new Promise(setImmediate);
	assert.deepEqual(calls, ['snapshot', 'classify', 'snapshot']);
	assert.equal(button.disabled, false);
	assert.ok(nodes(page).includes(button), 'refresh does not replace focused controls');
	const lastText = page.textContent;
	queue = [() => Promise.resolve({ code: 1, stderr: attack })];
	await callback();
	const alert = nodes(page).find(n => n.attrs.role === 'alert');
	assert.equal(alert.hidden, false);
	assert.ok(alert.textContent.includes(attack));
	assert.ok(nodes(page).every(n => !n.innerHTML.includes(attack)));
	assert.ok(page.textContent.includes('40.0%'), 'failure retains last good stats instead of zeroing');
	assert.ok(lastText.includes('40.0%'));
	writable = false;
	calls = []; queue = [result(stats)];
	await callback();
	assert.deepEqual(calls, ['snapshot'], 'read-only views do not classify');
	writable = true;
	calls = []; queue = [result(stats), result({ error: 'http_429' })];
	await callback();
	await new Promise(setImmediate);
	queue = [result(stats)];
	await callback();
	assert.deepEqual(calls, ['snapshot', 'classify', 'snapshot'], 'classification errors back off');
	const slow = deferred();
	calls = []; queue = [result(stats), () => slow.promise];
	await button.attrs.click();
	assert.equal(button.disabled, false, 'refresh finishes before classification returns');
	assert.ok(nodes(page).some(n => n.attrs.role === 'status' && n.textContent === 'Classifying...'));
	queue = [result({ ...stats, queries: 6 })];
	await callback();
	assert.deepEqual(calls, ['snapshot', 'classify', 'snapshot'], 'slow classification does not block subsequent polling or launch another batch');
	queue = [result({ ...stats, queries: 6, classify: { enabled: true, pending: 0 } })];
	slow.resolve({ code: 0, stdout: JSON.stringify({ did: 1 }) });
	await new Promise(setImmediate);
	assert.equal(calls.filter(c => c === 'classify').length, 1);
	assert.equal(button.disabled, false);
	queue = [() => Promise.resolve({ code: 0, stdout: 'not json' })];
	await assert.rejects(view.load());
	queue = [result({})];
	await assert.rejects(view.load());
	writable = false;
	const form = nodes(page).find(n => n.tag === 'form');
	const client = nodes(form).find(n => n.attrs['aria-label'] === 'Client IP or hostname');
	const domain = nodes(form).find(n => n.attrs['aria-label'] === 'Domain keyword');
	const category = nodes(form).find(n => n.tag === 'select');
	const old = deferred();
	const filtered = { ...stats, queries: 3, totals: { queries: 17 }, partial: true,
		hours: [{ t: '2026-09-22T08', q: 0, partial: true }, { t: '2026-09-22T09', q: 3 }],
		coverage: { hours: [{ legacy: 9, capacity: 5 }] }, classify: { enabled: false, pending: 0 } };
	queue = [() => old.promise, result(filtered)];
	const stale = callback();
	client.value = 'laptop'; domain.value = 'ads'; category.value = 'ads';
	form.attrs.submit({ preventDefault() {} });
	old.resolve({ code: 0, stdout: JSON.stringify({ ...stats, queries: 999 }) });
	await stale;
	assert.deepEqual(JSON.parse(argumentsSeen.at(-1)[1]), { client: 'laptop', domain: 'ads', category: 'ads' });
	assert.ok(!page.textContent.includes('999'), 'old filter response cannot overwrite the newest selection');
	assert.ok(page.textContent.includes('24h total: 17'), 'full totals remain a separate reference');
	assert.equal(nodes(page).find(n => n.attrs.class === 'cbi-value-description kixdns-reference').attrs.title, 'Unaffected by filters');
	const coverage = nodes(page).find(n => n.tag === 'details');
	assert.ok(coverage && !coverage.attrs.open, 'coverage explanations start collapsed');
	assert.equal(coverage.children[0].innerHTML, 'Some hours are incomplete');
	assert.ok(coverage.textContent.includes('Historical associations unavailable.'));
	assert.ok(coverage.textContent.includes('Oldest associations removed'));
	const missing = nodes(page).find(n => (n.attrs.class || '').includes('kixdns-hour-missing'));
	assert.ok(missing.attrs['aria-label'].includes('Incomplete associations'));
	assert.ok(missing.textContent.includes('?'), 'missing zero hour is visibly unknown, not a confirmed zero');
	assert.equal(client.value, 'laptop');
	assert.ok(nodes(page).includes(client), 'refresh preserves filter controls');
	queue = [result(stats)];
	await nodes(form).find(n => n.tag === 'button' && n.attrs.type === 'button').attrs.click();
	assert.deepEqual(JSON.parse(argumentsSeen.at(-1)[1]), { client: '', domain: '', category: '' });
	assert.equal(client.value, ''); assert.equal(domain.value, ''); assert.equal(category.value, '');
	console.log('PASS: LuCI text safety, coalescing, focus, read-only, classification, hourly tooltip, linked filters, stale-filter race, coverage and reset');
}

async function mermaidTests() {
	const html = read('luci-app-kixdns/htdocs/luci-static/resources/kixdns/config_editor.html');
	assert.doesNotMatch(html, /<script\s+src="vendor\/mermaid/);
	for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(match[1]);
	const loader = html.slice(html.indexOf('                let mermaidLoading'), html.indexOf('                const setEditorTheme'));
	const renderer = html.slice(html.indexOf('                const renderFlowchart ='), html.indexOf('                // Initialize with default JSON'));
	const scripts = [], renders = [], window = {}, currentTab = { value: 'editor' }, mermaidRef = { value: new Element('div') };
	const document = { createElement: tag => ({ tag, remove() { this.removed = true; } }), head: { appendChild: s => scripts.push(s) } };
	const mermaid = { initialize() {}, render(id) { const d = deferred(); renders.push({ id, ...d }); return d.promise; } };
	const api = new Function('window', 'document', 'currentTab', 'mermaidRef', 'mermaid', `
		const nextTick = () => Promise.resolve(), darkTheme = false;
		const config = { value: { pipelines: [], pipeline_select: [] } };
		${loader}\n${renderer}\nreturn { ensureMermaid, renderFlowchart };
	`)(window, document, currentTab, mermaidRef, mermaid);
	const loading = api.ensureMermaid();
	assert.equal(api.ensureMermaid(), loading);
	assert.equal(scripts.length, 1);
	scripts[0].onerror();
	await assert.rejects(loading);
	assert.equal(scripts[0].removed, true);
	const retry = api.ensureMermaid();
	window.mermaid = mermaid; scripts[1].onload(); await retry;
	assert.equal(scripts.length, 2, 'load failure can retry');
	const first = api.renderFlowchart();
	await new Promise(setImmediate);
	const second = api.renderFlowchart();
	await new Promise(setImmediate);
	assert.notEqual(renders[0].id, renders[1].id, 'unique render ids without timestamp collisions');
	renders[1].resolve({ svg: '<svg>new</svg>' }); await second;
	renders[0].resolve({ svg: '<svg>old</svg>' }); await first;
	assert.equal(mermaidRef.value.innerHTML, '<svg>new</svg>', 'late render must not overwrite newer theme');
	const away = api.renderFlowchart();
	await new Promise(setImmediate);
	currentTab.value = 'editor'; mermaidRef.value = null;
	renders[2].resolve({ svg: '<svg>detached</svg>' }); await away;
	console.log('PASS: Mermaid lazy load, shared promise, retry, stale results, tab teardown');
}

statsTests().then(mermaidTests).catch(error => { console.error(error); process.exitCode = 1; });
