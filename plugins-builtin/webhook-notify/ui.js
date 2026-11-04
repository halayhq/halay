// Adds "last sent …" under the plugin's settings form; updates live when the server part sends something.
export function activate(host) {
  let box = null;
  const show = (last) => { if (box) box.textContent = last ? `Last sent ${host.ui.relTime(last.at)}${host.ui.relTime(last.at) === 'now' ? '' : ' ago'}: ${last.title}` : 'Nothing sent yet.'; };
  host.settings.section({
    async render(el) {
      box = host.ui.mk('div', 'mutl');
      el.append(box);
      show(await host.api('last').catch(() => null));
    },
  });
  host.on('sent', show);
}
