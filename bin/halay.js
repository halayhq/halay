#!/usr/bin/env node
// `halay`: see cli.js (and `halay --help`). `halay` / `halay start` runs the server (server.js) in this process.
import { KIND_LABEL } from '../src/cli/install-kind.js';
import { parseArgs, HELP, VERSION, context, signInUrls, restartCmd, stopCmd, INSTALL_KIND } from '../src/cli/cli.js';

const major = Number(process.versions.node.split('.')[0]);
if (major < 22) { console.error(`halay needs Node.js 22 or newer (24 or 26 recommended); this is ${process.version}.`); process.exit(1); }

const args = parseArgs(process.argv.slice(2));
if (args.error) { console.error(`halay: ${args.error}`); process.exit(2); }
const { cmd, sub, opts } = args;

if (cmd === 'help') console.log(HELP);
else if (cmd === 'version') console.log(`${VERSION} (${KIND_LABEL[INSTALL_KIND]})`);
else if (cmd === 'start') {
  if (opts.port) process.env.PORT = opts.port;
  if (opts.host[0]) process.env.HOST = opts.host[0];
  await import('../src/server.js');
} else if (cmd === 'token') {
  const r = signInUrls(context());
  if (r.error) { console.error(r.error); process.exit(1); }
  for (const u of r.urls) console.log(u);
} else if (cmd === 'restart') process.exit(await restartCmd(context()));
else if (cmd === 'stop') process.exit(await stopCmd(context()));
else if (cmd === 'cert') { const { certCmd } = await import('../src/cli/cert.js'); process.exit(await certCmd(sub, opts, context())); }
else if (cmd === 'service') { const { serviceCmd } = await import('../src/cli/service.js'); process.exit(await serviceCmd(sub, opts, context())); }
else if (cmd === 'app') { const { appCmd } = await import('../src/cli/mac-app.js'); process.exit(await appCmd(sub, opts, context())); }
