'use strict';
'require view';
'require form';
'require rpc';
'require poll';
'require fs';
'require ui';

var CONFFILE = '/etc/kixdns/pipeline.json';

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

function renderStatus(running) {
	return running
		? E('span', { 'style': 'color:#2ea44f;font-weight:bold' }, _('RUNNING'))
		: E('span', { 'style': 'color:#d73a49;font-weight:bold' }, _('NOT RUNNING'));
}

return view.extend({
	load: function () {
		return Promise.all([
			getServiceStatus(),
			L.resolveDefault(fs.read(CONFFILE), '')
		]);
	},

	render: function (data) {
		var running = data[0];
		var binds = { udp: null, tcp: null };
		var m, s, o, configUrlOption;

		try {
			var cfg = JSON.parse(data[1]);
			binds.udp = (cfg.settings || {}).bind_udp;
			binds.tcp = (cfg.settings || {}).bind_tcp;
		}
		catch (e) { /* unreadable or invalid pipeline config */ }

		m = new form.Map('kixdns', _('KixDNS'),
			_('KixDNS is a high-performance, non-recursive DNS forwarding server. ' +
			  'Edit the pipeline rules in the "Config Editor" tab.'));

		s = m.section(form.NamedSection, '_status');
		s.anonymous = true;
		s.render = function () {
			var statusNode = E('span', {}, renderStatus(running));

			poll.add(function () {
				return getServiceStatus().then(function (r) {
					running = r;
					while (statusNode.firstChild)
						statusNode.removeChild(statusNode.firstChild);
					statusNode.appendChild(renderStatus(r));
				});
			}, 5);

			return E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('Service Status')),
				E('p', {}, [ _('Status'), ': ', statusNode ]),
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
			  'The redirect target port is taken from "bind_udp" in the pipeline config.'));
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
			_('Download a V2Ray GeoIP database to /etc/kixdns/geoip.dat before each service start. ' +
			  'Leave empty to disable downloading.'));
		o.datatype = 'url';
		o.placeholder = 'https://example.com/geoip.dat';

		configUrlOption = s.option(form.Value, 'config_download_url', _('Configuration download URL'),
			_('KixDNS always uses the local /etc/kixdns/pipeline.json. The remote file is downloaded ' +
			  'only when you click "Update configuration".'));
		configUrlOption.datatype = 'url';
		configUrlOption.placeholder = 'https://example.com/pipeline.json';

		o = s.option(form.Button, '_update_config', _('Remote configuration'),
			_('Download from the URL above, validate the JSON, and replace the local configuration now. ' +
			  'The previous local file is kept as /etc/kixdns/pipeline.json.bak.'));
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

		o = s.option(form.Value, 'rust_log', _('Log filter (RUST_LOG)'),
			_('Tracing filter passed via the RUST_LOG environment variable.'));
		o.default = 'error,kixdns::engine::matcher_adapter=info';
		o.value('error,kixdns::engine::matcher_adapter=info', _('Errors + matcher logs (recommended)'));
		o.value('error', _('Errors only'));
		o.value('info', _('Info'));
		o.value('debug', _('Debug'));

		o = s.option(form.Flag, 'debug', _('Debug logging'),
			_('Pass --debug to the daemon.'));
		o.rmempty = false;

		o = s.option(form.Value, 'log_size', _('Log size limit (KB)'),
			_('When the log file exceeds this size on service start, it is cleared before new entries are written.'));
		o.datatype = 'uinteger';
		o.default = '1024';
		o.placeholder = '1024';

		return m.render();
	}
});
