'use strict';
'require view';
'require fs';
'require poll';
'require ui';

var css = '\
.kixdns-log-wrap { background:#1e1e1e; color:#d4d4d4; border-radius:4px; padding:8px 10px; \
	font-family:Consolas,Menlo,monospace; font-size:12px; line-height:1.55; \
	overflow:auto; max-height:70vh; white-space:pre; } \
.kixdns-log-line { display:block; } \
.kixdns-log-line.lvl-warn { background:rgba(210,153,34,.12); } \
.kixdns-log-line.lvl-error { background:rgba(215,58,73,.18); } \
.kx-syslog { color:#6a737d; } \
.kx-ts { color:#569cd6; } \
.kx-event { color:#c586c0; } \
.kx-rule { color:#dcdcaa; } \
.kx-qname { color:#4ec9b0; font-weight:bold; } \
.kx-ip { color:#9cdcfe; } \
.kx-key { color:#808080; } \
.kx-lvl-info { color:#2ea44f; font-weight:bold; } \
.kx-lvl-warn { color:#d29922; font-weight:bold; } \
.kx-lvl-error { color:#f85149; font-weight:bold; } \
.kx-lvl-debug { color:#8b949e; }';

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

function getRule(line) {
	var match = /(?:^|\s)rule=(?:"([^"]*)"|(\S+))/.exec(line);
	return match ? (match[1] != null ? match[1] : match[2]) : null;
}

/* Tokenize one log line into highlighted HTML */
function highlightLine(line) {
	var lvl = 'info';
	var lm = /level="?(\w+)"?/.exec(line);
	if (lm)
		lvl = lm[1].toLowerCase();
	else if (/\bERROR\b|\berror\b/.test(line))
		lvl = 'error';
	else if (/\bWARN(ING)?\b|\bwarn\b/.test(line))
		lvl = 'warn';

	var html = escapeHTML(line)
		/* optional syslog prefix: "Mon Jul 20 01:15:22 2026 daemon.info kixdns[1615]:" */
		.replace(/^(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4}\s+\S+\s+kixdns\[\d+\]:)/,
			'<span class="kx-syslog">$1</span>')
		/* ISO timestamp */
		.replace(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/,
			'<span class="kx-ts">$1</span>')
		/* key=value tokens */
		.replace(/\bevent=(&quot;[^&]*&quot;|\S+)/,
			'<span class="kx-key">event=</span><span class="kx-event">$1</span>')
		.replace(/\brule=(\S+)/,
			'<span class="kx-key">rule=</span><span class="kx-rule">$1</span>')
		.replace(/\bqname=(\S+)/,
			'<span class="kx-key">qname=</span><span class="kx-qname">$1</span>')
		.replace(/\bclient_ip=(\S+)/,
			'<span class="kx-key">client_ip=</span><span class="kx-ip">$1</span>')
		.replace(/\blevel=(&quot;)?(\w+)(&quot;)?/,
			'<span class="kx-key">level=</span>$1<span class="kx-lvl-' +
				(/^(info|warn|error|debug|trace)$/.test(lvl) ? lvl : 'info') + '">$2</span>$3');

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
			return fs.write(LOGFILE, '')
				.then(refresh)
				.catch(function (e) { ui.addNotification(null, E('p', e.message), 'error'); });
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
				_('Log file: %s (cleared on service start if oversized, kept out of the system log).').format('<code>' + escapeHTML(LOGFILE) + '</code>')),
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
