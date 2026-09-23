'use strict';
'require view';
'require fs';
'require poll';

var css = '\
.kixdns-stats-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:.75em; margin:.75em 0 1em; } \
.kixdns-stats-item { padding:.75em 1em; border:1px solid rgba(127,127,127,.25); border-radius:4px; background:rgba(127,127,127,.06); } \
.kixdns-stats-label { display:block; margin-bottom:.3em; opacity:.7; font-size:.9em; } \
.kixdns-stats-value { font-size:1.15em; } \
.kixdns-hours { display:flex; align-items:flex-end; gap:2px; height:72px; margin:.35em 0 0; } \
.kixdns-hour { position:relative; display:flex; align-items:flex-end; flex:1; min-width:0; height:100%; margin:0; padding:0; border:0; border-radius:0; background:transparent; color:inherit; box-shadow:none; cursor:help; } \
.kixdns-hour:hover { background:rgba(46,164,79,.12); } \
.kixdns-hour-missing { background:repeating-linear-gradient(135deg,transparent,transparent 4px,#8c959f33 4px,#8c959f33 6px); } \
.kixdns-hour-unknown { position:absolute; bottom:0; width:100%; text-align:center; font-size:11px; } \
.kixdns-filters { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)) auto; gap:.65em; align-items:end; margin:1em 0; } \
.kixdns-filters label { display:flex; flex-direction:column; gap:.3em; min-width:0; } \
.kixdns-filters input,.kixdns-filters select { width:100%; min-width:0; box-sizing:border-box; } \
.kixdns-coverage { padding:.65em; border-left:3px solid #bf8700; background:#bf870014; } \
.kixdns-hour:focus-visible { outline:2px solid currentColor; outline-offset:-2px; } \
.kixdns-hour-bar { display:block; width:100%; background:#2ea44f; border-radius:2px 2px 0 0; } \
.kixdns-hour-tip { display:none; position:absolute; bottom:100%; left:50%; transform:translateX(-50%); z-index:10; width:max-content; max-width:min(15rem,65vw); padding:6px 8px; border-radius:4px; background:#24292f; color:#fff; box-shadow:0 2px 6px #0003; font:12px/1.5 sans-serif; text-align:left; white-space:pre-line; } \
.kixdns-hour-tip-left { left:0; transform:none; } \
.kixdns-hour-tip-right { left:auto; right:0; transform:none; } \
.kixdns-hour:not(.kixdns-tip-hidden):hover .kixdns-hour-tip, .kixdns-hour:not(.kixdns-tip-hidden):focus .kixdns-hour-tip { display:block; } \
.kixdns-hours-range { opacity:.7; font-size:.9em; margin:.2em 0; } \
.kixdns-hours-axis { display:flex; gap:2px; margin:.15em 0 1em; font-size:10px; opacity:.65; } \
.kixdns-hours-axis span { flex:1; text-align:center; overflow:hidden; white-space:nowrap; } \
.kixdns-bar-row { display:flex; align-items:center; gap:.5em; margin:.25em 0; font-size:.92em; } \
.kixdns-bar-row em { flex:0 1 12em; min-width:0; font-style:normal; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } \
.kixdns-bar-row i { flex:1; min-width:1em; height:.65em; background:rgba(127,127,127,.15); border-radius:3px; display:block; } \
.kixdns-bar-row i b { display:block; height:100%; background:#2ea44f; border-radius:3px; } \
.kixdns-bar-row strong { flex:0 0 auto; text-align:right; font-weight:normal; } \
.kixdns-cat { flex:0 0 auto; max-width:7em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding:0 .4em; border-radius:3px; font-size:.85em; } \
.kixdns-stats-cols { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:1em; } \
.kixdns-stats-cols > div { min-width:0; } \
.kixdns-stats-actions { display:flex; gap:.5em; flex-wrap:wrap; align-items:center; margin:.5em 0; } \
@media (max-width:800px) { .kixdns-filters { grid-template-columns:1fr; } .kixdns-stats-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } .kixdns-stats-cols { grid-template-columns:1fr; } }';

var CAT_COLOR = {
	ads: '#d73a49', trackers: '#a84200', malware: '#6f42c1', phishing: '#cb2431',
	adult: '#a82f77', social: '#0366d6', cdn: '#6a737d', pcdn: '#1b7c83', p2p: '#9a3412', gaming: '#9a6700',
	cloud: '#3b64d4', captive: '#57606a', ai: '#8250df', update: '#1a7f37',
	streaming: '#6f42c1', ok: '#1a7f37', lan: '#57606a', pending: '#57606a'
};

function statsCommand(command, filters) {
	var args = [ command ];
	if (filters) args.push(JSON.stringify(filters));
	return fs.exec('/usr/libexec/kixdns-stats', args).then(function (res) {
		if (!res || res.code !== 0)
			throw new Error((res && res.stderr) || _('Statistics request failed'));
		var data = JSON.parse(res.stdout);
		if (!data || typeof data !== 'object')
			throw new Error(_('Statistics request failed'));
		if (data.error)
			throw new Error(data.error);
		return data;
	});
}

function fetchStats(filters) {
	return statsCommand('snapshot', filters).then(function (data) {
		if (typeof data.queries !== 'number' || !Array.isArray(data.hours))
			throw new Error(_('Statistics request failed'));
		return data;
	});
}

function pct(part, total) {
	return total ? (100 * part / total).toFixed(part % total === 0 ? 0 : 1) + '%' : '0%';
}

function catLabel(id) {
	return ({
		ads: _('Ads'), trackers: _('Trackers'), malware: _('Malware'),
		phishing: _('Phishing'), adult: _('Adult'), social: _('Social'),
		cdn: _('CDN'), pcdn: _('PCDN'), p2p: _('P2P'), gaming: _('Gaming'),
		cloud: _('Cloud'), captive: _('Captive'), ai: _('AI'),
		update: _('Updates'), streaming: _('Streaming'),
		ok: _('Ordinary'), lan: _('Intranet'), pending: _('Unclassified')
	})[id] || id;
}

function barList(rows, showCategory) {
	var max = rows.reduce(function (m, row) { return Math.max(m, row[1]); }, 1);
	return E('div', {}, rows.length ? rows.map(function (row) {
		var cat = row[2] || 'pending', color = CAT_COLOR[cat] || '#57606a';
		var cells = [
			// LuCI treats a bare child string as HTML; arrays create text nodes.
			E('em', {}, [ row[0] ]),
			E('i', { 'aria-hidden': 'true' }, E('b', { 'style': 'width:' + (100 * row[1] / max).toFixed(1) + '%;background:' + color })),
			E('strong', {}, [ String(row[1]) ])
		];
		if (showCategory)
			cells.push(E('span', { 'class': 'kixdns-cat', 'style': 'background:' + color + ';color:#fff' }, [ catLabel(cat) ]));
		return E('div', { 'class': 'kixdns-bar-row', 'title': typeof row[3] === 'string' ? row[3] : row[0] }, cells);
	}) : [ E('p', { 'class': 'cbi-value-description' }, _('None')) ]);
}

function hourClock(t) {
	return String(t || '').split('T').pop() + ':00';
}

function hoursChart(hours) {
	var max = hours.reduce(function (m, h) { return Math.max(m, h.q); }, 1);
	var range = hours.length ? hours[0].t.replace('T', ' ') + ':00 – ' + hours[hours.length - 1].t.replace('T', ' ') + ':00' : '';
	return E('div', {}, [
		E('div', { 'class': 'kixdns-hours-range' }, [ range ]),
		E('div', { 'class': 'kixdns-hours', 'role': 'group', 'aria-label': _('Queries (24h)') }, hours.map(function (h, idx) {
			// Use router-local hour strings, not the browser's timezone.
			var label = String(h.t).replace('T', ' ') + ':00–' + hourClock(h.t).slice(0, 2) + ':59\n' + (h.partial ? _('Retained queries') : _('Queries')) + ': ' + Number(h.q || 0).toLocaleString();
			if (h.partial) label += '\n' + _('Incomplete associations; this is not a complete hourly count.');
			function showTip(ev) { ev.currentTarget.classList.remove('kixdns-tip-hidden'); }
			return E('button', {
				'class': 'kixdns-hour' + (h.partial ? ' kixdns-hour-missing' : ''), 'type': 'button', 'data-hour-index': idx, 'aria-label': label,
				'mouseenter': showTip, 'focus': showTip,
				'click': function (ev) { showTip(ev); ev.currentTarget.focus(); },
				'keydown': function (ev) {
					if (ev.key === 'Escape') ev.currentTarget.classList.add('kixdns-tip-hidden');
				}
			}, [
				E('span', { 'class': 'kixdns-hour-bar', 'aria-hidden': 'true', 'style': 'height:' + (h.q ? Math.max(4, 100 * h.q / max).toFixed(1) : '0') + '%' }),
				h.partial && !h.q ? E('span', { 'class': 'kixdns-hour-unknown', 'aria-hidden': 'true' }, [ '?' ]) : '',
				E('span', { 'class': 'kixdns-hour-tip' + (idx < hours.length / 3 ? ' kixdns-hour-tip-left' : idx >= hours.length * 2 / 3 ? ' kixdns-hour-tip-right' : ''), 'role': 'tooltip', 'aria-hidden': 'true' }, [ label ])
			]);
		})),
		E('div', { 'class': 'kixdns-hours-axis', 'aria-hidden': 'true' }, hours.map(function (h, idx) {
			return E('span', {}, [ (idx % 4 === 0 || idx === hours.length - 1) ? hourClock(h.t).slice(0, 2) : '' ]);
		}))
	]);
}

function objectRows(obj) {
	return Object.keys(obj || {}).map(function (k) { return [ k, obj[k] ]; })
		.sort(function (a, b) { return b[1] - a[1] || a[0].localeCompare(b[0]); });
}

return view.extend({
	load: function () { return fetchStats(); },

	render: function (data) {
		var stats = data, request = null, classifying = false, nextClassify = 0, painted = null;
		var filters = { client: '', domain: '', category: '' }, filterRevision = 0;
		var body = E('div'), errorNode = E('p', { 'role': 'alert', 'hidden': true });
		var clientInput = E('input', { 'type': 'search', 'maxlength': 256, 'aria-label': _('Client IP or hostname'), 'placeholder': _('Client IP or hostname') });
		var domainInput = E('input', { 'type': 'search', 'maxlength': 256, 'aria-label': _('Domain keyword'), 'placeholder': _('Domain keyword') });
		var categoryInput = E('select', { 'aria-label': _('Category') }, [ E('option', { 'value': '' }, _('All categories')) ].concat(Object.keys(CAT_COLOR).map(function (id) {
			return E('option', { 'value': id }, [ catLabel(id) ]);
		})));
		function applyFilters(reset) {
			if (reset) { clientInput.value = ''; domainInput.value = ''; categoryInput.value = ''; }
			var next = { client: (clientInput.value || '').trim(), domain: (domainInput.value || '').trim(), category: categoryInput.value || '' };
			if (JSON.stringify(next) !== JSON.stringify(filters)) {
				filters = next;
				filterRevision++;
				// Never label the preceding response as the newly selected filter.
				body.hidden = true;
			}
			return refresh(true);
		}
		var filterForm = E('form', { 'class': 'kixdns-filters', 'submit': function (ev) { ev.preventDefault(); return applyFilters(false); } }, [
			E('label', {}, [ _('Client'), clientInput ]), E('label', {}, [ _('Domain'), domainInput ]),
			E('label', {}, [ _('Category'), categoryInput ]),
			E('div', { 'class': 'kixdns-stats-actions' }, [
				E('button', { 'class': 'btn cbi-button cbi-button-action', 'type': 'submit' }, _('Apply filters')),
				E('button', { 'class': 'btn', 'type': 'button', 'click': function () { return applyFilters(true); } }, _('Clear filters'))
			])
		]);
		var statusNode = E('span', { 'role': 'status' });
		var refreshButton = E('button', {
			'class': 'btn cbi-button cbi-button-action', 'type': 'button',
			'click': function () { nextClassify = 0; return refresh(); }
		}, _('Refresh'));

		function card(label, value) {
			return E('div', { 'class': 'kixdns-stats-item' }, [
				E('span', { 'class': 'kixdns-stats-label' }, label),
				E('strong', { 'class': 'kixdns-stats-value' }, [ value ])
			]);
		}

		function section(title, content) {
			return E('div', { 'class': 'cbi-section' }, [ E('h3', {}, title), content ]);
		}

		function setStatus() {
			var cls = stats.classify || {};
			statusNode.textContent = classifying ? _('Classifying...') :
				(cls.enabled ? _('Classify pending (%d)').format(cls.pending || 0) : '');
		}

		function paint(s) {
			stats = s;
			var cls = stats.classify || {};
			setStatus();
			var serialized = JSON.stringify(s);
			if (serialized === painted) return;
			painted = serialized;
			var active = typeof document !== 'undefined' && document.activeElement;
			var hourFocus = active && body.contains(active) ? active.getAttribute('data-hour-index') : null;
			var tipHidden = hourFocus != null && active.classList.contains('kixdns-tip-hidden');
			body.textContent = '';
			body.appendChild(E('h3', {}, _('Filter results')));
			body.appendChild(E('div', { 'class': 'kixdns-stats-grid' }, [
				card(_('Queries'), String(stats.queries || 0)),
				card(_('Cache hit rate'), pct(stats.cache_hits || 0, stats.queries || 0)),
				card(_('Errors'), String(stats.errors || 0)),
				card(_('Unique domains'), String(stats.unique || 0))
			]));
			if (stats.totals)
				body.appendChild(E('p', { 'class': 'cbi-value-description kixdns-reference', 'title': _('Unaffected by filters') }, [ _('24h total: %s').format(Number(stats.totals.queries || 0).toLocaleString()) ]));
			if (stats.partial) {
				var gaps = (stats.coverage && stats.coverage.hours) || [];
				var reasons = [];
				if (gaps.some(function (h) { return h.legacy > 0; })) reasons.push(_('Some associations are unavailable.'));
				if (gaps.some(function (h) { return h.capacity > 0; })) reasons.push(_('Oldest associations removed at the storage limit.'));
				if (gaps.some(function (h) { return h.unsupported > 0; })) reasons.push(_('Some records could not be associated.'));
				body.appendChild(E('details', { 'class': 'kixdns-coverage' }, [
					E('summary', {}, _('Some hours are incomplete')),
					E('p', {}, [ reasons.join(' ') ])
				]));
			}
			body.appendChild(section(_('Queries (24h)'), hoursChart(stats.hours || [])));
			var cats = objectRows(stats.cats).map(function (row) { return [ catLabel(row[0]), row[1], row[0] ]; });
			if (cats.length) body.appendChild(section(_('Categories'), barList(cats)));
			body.appendChild(E('div', { 'class': 'kixdns-stats-cols' }, [
				section(_('Top domains'), barList(stats.top_qname || [], cls.enabled)),
				section(_('Top clients'), barList((stats.top_client || []).map(function (row) {
					return [ row[2] || row[0], row[1], null, row[2] ? row[0] + ' ' + row[2] : row[0] ];
				}))),
				section(_('Top upstreams'), barList(stats.top_upstream || [])),
				section(_('Pipelines'), barList(stats.top_pipeline || [])),
				section(_('Query types'), barList(objectRows(stats.qtype))),
				section(_('Response codes'), barList(objectRows(stats.rcode)))
			]));
			if (hourFocus != null) {
				var nextHour = body.querySelectorAll('.kixdns-hour')[Number(hourFocus)];
				if (nextHour) {
					nextHour.focus({ preventScroll: true });
					if (tipHidden) nextHour.classList.add('kixdns-tip-hidden');
				}
			}
		}

		function showError(e) {
			errorNode.textContent = _('Statistics request failed') + ': ' + e.message;
			errorNode.hidden = false;
		}

		function startClassification() {
			var cls = stats.classify || {};
			if (classifying || !L.hasViewPermission() || !cls.enabled || !cls.pending || Date.now() < nextClassify) return;
			classifying = true;
			nextClassify = Date.now() + 300000;
			setStatus();
			// Detached from refresh/poll completion. One batch at a time, even while
			// users keep refreshing; failures retain the existing quota backoff.
			Promise.resolve().then(function () {
				return statsCommand('classify');
			}).then(function (out) {
				if (out.did > 0) nextClassify = 0;
				// Wait out any older snapshot, then refresh without starting another batch.
				return Promise.resolve(request).then(function () { return refresh(true); });
			}).catch(showError).finally(function () {
				classifying = false;
				setStatus();
			});
		}

		function refresh(skipClassify) {
			if (request) return request;
			refreshButton.disabled = true;
			errorNode.hidden = true;
			var revision = filterRevision;
			request = fetchStats(filters).then(function (s) {
				if (revision !== filterRevision) return;
				paint(s);
				body.hidden = false;
				if (skipClassify !== true) startClassification();
			}).catch(function (e) {
				if (revision === filterRevision) showError(e);
			}).finally(function () {
				request = null;
				refreshButton.disabled = false;
				if (revision !== filterRevision) return refresh(skipClassify);
			});
			return request;
		}

		paint(stats);
		poll.add(refresh, 10);
		return E('div', { 'class': 'cbi-map' }, [
			E('style', {}, css), E('h2', {}, _('KixDNS - Stats')),
			E('div', { 'class': 'kixdns-stats-actions' }, [ refreshButton, statusNode ]),
			filterForm,
			errorNode, body
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
