#!/usr/bin/env node
// Regenerate the app icons from one source, the halay mark (the halay.app favicon: an ink rounded square, a lime arc and
// lead circle, three light circles). Writes:
//   public/favicon.svg          the mark itself (same file as halay.app's favicon.svg)
//   public/favicon-32.png       PNG fallback for browsers without SVG favicons
//   public/apple-touch-icon.png 180px, full-bleed square (iOS rounds the corners itself)
//   public/icon-192.png, icon-512.png                    PWA icons, purpose "any" (rounded square, transparent corners)
//   public/icon-maskable-192.png, icon-maskable-512.png  PWA icons, purpose "maskable": full-bleed ink, the mark scaled so it
//                                                        sits inside the central safe-zone circle (radius 40% of the size)
//   public/badge-96.png         Android notification badge: the mark in white on transparent (Android uses only the alpha)
// The colours come from product.js (BRAND_COLOR = the ink, BRAND_LIME). Run `node bin/make-icons.mjs` and commit the files.
// Renders with playwright-core and the installed Google Chrome (no extra dependencies). See docs/theming.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { BRAND_COLOR, BRAND_LIME } from '../src/product.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUB = path.join(ROOT, 'public');
const LIGHT = '#f4f4f5';

// the mark on a 64x64 grid (halay.app public/favicon.svg). A dancer leads the line (lime), three follow along the arc.
const motif = (lead = BRAND_LIME, rest = LIGHT, arc = BRAND_LIME) =>
  `<path d="M15 42 Q 32 14 49 42" fill="none" stroke="${arc}" stroke-width="3.5" stroke-linecap="round" opacity=".55"/>` +
  `<circle cx="15" cy="42" r="9" fill="${lead}"/>` +
  `<circle cx="23.5" cy="31.5" r="5.5" fill="${rest}"/><circle cx="40.5" cy="31.5" r="5.5" fill="${rest}"/><circle cx="49" cy="42" r="5.5" fill="${rest}"/>`;
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="halay">${body}</svg>`;
const rounded = svg(`<rect width="64" height="64" rx="15" fill="${BRAND_COLOR}"/>${motif()}`);
const square = svg(`<rect width="64" height="64" fill="${BRAND_COLOR}"/>${motif()}`);
// the farthest point of the mark is the lead circle's edge, 28.7 units (45%) from the centre; scaled by .8 it is 36%, inside
// the 40% safe zone with a margin
const maskable = svg(`<rect width="64" height="64" fill="${BRAND_COLOR}"/><g transform="translate(32 32) scale(.8) translate(-32 -32)">${motif()}</g>`);
const badge = svg(`<g transform="translate(32 32) scale(1.15) translate(-30.25 -38.5)">${motif('#fff', '#fff', '#fff')}</g>`);

fs.writeFileSync(path.join(PUB, 'favicon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="halay">
  <rect width="64" height="64" rx="15" fill="${BRAND_COLOR}"/>
  <path d="M15 42 Q 32 14 49 42" fill="none" stroke="${BRAND_LIME}" stroke-width="3.5" stroke-linecap="round" opacity=".55"/>
  <circle cx="15" cy="42" r="9" fill="${BRAND_LIME}"/>
  <circle cx="23.5" cy="31.5" r="5.5" fill="${LIGHT}"/>
  <circle cx="40.5" cy="31.5" r="5.5" fill="${LIGHT}"/>
  <circle cx="49" cy="42" r="5.5" fill="${LIGHT}"/>
</svg>
`);
console.log('wrote public/favicon.svg');

// rasterised on a canvas inside the page (not a screenshot), which gives the same PNG bytes on every run
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--force-color-profile=srgb'] });
try {
  const page = await browser.newPage();
  const out = [['favicon-32.png', 32, rounded], ['apple-touch-icon.png', 180, square], ['icon-192.png', 192, rounded], ['icon-512.png', 512, rounded],
    ['icon-maskable-192.png', 192, maskable], ['icon-maskable-512.png', 512, maskable], ['badge-96.png', 96, badge]];
  for (const [file, size, src] of out) {
    const b64 = await page.evaluate(async ([s, n]) => {
      const img = new Image(); img.src = 'data:image/svg+xml;base64,' + btoa(s); await img.decode();
      const c = document.createElement('canvas'); c.width = c.height = n;
      c.getContext('2d').drawImage(img, 0, 0, n, n);
      return c.toDataURL('image/png').split(',')[1];
    }, [src, size]);
    fs.writeFileSync(path.join(PUB, file), Buffer.from(b64, 'base64'));
    console.log('wrote public/' + file);
  }
} finally { await browser.close(); }
