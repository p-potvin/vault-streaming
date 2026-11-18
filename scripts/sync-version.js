#!/usr/bin/env node
// scripts/sync-version.js — one version for the app, set in one place: package.json (operator, Wed 18 Nov 2026).
//
//   node scripts/sync-version.js 2.4.0     set the version, then write it everywhere else
//   node scripts/sync-version.js           write package.json's version everywhere else
//   node scripts/sync-version.js --check   exit 1 and name every file that disagrees (tests/test_version.js)
//
// Read at run time, nothing to sync: Electron's app.getVersion() and the installer (electron-builder) take
// package.json's. Written here, because their formats cannot point elsewhere:
//   - the <!-- vX.Y.Z --> comment on line 2 of index.html (was its own number, v1.x, beside package.json's 2.x);
//   - package-lock.json's two entries for the app itself.
// The iOS app (ios/) is a separate product with its own version and is not touched.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SEMVER = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/;

const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const pkgVersion = () => JSON.parse(read('package.json')).version;

/** [file, pattern, replacement] for every copy of the version. */
function targets(v) {
    return [
        ['index.html', /<!-- v[^ ]+ -->/, `<!-- v${v} -->`],
        // the lock's top-level entry and its "packages" root entry ("": {...}), not the dependencies
        ['package-lock.json', /^(\t"version": )"[^"]+"/m, `$1"${v}"`],
        ['package-lock.json', /(\n\t\t"": \{\n\t\t\t"name": "[^"]+",\n\t\t\t"version": )"[^"]+"/, `$1"${v}"`],
    ];
}

function check() {
    const v = pkgVersion();
    const bad = new Set();
    for (const [rel, re, repl] of targets(v)) {
        if (!fs.existsSync(path.join(ROOT, rel))) continue;
        const s = read(rel);
        if (!re.test(s)) bad.add(`${rel} (no version found)`);
        else if (s.replace(re, repl) !== s) bad.add(rel);
    }
    return [...bad].sort();
}

function sync(next) {
    if (next) {
        if (!SEMVER.test(next)) throw new Error(`not a version: ${next}`);
        const s = read('package.json');
        fs.writeFileSync(path.join(ROOT, 'package.json'), s.replace(/^(  "version": )"[^"]+"/m, `$1"${next}"`));
    }
    const v = pkgVersion();
    const changed = new Set();
    for (const [rel, re, repl] of targets(v)) {
        const file = path.join(ROOT, rel);
        if (!fs.existsSync(file)) continue;
        const s = fs.readFileSync(file, 'utf8');
        const out = s.replace(re, repl);
        if (out !== s) { fs.writeFileSync(file, out); changed.add(rel); }
    }
    return [...changed].sort();
}

if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.includes('--check')) {
        const bad = check();
        for (const b of bad) console.log(`out of sync with package.json (${pkgVersion()}): ${b}`);
        process.exit(bad.length ? 1 : 0);
    }
    const changed = sync(args.find(a => !a.startsWith('-')));
    console.log(`version ${pkgVersion()}: ${changed.length ? changed.join(', ') : 'everything already matches'}`);
}

module.exports = { check, sync, pkgVersion };
