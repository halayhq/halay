// Small helpers shared by several modules.

// a handle from a name: lowercase letters, digits and single dashes, at most 24 characters (bots, room @mentions)
export const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '');

// names for peers and browser profiles: letters, digits, - and _, at most 32 characters, not starting with - or _
export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

// terminal scrollback: characters of output kept per terminal (pty-host.js and terminal.js keep the same amount)
export const SCROLLBACK = 256 * 1024;
// once a buffer grows a quarter past the limit, keep the last SCROLLBACK characters, cut at a line break so a replay
// doesn't start mid-line
export const trimScrollback = (buf) => {
  if (buf.length <= SCROLLBACK * 1.25) return buf;
  const cut = buf.indexOf('\n', buf.length - SCROLLBACK);
  return buf.slice(cut < 0 ? buf.length - SCROLLBACK : cut + 1);
};

// permission modes from least to most permissive (agents, bots, schedules): an agent may never give another agent a
// mode that ranks above its own. 'cli' takes whatever the user's CLI settings say, so it ranks just below
// bypassPermissions; 'default' is the old name of manual; anything unknown counts as 'cli'.
const MODE_RANK = { plan: 0, manual: 1, default: 1, acceptEdits: 2, auto: 3, cli: 4, bypassPermissions: 5 };
export const modeRank = (m) => MODE_RANK[m] ?? MODE_RANK.cli;

// Configuration from the environment: env('PUBLIC_URL') reads HALAY_PUBLIC_URL.
export const env = (name, e = process.env) => e['HALAY_' + name];
