const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');

console.log('=== VAULT STREAMING AI VOCAL SEPARATION SETTINGS VERIFICATION ===\n');

// 1. Verify index.html markup
console.log('[Test 1] Checking index.html settings modal markup...');
const indexPath = path.join(__dirname, '..', 'index.html');
const indexHtml = fs.readFileSync(indexPath, 'utf8');
assert.ok(indexHtml.includes('id="settings-ai-separate"'), 'index.html must contain #settings-ai-separate checkbox');
assert.ok(indexHtml.includes('data-i18n="settingAiSeparate"'), 'index.html must bind settingAiSeparate translation key');
console.log('[PASS] index.html markup verified.\n');

// 2. Verify Translations
console.log('[Test 2] Checking EN and QC translations...');
const enPath = path.join(__dirname, '..', 'js', 'translations.en.js');
const qcPath = path.join(__dirname, '..', 'js', 'translations.qc.js');
const enContent = fs.readFileSync(enPath, 'utf8');
const qcContent = fs.readFileSync(qcPath, 'utf8');
assert.ok(enContent.includes('settingAiSeparate:'), 'translations.en.js must contain settingAiSeparate');
assert.ok(qcContent.includes('settingAiSeparate:'), 'translations.qc.js must contain settingAiSeparate');
console.log('[PASS] EN & QC translations verified.\n');

// 3. Verify js/settings/core.js wiring
console.log('[Test 3] Checking js/settings/core.js hydration & save logic...');
const corePath = path.join(__dirname, '..', 'js', 'settings', 'core.js');
const coreContent = fs.readFileSync(corePath, 'utf8');
assert.ok(coreContent.includes("el('settings-ai-separate').checked = window.appSettings.aiSeparate !== false;"), 'core.js must hydrate settings-ai-separate');
assert.ok(coreContent.includes("window.appSettings.aiSeparate = el('settings-ai-separate').checked;"), 'core.js must save settings-ai-separate to window.appSettings');
console.log('[PASS] settings/core.js wiring verified.\n');

// 4. Verify live subtitle caller in js/player/subtitles.js
console.log('[Test 4] Checking live subtitle start caller in js/player/subtitles.js...');
const subPath = path.join(__dirname, '..', 'js', 'player', 'subtitles.js');
const subContent = fs.readFileSync(subPath, 'utf8');
assert.ok(subContent.includes('separate: (window.appSettings && window.appSettings.aiSeparate !== false)'), 'subtitles.js must pass separation state');
console.log('[PASS] player/subtitles.js caller verified.\n');

// 5. Verify IPC handler in src/live-subtitles.js
console.log('[Test 5] Checking IPC handler in src/live-subtitles.js...');
const ipcPath = path.join(__dirname, '..', 'src', 'live-subtitles.js');
const ipcContent = fs.readFileSync(ipcPath, 'utf8');
assert.ok(ipcContent.includes('separate: separate !== false'), 'src/live-subtitles.js must forward separate option to daemon');
console.log('[PASS] src/live-subtitles.js IPC verified.\n');

console.log('=== ALL VAULT STREAMING SEPARATION SETTINGS TESTS PASSED ===');
