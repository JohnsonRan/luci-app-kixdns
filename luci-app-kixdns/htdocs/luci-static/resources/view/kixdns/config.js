'use strict';
'require view';
'require fs';
'require ui';

var CONFFILE = '/etc/kixdns/pipeline.json';
var STAGED_CONFIG = '/etc/kixdns/pipeline.json.new';
var activeMessageHandler = null;

function execInit(args) {
	return fs.exec('/etc/init.d/kixdns', args).then(function (res) {
		if (!res || res.code !== 0) {
			var detail = String((res && (res.stderr || res.stdout)) || '').trim();
			throw new Error(detail || _('Command failed'));
		}
		return res;
	});
}

function usesDarkTheme() {
	var rgb = String(window.getComputedStyle(document.body).backgroundColor || '').match(/\d+/g);
	var darkBackground = rgb && rgb.length >= 3 &&
		(+rgb[0] * 0.299 + +rgb[1] * 0.587 + +rgb[2] * 0.114) < 128;
	return darkBackground || window.matchMedia('(prefers-color-scheme: dark)').matches;
}

return view.extend({
	load: function () {
		return L.resolveDefault(fs.read(CONFFILE), null);
	},

	render: function (content) {
		var baseline = content;
		var operationPending = false;
		var frame = E('iframe', {
			'class': 'kixdns-config-editor-frame',
			'src': L.resource('kixdns/config_editor.html') + '?v=1.4.6',
			'title': _('KixDNS configuration editor')
		});

		function send(type, payload) {
			if (!frame.contentWindow)
				return;
			frame.contentWindow.postMessage(Object.assign({
				source: 'luci-kixdns',
				type: type
			}, payload || {}), '*');
		}

		function sendLoadedConfig() {
			if (typeof baseline === 'string' && baseline.trim())
				send('load', { content: baseline });
			else
				send('load-error', { message: _('Configuration file is missing or unreadable.') });
		}

		function reloadConfig() {
			if (operationPending)
				return;

			operationPending = true;
			return fs.read(CONFFILE).then(function (current) {
				baseline = current;
				send('load', { content: current });
			}).catch(function (e) {
				send('load-error', { message: e.message });
			}).finally(function () {
				operationPending = false;
			});
		}

		function saveConfig(message) {
			if (operationPending)
				return;

			var apply = message.apply === true;
			var normalized = String(message.content || '');

			try {
				JSON.parse(normalized);
			}
			catch (e) {
				send('save-result', { ok: false, apply: apply, message: _('Invalid JSON') + ': ' + e.message });
				return;
			}

			if (!normalized.endsWith('\n'))
				normalized += '\n';

			operationPending = true;
			return fs.read(CONFFILE).then(function (current) {
				if (current !== baseline)
					throw new Error(_('The local configuration changed after this editor loaded. Reload it before saving.'));
				return fs.write(STAGED_CONFIG, normalized);
			}).then(function () {
				return execInit([ 'install_config' ]);
			}).then(function () {
				if (apply)
					return execInit([ 'reload' ]);
			}).then(function () {
				baseline = normalized;
				send('save-result', { ok: true, apply: apply });
				ui.addNotification(null, E('p', apply
					? _('Configuration saved and KixDNS restarted.')
					: _('Configuration saved.')), 'info');
			}).catch(function (e) {
				send('save-result', { ok: false, apply: apply, message: e.message });
				ui.addNotification(null, E('p', _('Save failed') + ': ' + e.message), 'error');
			}).finally(function () {
				operationPending = false;
			});
		}

		if (activeMessageHandler)
			window.removeEventListener('message', activeMessageHandler);

		activeMessageHandler = function (event) {
			if (event.source !== frame.contentWindow || !event.data ||
			    event.data.source !== 'kixdns-config-editor')
				return;

			if (event.data.type === 'ready') {
				sendLoadedConfig();
				send('theme', { dark: usesDarkTheme() });
			}
			else if (event.data.type === 'reload')
				reloadConfig();
			else if (event.data.type === 'save')
				saveConfig(event.data);
		};
		window.addEventListener('message', activeMessageHandler);

		return E('div', { 'class': 'cbi-map' }, [
			E('style', {}, [
				'.kixdns-config-editor-frame{display:block;width:100%;height:calc(100vh - 150px);' +
				'min-height:720px;border:1px solid #d6dce3;border-radius:4px;background:#f8f9fa}' +
				'@media(max-width:767px){.kixdns-config-editor-frame{height:calc(100vh - 120px);min-height:640px}}'
			]),
			frame
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
