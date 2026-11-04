// Product identity in one place: the display name and version come from package.json ("productName", "shortName", "version"),
// so a rename is a package.json edit. The server sends them to the browser via /manifest.webmanifest and /api/server.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
export const APP_NAME = pkg.productName || pkg.name;
export const APP_SHORT_NAME = pkg.shortName || APP_NAME;
export const APP_VERSION = pkg.version || '';
// Brand colours for things outside the CSS (manifest, app icons via bin/make-icons.mjs), from the halay.app palette. The UI
// palette itself lives in public/css/theme.css and js/themes.js (the Halay preset). Keep BRAND_COLOR equal to the light-theme
// --acc and BRAND_SURFACE to the dark-theme --bg there. See docs/theming.md.
export const BRAND_COLOR = '#0e0e11'; // ink: light --acc, the icon square
export const BRAND_LIME = '#c9f53f'; // lime: the light highlight (--acc-s, text on ink buttons), the lead circle in the icon
export const BRAND_SURFACE = '#0b0b0e'; // dark-theme --bg: PWA splash background and theme_color, title bar before the page sets its own
