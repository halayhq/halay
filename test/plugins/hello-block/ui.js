export function activate(host) {
  host.sidebar.block({ id: 'hello', title: 'Hello block', order: 50, render: async (el) => { el.textContent = 'greeting: ' + (await host.api('ping')).pong; } });
  host.pages.add({ id: 'main', title: 'Hello page', render: (el) => { el.append(host.ui.mk('p', 'hello-page', 'hello from a plugin page')); } });
}
