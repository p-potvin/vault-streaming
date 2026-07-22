// scripts/gen-icons.js — port the redesign-v2 SVG icon set into the vanilla
// `window.icons` string format used by this app.
//
// Source:  redesignv2/vw-icons.jsx  (99 `IconXxx(props)` React components)
// Output:  js/icons.v2.js           (`window.iconsV2` + additive backfill of
//                                     `window.icons` for names not already defined)
//
// Usage: node scripts/gen-icons.js [srcJsx] [outFile]
// Re-run whenever the redesign icon set changes.

const fs = require('fs');
const path = require('path');

const SRC = process.argv[2] || 'C:/Users/Administrator/Desktop/redesignv2/vw-icons.jsx';
const OUT = process.argv[3] || path.join(__dirname, '..', 'js', 'icons.v2.js');

const src = fs.readFileSync(SRC, 'utf8');

// function IconName(props) { return <svg ...> CHILDREN </svg>; }
// (also tolerates a <VWIcon ...> wrapper, just in case)
const re = /function\s+(Icon[A-Za-z0-9]+)\s*\(props\)\s*\{\s*return\s*<(?:svg|VWIcon)\b[^>]*>([\s\S]*?)<\/(?:svg|VWIcon)>\s*;?\s*\}/g;

function toName(icon) {
  const n = icon.replace(/^Icon/, '');
  return n.charAt(0).toLowerCase() + n.slice(1);
}

function cleanChildren(s) {
  return s
    .replace(/strokeWidth=/g, 'stroke-width=')
    .replace(/strokeLinecap=/g, 'stroke-linecap=')
    .replace(/strokeLinejoin=/g, 'stroke-linejoin=')
    .replace(/strokeDasharray=/g, 'stroke-dasharray=')
    .replace(/strokeMiterlimit=/g, 'stroke-miterlimit=')
    .replace(/fillRule=/g, 'fill-rule=')
    .replace(/clipRule=/g, 'clip-rule=')
    .replace(/\s+/g, ' ')
    .trim();
}

const icons = {};
let m;
let dynamic = 0;
while ((m = re.exec(src)) !== null) {
  const name = toName(m[1]);
  const kids = cleanChildren(m[2]);
  if (kids.includes('{')) { console.warn('WARN dynamic content skipped in', name); dynamic++; continue; }
  icons[name] = kids;
}

const names = Object.keys(icons).sort();
let out = `// js/icons.v2.js — AUTO-GENERATED from redesignv2/vw-icons.jsx by scripts/gen-icons.js
// VaultWares Revisited icon set (full redesign-v2). DO NOT EDIT BY HAND — regenerate.
// Each fn returns an inline SVG string; viewBox 0 0 24 24, stroke 1.5 currentColor,
// round caps/joins (the redesign "signature gap" style).
window.iconsV2 = {
`;
for (const name of names) {
  out += '  ' + name + ": (cls = '', style = '') => `<svg class=\"${cls}\" style=\"${style}\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\">" + icons[name] + '</svg>`,\n';
}
out += `};

// Additively backfill window.icons with any redesign icon whose name is not
// already defined — this preserves the hand-tuned originals that existing
// callers depend on, while making the full redesign set available.
(function () {
  if (typeof window === 'undefined') return;
  window.icons = window.icons || {};
  for (const k of Object.keys(window.iconsV2)) {
    if (!(k in window.icons)) window.icons[k] = window.iconsV2[k];
  }
})();
`;

fs.writeFileSync(OUT, out, 'utf8');
console.log('Wrote ' + OUT + ' with ' + names.length + ' icons' + (dynamic ? (' (' + dynamic + ' skipped)') : ''));
