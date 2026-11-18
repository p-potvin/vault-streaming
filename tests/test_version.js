// tests/test_version.js — one version for the app, set in package.json; every copy matches it.
// Bump with `node scripts/sync-version.js X.Y.Z`; this fails, naming the file, when a copy drifts.
//
//   node tests/test_version.js

const assert = require('assert');
const { check, pkgVersion } = require('../scripts/sync-version');

assert.match(pkgVersion(), /^\d+\.\d+\.\d+/);
assert.deepStrictEqual(check(), [], 'run `node scripts/sync-version.js` to sync the copies');
console.log(`✓ every copy of the version is ${pkgVersion()}`);
