'use strict';
'require view';
'require form';
'require rpc';
'require poll';
'require fs';
'require ui';

var CONFFILE = '/etc/kixdns/pipeline.json';
var statusCss = '\
.kixdns-status-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:.75em; margin:.75em 0 1em; } \
.kixdns-status-item { padding:.75em 1em; border:1px solid rgba(127,127,127,.25); border-radius:4px; background:rgba(127,127,127,.06); } \
.kixdns-status-label { display:block; margin-bottom:.3em; opacity:.7; font-size:.9em; } \
.kixdns-status-value { font-size:1.15em; } \
@media (max-width:800px) { .kixdns-status-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }';

var callServiceList = rpc.declare({
	object: 'service',
	method: 'list',
	params: [ 'name' ],
	expect: { '': {} }
});

function getServiceStatus() {
	return L.resolveDefault(callServiceList('kixdns'), {}).then(function (res) {
		try {
			return res['kixdns']['instances']['kixdns']['running'];
		}
		catch (e) {
			return false;
		}
	});
}

function getResourceUsage() {
	return L.resolveDefault(fs.exec('/usr/libexec/kixdns-status'), { stdout: '' }).then(function (res) {
		try {
			return JSON.parse(res.stdout || '');
		}
		catch (e) {
			return { cpu: 0, memory: 0, runtime: 0, version: '' };
		}
	});
}

function renderStatus(running) {
	return running
		? E('span', { 'style': 'color:#2ea44f;font-weight:bold' }, _('RUNNING'))
		: E('span', { 'style': 'color:#d73a49;font-weight:bold' }, _('NOT RUNNING'));
}

function formatCpu(running, usage) {
	return running ? Number(usage.cpu || 0).toFixed(1) + '%' : '-';
}

function formatMemory(running, usage) {
	return running ? Number(usage.memory || 0).toFixed(1) + ' MB' : '-';
}

function formatRuntime(running, usage) {
	var seconds = Math.max(0, Number(usage.runtime || 0));
	var days = Math.floor(seconds / 86400);
	var hours = Math.floor(seconds % 86400 / 3600);
	var minutes = Math.floor(seconds % 3600 / 60);
	var secs = Math.floor(seconds % 60);
	var clock = [ hours, minutes, secs ].map(function (value) {
		return value < 10 ? '0' + value : String(value);
	}).join(':');

	return running ? (days ? days + 'd ' : '') + clock : '-';
}

function formatVersion(usage) {
	return usage.version || '-';
}

return view.extend({
	load: function () {
		return Promise.all([
			getServiceStatus(),
			getResourceUsage(),
			L.resolveDefault(fs.read(CONFFILE), '')
		]);
	},

	render: function (data) {
		var running = data[0];
		var usage = data[1];
		var binds = { udp: null, tcp: null };
		var m, s, o, configUrlOption;

		try {
			var cfg = JSON.parse(data[2]);
			binds.udp = (cfg.settings || {}).bind_udp;
			binds.tcp = (cfg.settings || {}).bind_tcp;
		}
		catch (e) { /* unreadable or invalid pipeline config */ }

		m = new form.Map('kixdns', _('KixDNS'),
			_('KixDNS is an asynchronous, non-recursive DNS forwarding server written in Rust.'));

		s = m.section(form.NamedSection, '_status');
		s.anonymous = true;
		s.render = function () {
			var statusNode = E('span', {}, renderStatus(running));
			var cpuNode = E('span', {}, formatCpu(running, usage));
			var memoryNode = E('span', {}, formatMemory(running, usage));
			var runtimeNode = E('span', {}, formatRuntime(running, usage));
			var versionNode = E('span', {}, formatVersion(usage));

			poll.add(function () {
				return Promise.all([ getServiceStatus(), getResourceUsage() ]).then(function (result) {
					running = result[0];
					usage = result[1];
					while (statusNode.firstChild)
						statusNode.removeChild(statusNode.firstChild);
					statusNode.appendChild(renderStatus(running));
					cpuNode.textContent = formatCpu(running, usage);
					memoryNode.textContent = formatMemory(running, usage);
					runtimeNode.textContent = formatRuntime(running, usage);
					versionNode.textContent = formatVersion(usage);
				});
			}, 5);

			return E('div', { 'class': 'cbi-section' }, [
				E('style', {}, statusCss),
				E('h3', {}, _('Service Status')),
				E('p', {}, [ _('Status'), ': ', statusNode ]),
				E('div', { 'class': 'kixdns-status-grid' }, [
					E('div', { 'class': 'kixdns-status-item' }, [
						E('span', { 'class': 'kixdns-status-label' }, _('CPU Usage')),
						E('strong', { 'class': 'kixdns-status-value' }, cpuNode)
					]),
					E('div', { 'class': 'kixdns-status-item' }, [
						E('span', { 'class': 'kixdns-status-label' }, _('Memory Usage')),
						E('strong', { 'class': 'kixdns-status-value' }, memoryNode)
					]),
					E('div', { 'class': 'kixdns-status-item' }, [
						E('span', { 'class': 'kixdns-status-label' }, _('Runtime')),
						E('strong', { 'class': 'kixdns-status-value' }, runtimeNode)
					]),
					E('div', { 'class': 'kixdns-status-item' }, [
						E('span', { 'class': 'kixdns-status-label' }, _('Core Version')),
						E('strong', { 'class': 'kixdns-status-value' }, versionNode)
					])
				]),
				E('p', {}, [
					_('Listening (from pipeline config)'), ': ',
					E('code', {}, 'UDP ' + (binds.udp || '?') + ' / TCP ' + (binds.tcp || '?'))
				])
			]);
		};

		s = m.section(form.NamedSection, 'main', 'kixdns', _('General Settings'));

		o = s.option(form.Flag, 'enabled', _('Enable'),
			_('Enable and start the KixDNS service.'));
		o.rmempty = false;

		o = s.option(form.Flag, 'hijack', _('DNS Hijack'),
			_('Redirect all DNS requests (port 53, UDP/TCP) from LAN clients to KixDNS via nftables. ' +
			  'The redirect target port is taken from <code>bind_udp</code> in the pipeline config.'));
		o.rmempty = false;

		o = s.option(form.Value, 'listener_label', _('Listener label'),
			_('Value passed to --listener-label for pipeline selection.'));
		o.default = 'default';
		o.placeholder = 'default';

		o = s.option(form.Value, 'udp_workers', _('UDP workers'),
			_('Number of UDP worker threads. Leave empty to use the number of CPU cores.'));
		o.datatype = 'uinteger';
		o.placeholder = _('auto');

		o = s.option(form.Value, 'geoip_download_url', _('GeoIP download URL'),
			_('Download a V2Ray GeoIP database to <code>/etc/kixdns/geoip.dat</code> before each service start. ' +
			  'Leave empty to disable downloading.'));
		o.datatype = 'url';
		o.placeholder = 'https://example.com/geoip.dat';

		configUrlOption = s.option(form.Value, 'config_download_url', _('Configuration download URL'),
			_('KixDNS always uses the local <code>/etc/kixdns/pipeline.json</code>. The remote file is downloaded ' +
			  'only when you click "Update configuration".'));
		configUrlOption.datatype = 'url';
		configUrlOption.placeholder = 'https://example.com/pipeline.json';

		o = s.option(form.Button, '_update_config', _('Remote configuration'),
			_('Download from the URL above, validate the JSON, and replace the local configuration now. ' +
			  'The original file is kept as <code>/etc/kixdns/pipeline.json.bak</code>.'));
		o.inputtitle = _('Update configuration');
		o.inputstyle = 'apply';
		o.depends('config_download_url', /.+/);
		o.onclick = function (ev, sectionId) {
			var url = String(configUrlOption.formvalue(sectionId) || '').trim();

			if (!url) {
				ui.addNotification(null, E('p', _('Enter a configuration download URL first.')), 'error');
				return Promise.resolve();
			}

			function runInitCommand(args) {
				return fs.exec('/etc/init.d/kixdns', args).then(function (res) {
					if (!res || res.code !== 0) {
						var detail = String((res && (res.stderr || res.stdout)) || '').trim();
						throw new Error(detail || _('Configuration update failed'));
					}
					return res;
				});
			}

			return runInitCommand([ 'update_config', url ])
				.then(function () { return runInitCommand([ 'reload' ]); })
				.then(function () {
					ui.addNotification(null,
						E('p', _('Configuration updated and KixDNS restarted.')), 'info');
				})
				.catch(function (e) {
					ui.addNotification(null,
						E('p', _('Configuration update failed') + ': ' + e.message), 'error');
				});
		};

		o = s.option(form.Value, 'rust_log', _('Log filter'),
			_('Tracing filter passed via the <code>RUST_LOG</code> environment variable.'));
		o.default = 'error,kixdns::engine::matcher_adapter=info';
		o.value('error,kixdns::engine::matcher_adapter=info', _('Errors + matcher logs (recommended)'));
		o.value('error', _('Errors only'));
		o.value('info', _('Info'));
		o.value('debug', _('Debug'));

		o = s.option(form.Flag, 'debug', _('Debug logging'),
			_('Pass --debug to the daemon.'));
		o.rmempty = false;

		o = s.option(form.Value, 'log_size', _('Log size limit (KB)'),
			_('When the log file exceeds this size, it is cleared.'));
		o.datatype = 'uinteger';
		o.default = '1024';
		o.placeholder = '1024';

		return m.render();
	}
});
