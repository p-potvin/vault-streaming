// Copy of vault-explorer/src/sidecar-record.js (Fri 06 Nov 2026): keep the two in step.
/**
 * Writing a media file's sidecar in the shared v2 record format (vault-raggae's app/files/records/record.py).
 *
 * vault-explorer started the sidecar (flat ffprobe fields, `enhancements`, `isValid*` at the root). The shared v2
 * record keeps those root keys, which this app reads, and wraps them in an envelope that vault-raggae and
 * vault-commander maintain:
 *
 *     schema: 2
 *     vw:          { kind, id, created, updated }            id: the media index's, never set here
 *     master:      { basename, ext, size, mtime, relpath?, root_label? }
 *     fingerprints, companions, history, vision, sound …     other producers': never touched here
 *
 * Every write goes through `update()`: it re-reads the sidecar at write time and replaces only the keys this app
 * owns (`OWNED_KEYS`), so a `vw.id` or a history entry another tool added since this app read the file is kept.
 * `name` and `path` (absolute: wrong after any move) are no longer stored; readers derive them from the file.
 */

const fs = require('fs');
const path = require('path');
const sidecarNames = require('./sidecar-names');

const SCHEMA = 2;

/** The root keys this app writes (record.py VIDEO_ROOT_KEYS, minus the ones derived from the file itself). */
const OWNED_KEYS = new Set([
  'width', 'height', 'duration', 'codec', 'bitrate', 'audioCodec', 'channels', 'sampleRate', 'fps',
  'hasAudio', 'hasVideo',
  'isValid', 'isValidCheckedAt', 'isValidReason', 'isValidSampleTime', 'isValidSamplesChecked',
  'enhancements', 'enhancementDetails', 'enhancedPath',
]);

/** Root keys of the old flat format that the v2 record derives from the file instead. */
const DROPPED_KEYS = ['name', 'path', 'size', 'created', 'modified', 'type'];

const VIDEO = new Set(['.mp4', '.mkv', '.webm', '.mov', '.m4v', '.avi', '.flv', '.wmv', '.mpg', '.mpeg', '.m2ts', '.3gp']);
const IMAGE = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.avif', '.tiff', '.tif', '.heic', '.heif', '.svg', '.ico']);
const AUDIO = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.opus', '.ogg', '.wma', '.aiff', '.ape']);

function kindOf(mediaPath) {
  const ext = path.extname(mediaPath).toLowerCase();
  if (VIDEO.has(ext)) return 'video';
  if (IMAGE.has(ext)) return 'image';
  if (AUDIO.has(ext)) return 'audio';
  return 'other';
}

/** record.py now_iso(): UTC, seconds, `Z`. */
function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The sidecar as it is on disk (any of its four names), or `{}`. Never throws. */
function read(mediaPath) {
  const { path: file, exists } = sidecarNames.resolveSync(mediaPath);
  if (!exists) return { file, record: {} };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { file, record: data && typeof data === 'object' && !Array.isArray(data) ? data : {} };
  } catch (_) {
    return { file, record: {} };
  }
}

/** Adds / refreshes the v2 envelope on `record` for `mediaPath` (in place) and drops the derived flat keys. */
function envelope(record, mediaPath) {
  record.schema = SCHEMA;
  const vw = (record.vw && typeof record.vw === 'object') ? record.vw : (record.vw = {});
  if (!vw.kind) vw.kind = kindOf(mediaPath);
  if (!vw.created) vw.created = nowIso();
  vw.updated = nowIso();
  const master = (record.master && typeof record.master === 'object') ? record.master : (record.master = {});
  master.basename = path.basename(mediaPath);
  master.ext = path.extname(mediaPath).toLowerCase();
  try {
    const st = fs.statSync(mediaPath);
    master.size = st.size;
    master.mtime = st.mtimeMs / 1000;
  } catch (_) { /* the master vanished: keep what was recorded */ }
  for (const k of DROPPED_KEYS) delete record[k];
  return record;
}

/**
 * Writes `fields` (only the keys this app owns; others are ignored) into the sidecar of `mediaPath`, keeping
 * everything else that is there now, under the name it already has (the canonical `<file.ext>.json` for a new
 * one). Atomic (temp file + rename). Returns the record written, or null on failure.
 */
function update(mediaPath, fields) {
  const { file, record } = read(mediaPath);
  for (const [k, v] of Object.entries(fields || {})) {
    if (!OWNED_KEYS.has(k)) continue;
    if (v === undefined) delete record[k];
    else record[k] = v;
  }
  envelope(record, mediaPath);
  const tmp = `${file}.tmp_${process.pid}_${Math.random().toString(36).slice(2, 9)}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return record;
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) { /* nothing to clean */ }
    console.error('[sidecar-record] Failed to write', file, err.message);
    return null;
  }
}

module.exports = { SCHEMA, OWNED_KEYS, DROPPED_KEYS, kindOf, read, update, envelope };
