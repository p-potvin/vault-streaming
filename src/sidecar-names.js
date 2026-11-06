// Copy of vault-explorer/src/sidecar-names.js (Fri 06 Nov 2026): keep the two in step.
/**
 * Where a media file's sidecar lives, and what it should be called.
 *
 * Four names have been in use, written by different tools that never agreed:
 *
 *     clip.mp4.json          <- canonical from now on
 *     clip.mp4.meta.json     <- what this app has always written
 *     clip.json              <- the image family, image_tagger and the galleries
 *     clip.meta.json         <- rare
 *
 * `clip.mp4.json` wins because it is the only one that cannot collide. Under
 * the stem forms a `clip.mp4` and a `clip.jpg` in one folder both want
 * `clip.json` — a video sitting next to its poster — and one tool's record
 * silently overwrites the other's.
 *
 * This app used to hardcode `videoPath + '.meta.json'` in five places. It still
 * reads that name; it just no longer assumes it. Sidecars are being renamed to
 * the canonical form across ~37,000 files, and anything still assuming the old
 * name goes blind the moment the rename runs.
 *
 * Mirror of vault-commander/cli/utils/media_records/sidecar_names.py — keep the
 * two in step rather than letting them drift.
 */

const fs = require('fs');
const path = require('path');

/** Extensions that make a file a "master". Only used to detect stem collisions,
 *  so it errs on the side of including things. */
const MEDIA_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.avif', '.tiff',
  '.mp4', '.mkv', '.webm', '.mov', '.m4v', '.avi', '.flv', '.wmv',
  '.mp3', '.wav', '.flac', '.m4a', '.aac', '.opus', '.ogg',
]);

/** The name a sidecar should be written under. */
function canonical(mediaPath) {
  return `${mediaPath}.json`;
}

/**
 * Every name a sidecar for this file may legitimately have, most trusted first.
 * The full-name forms carry the master's extension and can only refer to one
 * file; the stem forms cannot, which is why they come last.
 */
function candidates(mediaPath) {
  const ext = path.extname(mediaPath);
  const stem = ext ? mediaPath.slice(0, -ext.length) : mediaPath;
  return [
    `${mediaPath}.json`,
    `${mediaPath}.meta.json`,
    `${stem}.json`,
    `${stem}.meta.json`,
  ];
}

/** Would a stem-named sidecar here be claimed by more than one master? */
function stemIsAmbiguous(mediaPath) {
  const ownExt = path.extname(mediaPath).toLowerCase();
  const stem = ownExt ? mediaPath.slice(0, -ownExt.length) : mediaPath;
  for (const ext of MEDIA_EXTENSIONS) {
    if (ext === ownExt) continue;
    if (fs.existsSync(stem + ext)) return true;
  }
  return false;
}

/**
 * Find this file's sidecar synchronously.
 * Returns `{ path, exists }`; when none is found, `path` is the canonical name.
 */
function resolveSync(mediaPath) {
  const list = candidates(mediaPath);
  let ambiguous = null;   // computed lazily; the stat loop is the expensive part

  for (let i = 0; i < list.length; i++) {
    const candidate = list[i];
    let isFile = false;
    try {
      isFile = fs.statSync(candidate).isFile();
    } catch {
      continue;
    }
    if (!isFile) continue;

    if (i >= 2) {                                  // a stem form
      if (ambiguous === null) ambiguous = stemIsAmbiguous(mediaPath);
      if (ambiguous) continue;                     // belongs to no one yet
    }
    return { path: candidate, exists: true };
  }

  return { path: canonical(mediaPath), exists: false };
}

/** Async twin of resolveSync, for the paths that are already async. */
async function resolveAsync(mediaPath) {
  const fsp = fs.promises;
  const list = candidates(mediaPath);
  let ambiguous = null;

  for (let i = 0; i < list.length; i++) {
    try {
      const stat = await fsp.stat(list[i]);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }
    if (i >= 2) {
      if (ambiguous === null) ambiguous = stemIsAmbiguous(mediaPath);
      if (ambiguous) continue;
    }
    return { path: list[i], exists: true };
  }
  return { path: canonical(mediaPath), exists: false };
}

module.exports = {
  MEDIA_EXTENSIONS,
  canonical,
  candidates,
  stemIsAmbiguous,
  resolveSync,
  resolveAsync,
};
