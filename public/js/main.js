(async () => {
  for (const a of await api('/agents')) agents[a.id] = a;
  loadExtras();
  loadCtxCfg();
  loadPeers();
  loadBackends().then((l) => { if (l.some((b) => b.id !== 'claude' && b.installed)) renderList(); }); // backend labels for agents on other CLIs
  renderPush().catch(() => {});
  renderList(); connect();
  route();
})();
