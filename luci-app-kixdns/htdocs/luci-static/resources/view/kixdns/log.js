'use strict';
'require view';
'require fs';
'require poll';
'require ui';

var css = '\
.kixdns-log-wrap { background:#1e1e1e; color:#d4d4d4; border-radius:4px; padding:8px 10px; \
	font-family:Consolas,Menlo,monospace; font-size:12px; line-height:1.55; \
	overflow:auto; max-height:70vh; white-space:pre; } \
.kixdns-log-line { display:block; padding:2px 0; border-bottom:1px solid #383838; } \
.kixdns-log-line.lvl-warn { background:rgba(210,153,34,.12); } \
.kixdns-log-line.lvl-error { background:rgba(215,58,73,.18); } \
.kx-syslog { color:#9da5ae; } \
.kx-ts { color:#569cd6; white-space:nowrap; } \
.kx-event { color:#c586c0; } \
.kx-rule { color:#dcdcaa; } \
.kx-qname { color:#4ec9b0; font-weight:bold; } \
.kx-ip { color:#9cdcfe; } \
.kx-key { color:#a0a0a0; } \
.kx-number { color:#ce9178; } \
.kx-bool { color:#c586c0; } \
.kx-lvl-info { color:#73c991; font-weight:bold; } \
.kx-lvl-warn { color:#d29922; font-weight:bold; } \
.kx-lvl-error { color:#f85149; font-weight:bold; } \
.kx-lvl-debug, .kx-lvl-trace { color:#9da5ae; }';

var LOGFILE = '/tmp/kixdns.log';

function fetchLog() {
	return L.resolveDefault(
		fs.exec_direct('/usr/libexec/kixdns-tail-log', []), '');
}

function escapeHTML(s) {
	return s.replace(/[&<>"']/g, function (c) {
		return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
	});
}

function getFields(line) {
	var re = /(^|\s)([A-Za-z_][\w.]*)=("(?:\\.|[^"\\])*"|\S+)/g;
	var fields = [], match;
	while ((match = re.exec(line)) !== null)
		fields.push(match);
	return fields;
}

function getRule(line) {
	var fields = getFields(line);
	for (var i = 0; i < fields.length; i++) {
		if (fields[i][2] === 'rule')
			return fields[i][3].replace(/^"|"$/g, '');
	}
	return null;
}

function highlightText(text) {
	return escapeHTML(text)
		.replace(/^(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4}\s+\S+\s+kixdns\[\d+\]:)/,
			'<span class="kx-syslog">$1</span>')
		.replace(/(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/g,
			'<span class="kx-ts">$1 $2</span>');
}

/* Parse raw tokens once; never run token regexes over generated HTML. */
function highlightLine(line) {
	var fields = getFields(line);
	var header = line.slice(0, fields.length ? fields[0].index : line.length);
	var lm = /(?:^|\s)(ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE)(?=\s|$)/.exec(header);
	var lvl = lm ? lm[1].toLowerCase().replace('warning', 'warn') : 'info';
	var classes = {
		event: 'kx-event', rule: 'kx-rule', qname: 'kx-qname', client_ip: 'kx-ip',
		upstream: 'kx-ip', pipeline: 'kx-rule', qtype: 'kx-event', transport: 'kx-event',
		latency_ms: 'kx-number', cache: 'kx-bool', resp_match: 'kx-bool'
	};
	var html = '', offset = 0;

	fields.forEach(function (field) {
		var key = field[2], value = field[3];
		var plain = value.replace(/^"|"$/g, '');
		var cls = Object.prototype.hasOwnProperty.call(classes, key) ? classes[key] : 'kx-value';
		if (key === 'level' && /^(info|warn|warning|error|debug|trace)$/i.test(plain)) {
			lvl = plain.toLowerCase().replace('warning', 'warn');
			cls = 'kx-lvl-' + lvl;
		}
		else if (key === 'rcode') {
			cls = plain === 'NoError' ? 'kx-lvl-info' : 'kx-lvl-warn';
		}

		html += highlightText(line.slice(offset, field.index) + field[1]);
		html += '<span class="kx-field"><span class="kx-key">' + escapeHTML(key) +
			'=</span><span class="' + cls + '">' + escapeHTML(value) + '</span></span>';
		offset = field.index + field[0].length;
	});
	html += highlightText(line.slice(offset));

	return '<span class="kixdns-log-line lvl-' + lvl + '">' + html + '</span>';
}

return view.extend({
	load: function () {
		return fetchLog();
	},

	render: function (logdata) {
		var logNode = E('div', { 'class': 'kixdns-log-wrap', 'id': 'kixdns-log' });
		var filterInput = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'style': 'width:20em',
			'placeholder': _('Filter (domain, IP, rule ...)')
		});
		var ruleFilter = E('select', {
			'class': 'cbi-input-select',
			'style': 'max-width:20em'
		}, [
			E('option', { 'value': '' }, _('All rules'))
		]);
		var countSel = E('select', { 'class': 'cbi-input-select' }, [
			E('option', { 'value': '100' }, '100'),
			E('option', { 'value': '300', 'selected': 'selected' }, '300'),
			E('option', { 'value': '1000' }, '1000'),
			E('option', { 'value': '0' }, _('All'))
		]);
		var autoRefresh = E('input', { 'type': 'checkbox', 'checked': 'checked' });
		var lineCount = E('em', {});
		var ruleOptionsKey = null;

		function updateRuleOptions(lines) {
			var selected = ruleFilter.value;
			var seen = Object.create(null);

			lines.forEach(function (line) {
				var rule = getRule(line);
				if (rule != null)
					seen[rule] = true;
			});

			var rules = Object.keys(seen).sort();
			var key = rules.join('\x00') + '\x01' + (selected && !seen[selected] ? selected : '');
			if (key === ruleOptionsKey)
				return;

			ruleOptionsKey = key;
			ruleFilter.textContent = '';
			ruleFilter.appendChild(E('option', { 'value': '' }, _('All rules')));

			if (selected && !seen[selected])
				rules.unshift(selected);

			rules.forEach(function (rule) {
				ruleFilter.appendChild(E('option', { 'value': rule }, rule));
			});
			ruleFilter.value = selected;
		}

		function renderLog(data) {
			var lines = (data || '')
				.replace(/\x1b\[[0-9;]*m/g, '')
				.split('\n')
				.filter(function (l) { return l.trim().length; });
			var hasLogEntries = lines.length > 0;

			updateRuleOptions(lines);

			var selectedRule = ruleFilter.value;
			if (selectedRule)
				lines = lines.filter(function (l) { return getRule(l) === selectedRule; });

			var f = filterInput.value.trim().toLowerCase();
			if (f)
				lines = lines.filter(function (l) { return l.toLowerCase().indexOf(f) !== -1; });

			var max = +countSel.value;
			var total = lines.length;
			if (max > 0 && lines.length > max)
				lines = lines.slice(-max);
			lines.reverse();

			var stick = (logNode.scrollTop <= 20);

			if (lines.length) {
				logNode.innerHTML = lines.map(highlightLine).join('');
			}
			else if (hasLogEntries) {
				logNode.innerHTML = '<span class="kx-syslog">' +
					_('No log entries match the current filters.') + '</span>';
			}
			else {
				logNode.innerHTML = '<span class="kx-syslog">' +
					_('No log entries in %s.').format(escapeHTML(LOGFILE)) +
					'</span>';
			}

			lineCount.textContent = ' ' + _('%d shown / %d matched').format(Math.min(max || total, total), total);

			if (stick)
				logNode.scrollTop = 0;
		}

		var lastData = logdata;

		function refresh() {
			return fetchLog().then(function (data) {
				lastData = data;
				renderLog(data);
			});
		}

		function clearLog() {
			return fs.exec('/usr/libexec/kixdns-stats', [ 'clear' ])
				.then(function (res) {
					if (!res || res.code !== 0)
						throw new Error((res && res.stderr) || _('Failed to save statistics; log was not cleared.'));
					return refresh();
				})
				.catch(function (e) { ui.addNotification(null, E('p', {}, [ e.message ]), 'error'); });
		}

		poll.add(function () {
			if (autoRefresh.checked)
				return refresh();
			return Promise.resolve();
		}, 5);

		filterInput.addEventListener('input', function () { renderLog(lastData); });
		ruleFilter.addEventListener('change', function () { renderLog(lastData); });
		countSel.addEventListener('change', function () { renderLog(lastData); });

		requestAnimationFrame(function () {
			renderLog(lastData);
			logNode.scrollTop = 0;
		});

		return E('div', { 'class': 'cbi-map' }, [
			E('style', {}, css),
			E('h2', {}, _('KixDNS - Log')),
			E('div', { 'class': 'cbi-map-descr' },
				_('Log file: %s').format('<code>' + escapeHTML(LOGFILE) + '</code>')),
			E('div', { 'class': 'cbi-section' }, [
				E('div', { 'style': 'display:flex;align-items:center;gap:.75em;flex-wrap:wrap;margin-bottom:.5em' }, [
					filterInput,
					E('label', {}, [ _('Rule'), ' ', ruleFilter ]),
					E('label', {}, [ _('Lines'), ' ', countSel ]),
					E('label', {}, [ autoRefresh, ' ', _('Auto refresh') ]),
					E('button', {
						'class': 'btn cbi-button cbi-button-action',
						'click': ui.createHandlerFn(this, refresh)
					}, _('Refresh')),
					E('button', {
						'class': 'btn cbi-button cbi-button-remove',
						'disabled': !L.hasViewPermission(),
						'click': ui.createHandlerFn(this, clearLog)
					}, _('Clear log')),
					lineCount
				]),
				logNode
			])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
