// audio-tracks.ipc.js — probe a media source for its audio tracks.
//
// Why this exists: a release name carries no reliable signal about which audio
// track is the default (e.g. a "…HEVC-PSA.mkv" whose first track is a Russian
// dub). Chromium doesn't reliably expose HTMLMediaElement.audioTracks, so the
// only way to know — and later to switch — is ffmpeg-side.
//
// STEP 1 (this module): report the tracks. No playback behaviour changes.
// STEP 2 (later): remux with `-map 0:v:0 -map 0:a:<idx> -c:v copy` to switch.

const { execFile } = require('child_process');
const utils = require('../utils');

// Language of an audio track, most trusted first (operator, Wed 18 Nov 2026: what the stream reports wins; a model
// guess mislabels close languages, e.g. Ukrainian as Russian):
//   1. the stream's language tag (ISO 639-2/B or /T, 639-1, a BCP 47 tag, or a language name some muxers write);
//   2. the track title ("VFQ", "TrueFrench", "Rus Dub", "English 5.1") when the tag is missing or "und";
//   3. only then speech detection (Nemotron, 'detect-audio-language' below), asked for by the player when no
//      reported track matches the preferred language.

// ISO 639-2 (B and T) and 639-1 -> 639-1.
const LANG_MAP = {
    eng: 'en', en: 'en', fre: 'fr', fra: 'fr', fr: 'fr', rus: 'ru', ru: 'ru', ukr: 'uk', uk: 'uk',
    spa: 'es', es: 'es', ger: 'de', deu: 'de', de: 'de', ita: 'it', it: 'it', por: 'pt', pt: 'pt',
    dut: 'nl', nld: 'nl', nl: 'nl', pol: 'pl', pl: 'pl', cze: 'cs', ces: 'cs', cs: 'cs', slo: 'sk', slk: 'sk', sk: 'sk',
    jpn: 'ja', ja: 'ja', kor: 'ko', ko: 'ko', chi: 'zh', zho: 'zh', zh: 'zh', cmn: 'zh', yue: 'zh',
    hin: 'hi', hi: 'hi', ara: 'ar', ar: 'ar', tur: 'tr', tr: 'tr', swe: 'sv', sv: 'sv', hun: 'hu', hu: 'hu',
    dan: 'da', da: 'da', nor: 'no', nob: 'no', nno: 'no', no: 'no', nb: 'no', nn: 'no', fin: 'fi', fi: 'fi',
    ice: 'is', isl: 'is', is: 'is', gre: 'el', ell: 'el', el: 'el', heb: 'he', he: 'he', iw: 'he',
    rum: 'ro', ron: 'ro', ro: 'ro', mol: 'ro', bul: 'bg', bg: 'bg', hrv: 'hr', hr: 'hr', srp: 'sr', sr: 'sr',
    bos: 'bs', bs: 'bs', slv: 'sl', sl: 'sl', mac: 'mk', mkd: 'mk', mk: 'mk', alb: 'sq', sqi: 'sq', sq: 'sq',
    lit: 'lt', lt: 'lt', lav: 'lv', lv: 'lv', est: 'et', et: 'et', bel: 'be', be: 'be', geo: 'ka', kat: 'ka', ka: 'ka',
    arm: 'hy', hye: 'hy', hy: 'hy', per: 'fa', fas: 'fa', fa: 'fa', urd: 'ur', ur: 'ur', ben: 'bn', bn: 'bn',
    tam: 'ta', ta: 'ta', tel: 'te', te: 'te', mal: 'ml', ml: 'ml', kan: 'kn', kn: 'kn', mar: 'mr', mr: 'mr',
    pan: 'pa', pa: 'pa', guj: 'gu', gu: 'gu', tha: 'th', th: 'th', vie: 'vi', vi: 'vi', ind: 'id', id: 'id',
    may: 'ms', msa: 'ms', ms: 'ms', fil: 'tl', tgl: 'tl', tl: 'tl', cat: 'ca', ca: 'ca', baq: 'eu', eus: 'eu', eu: 'eu',
    glg: 'gl', gl: 'gl', wel: 'cy', cym: 'cy', cy: 'cy', gle: 'ga', ga: 'ga', lat: 'la', la: 'la',
    afr: 'af', af: 'af', swa: 'sw', sw: 'sw', kaz: 'kk', kk: 'kk', uzb: 'uz', uz: 'uz', aze: 'az', az: 'az',
    mon: 'mn', mn: 'mn', tib: 'bo', bod: 'bo', bo: 'bo', khm: 'km', km: 'km', lao: 'lo', lo: 'lo', bur: 'my', mya: 'my', my: 'my',
    // not languages
    und: 'und', unk: 'und', zxx: 'und', mis: 'und', mul: 'multi', qaa: 'und',
};

// Language names some muxers put in the tag, and the words release groups use in track titles. Unicode letter
// boundaries rather than \b, which only knows ASCII (a Cyrillic or Greek title would never match). Unicode letter
// boundaries rather than , which only knows ASCII (a Cyrillic or Greek title would never match).
const NAME_PATTERNS = [
    ['fr', /(?<!\p{L})(fran[cç]ais|french|truefrench|vf[fqi2]?|vff|vfq|vfi|vf2|qu[eé]b[eé]c(ois)?|canadien)(?!\p{L})/iu],
    ['en', /(?<!\p{L})(english|anglais|eng)(?!\p{L})/iu],
    ['ru', /(?<!\p{L})(russian|русский|rus)(?!\p{L})/iu],
    ['uk', /(?<!\p{L})(ukrainian|українська|ukr)(?!\p{L})/iu],
    ['es', /(?<!\p{L})(spanish|espa[nñ]ol|castellano|latino|spa)(?!\p{L})/iu],
    ['de', /(?<!\p{L})(german|deutsch|ger)(?!\p{L})/iu],
    ['it', /(?<!\p{L})(italian|italiano|ita)(?!\p{L})/iu],
    ['pt', /(?<!\p{L})(portuguese|portugu[eê]s|por)(?!\p{L})/iu],
    ['ja', /(?<!\p{L})(japanese|日本語|jpn)(?!\p{L})/iu],
    ['ko', /(?<!\p{L})(korean|한국어|kor)(?!\p{L})/iu],
    ['zh', /(?<!\p{L})(chinese|mandarin|cantonese|中文|chi)(?!\p{L})/iu],
    ['pl', /(?<!\p{L})(polish|polski)(?!\p{L})/iu],
    ['nl', /(?<!\p{L})(dutch|nederlands)(?!\p{L})/iu],
    ['tr', /(?<!\p{L})(turkish|t[uü]rk[cç]e)(?!\p{L})/iu],
    ['ar', /(?<!\p{L})(arabic|العربية)(?!\p{L})/iu],
    ['hi', /(?<!\p{L})(hindi)(?!\p{L})/iu],
    ['cs', /(?<!\p{L})(czech|[cč]e[sš]tina)(?!\p{L})/iu],
    ['hu', /(?<!\p{L})(hungarian|magyar)(?!\p{L})/iu],
    ['sv', /(?<!\p{L})(swedish|svenska)(?!\p{L})/iu],
    ['da', /(?<!\p{L})(danish|dansk)(?!\p{L})/iu],
    ['no', /(?<!\p{L})(norwegian|norsk)(?!\p{L})/iu],
    ['fi', /(?<!\p{L})(finnish|suomi)(?!\p{L})/iu],
    ['el', /(?<!\p{L})(greek|ελληνικά)(?!\p{L})/iu],
    ['he', /(?<!\p{L})(hebrew|עברית)(?!\p{L})/iu],
];

/** A language tag -> ISO 639-1 ('und' when unknown). `fr-CA`, `fre`, `French` -> 'fr'. */
function normLang(tag) {
    if (!tag) return 'und';
    const raw = String(tag).trim();
    if (!raw) return 'und';
    const t = raw.toLowerCase().split(/[-_]/)[0];
    if (LANG_MAP[t]) return LANG_MAP[t];
    const named = NAME_PATTERNS.find(([, re]) => re.test(raw));
    if (named) return named[0];
    return /^[a-z]{2}$/.test(t) ? t : 'und';
}

/** The language a track title names ("VFQ 5.1", "Rus Dub [MVO]"), or null. "VO" / "Original" name none. */
function langFromTitle(title) {
    if (!title) return null;
    const named = NAME_PATTERNS.find(([, re]) => re.test(String(title)));
    return named ? named[0] : null;
}

// Audio codecs this Electron build can decode directly. AC3/E-AC3 work thanks to
// the castlabs build; DTS / DTS-HD / TrueHD / MLP do NOT and play silently, which
// is the "some movies have no sound" symptom. Those must be remuxed to AAC.
const BROWSER_SAFE_AUDIO = new Set([
    'aac', 'mp3', 'opus', 'vorbis', 'flac', 'ac3', 'eac3',
]);

function isBrowserSafeAudio(codec) {
    return BROWSER_SAFE_AUDIO.has(String(codec || '').toLowerCase());
}

// Must stay BELOW the renderer's own race timeout in player.js (12s). The
// renderer abandons the probe when its race fires; if ffprobe outlived that it
// would keep an extra connection open on the debrid link with nobody listening.
// Shorter here means the child is always dead before the caller gives up.
const PROBE_TIMEOUT_MS = 10000;
// One detection: the 20 s sample (a remote seek) and the ASR call each get this long.
const DETECT_TIMEOUT_MS = 12000;
// The always-loaded nemo-speech server (vault-cacophony NeMo-Speech.cpp, Nemotron 3.5 ASR streaming).
const NEMO_SPEECH_URL = (process.env.NEMO_SPEECH_URL || 'http://127.0.0.1:8793').replace(/\/+$/, '');

// A movie shorter than this is a trailer, sample, or the wrong file inside the
// release — no legitimate feature runs under 15 minutes. Episodes legitimately
// do, so callers only apply this to movies.
const MIN_FEATURE_DURATION_SECONDS = 15 * 60;


function ffprobePath() {
    return utils.getFFmpegPath().replace('ffmpeg.exe', 'ffprobe.exe').replace(/ffmpeg$/, 'ffprobe');
}

// Strip the Comet base64 config segment (it embeds the debrid API keys).
function redact(u) {
    return String(u || '').replace(/\/eyJ[^/\s]+/, '/<config>');
}

// ffmpeg/ffprobe honour the http_proxy / https_proxy environment variables, so
// routing the probe through the tunnel is an env concern rather than a flag.
function proxyEnv(proxy) {
    if (!proxy || !String(proxy).trim()) return {};
    let p = String(proxy).trim();
    if (!/^https?:\/\//i.test(p)) p = 'http://' + p;
    return { http_proxy: p, https_proxy: p, HTTP_PROXY: p, HTTPS_PROXY: p };
}

function registerAudioTracksIpc(ipcMain) {
    ipcMain.handle('probe-audio-tracks', async (_event, { url, proxy, preferredLang } = {}) => {
        if (!url || typeof url !== 'string') {
            return { success: false, error: 'No source provided' };
        }

        const isRemote = /^https?:\/\//i.test(url);
        const args = ['-v', 'error'];

        if (isRemote) {
            // Only the header is needed, so cap how much gets pulled. Same
            // hardening the ASR path uses, since this is a separate connection.
            args.push(
                '-user_agent', 'Mozilla/5.0',
                '-reconnect', '1',
                '-reconnect_streamed', '1',
                '-reconnect_delay_max', '10',
                '-probesize', '5M',
                '-analyzeduration', '5M',
            );
        }

        args.push(
            // No -select_streams: one probe returns both the audio tracks AND the
            // video codec/profile/level, which step 2 needs to build the
            // MediaSource codec string for a `-c:v copy` remux.
            // (side data: a Dolby Vision configuration record, whose profile decides whether the video can be copied)
            '-show_entries', 'stream=index,codec_type,codec_name,profile,level,channels,pix_fmt,color_transfer,disposition'
                + ':stream_tags=language,title:stream_side_data=side_data_type,dv_profile:format=duration',
            '-of', 'json',
            url,
        );

        const started = Date.now();
        console.log('[audio-tracks] probing', redact(url));

        const raw = await new Promise((resolve, reject) => {
            const child = execFile(
                ffprobePath(), args,
                {
                    windowsHide: true,
                    timeout: PROBE_TIMEOUT_MS,
                    killSignal: 'SIGKILL',
                    maxBuffer: 4 * 1024 * 1024,
                    env: { ...process.env, ...proxyEnv(proxy) },
                },
                (err, stdout, stderr) => {
                    if (err && !stdout) return reject(new Error((stderr || err.message || '').slice(-300)));
                    resolve(stdout);
                },
            );
            child.on('error', reject);
        }).catch((e) => {
            console.warn('[audio-tracks] probe failed:', e.message);
            return null;
        });

        if (!raw) return { success: false, error: 'ffprobe failed' };

        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (e) {
            return { success: false, error: 'could not parse ffprobe output' };
        }

        // Container runtime. Replaces guessing "this is a trailer" from file size:
        // ffprobe is already open on the file, so the real duration is free here.
        const rawDuration = parsed.format && parsed.format.duration;
        const durationSeconds = Number.isFinite(parseFloat(rawDuration)) ? parseFloat(rawDuration) : null;
        const implausibleRuntime = durationSeconds != null
            && durationSeconds > 0
            && durationSeconds < MIN_FEATURE_DURATION_SECONDS;

        const allStreams = parsed.streams || [];
        const videoStream = allStreams.find((s) => s.codec_type === 'video') || null;
        const dovi = videoStream && Array.isArray(videoStream.side_data_list)
            ? videoStream.side_data_list.find((d) => /dovi|dolby vision/i.test(String(d.side_data_type || ''))) : null;
        const videoInfo = videoStream ? {
            codec: videoStream.codec_name || null,
            profile: videoStream.profile || null,
            level: typeof videoStream.level === 'number' ? videoStream.level : null,
            pixFmt: videoStream.pix_fmt || null,
            hdr: /smpte2084|arib-std-b67/i.test(String(videoStream.color_transfer || '')),
            dvProfile: dovi && Number.isFinite(Number(dovi.dv_profile)) ? Number(dovi.dv_profile) : null,
        } : null;

        // Audio streams in file order, so the array index IS the audio-relative
        // index used by `-map 0:a:<idx>`.
        const tracks = allStreams.filter((s) => s.codec_type === 'audio').map((s, i) => {
            const tags = s.tags || {};
            const tagged = normLang(tags.language);
            const titled = tagged === 'und' ? langFromTitle(tags.title) : null;
            return {
                audioIndex: i,                       // for -map 0:a:<audioIndex>
                streamIndex: s.index,                // absolute index in the file
                lang: tagged !== 'und' ? tagged : (titled || 'und'),
                // where the language came from: what the stream reports beats a model's guess
                langSource: tagged !== 'und' ? 'tag' : (titled ? 'title' : 'none'),
                rawLang: tags.language || null,
                title: tags.title || null,
                codec: s.codec_name || null,
                channels: s.channels || null,
                isDefault: !!(s.disposition && s.disposition.default),
                browserSafe: isBrowserSafeAudio(s.codec_name),
            };
        });

        if (tracks.length === 0) {
            return { success: false, error: 'no audio tracks found' };
        }

        const defaultTrack = tracks.find((t) => t.isDefault) || tracks[0];
        const want = normLang(preferredLang || 'en');
        // 'multi' isn't a real language — treat it as "no preference".
        const wantsSpecific = want && want !== 'multi' && want !== 'und';
        const match = wantsSpecific ? tracks.find((t) => t.lang === want) : null;

        // The track that SHOULD play: a preferred-language match if one exists,
        // otherwise the file's default.
        const chosen = match || defaultTrack;
        // Tracks with no reported language: the player may ask 'detect-audio-language' for these, but only when no
        // reported track matched the preference (a guess never overrides what the stream says).
        const undetermined = tracks.filter((t) => t.lang === 'und').map((t) => t.audioIndex);

        // Direct playback is only safe when the browser can decode the track that
        // will actually play. Undecodable audio (DTS/TrueHD) plays silently, so
        // those must be routed through the remux even with a single track.
        const needsRemuxForCodec = !chosen.browserSafe;
        const needsRemuxForLang = chosen.audioIndex !== defaultTrack.audioIndex;

        const result = {
            success: true,
            tracks,
            videoInfo,
            durationSeconds,
            // Advisory only — the caller decides what to do, since episodes are
            // legitimately shorter than the feature-length floor.
            implausibleRuntime,
            count: tracks.length,
            defaultAudioIndex: defaultTrack.audioIndex,
            defaultLang: defaultTrack.lang,
            preferredLang: want,
            chosenAudioIndex: chosen.audioIndex,
            chosenLang: chosen.lang,
            chosenCodec: chosen.codec,
            // The track we WOULD switch to (null = nothing to do).
            suggestedAudioIndex: needsRemuxForLang ? chosen.audioIndex : null,
            mismatch: needsRemuxForLang,
            undetermined,
            needsDetection: !!(wantsSpecific && !match && undetermined.length > 0 && tracks.length > 1),
            needsRemux: needsRemuxForCodec || needsRemuxForLang,
            remuxReason: needsRemuxForLang
                ? 'language'
                : (needsRemuxForCodec ? `codec:${chosen.codec}` : null),
            elapsedMs: Date.now() - started,
        };

        console.log(
            `[audio-tracks] ${tracks.length} track(s) in ${result.elapsedMs}ms — ` +
            tracks.map((t) => `a:${t.audioIndex}=${t.lang}${t.isDefault ? '*' : ''}` +
                `${t.channels ? '/' + t.channels + 'ch' : ''}${t.codec ? '/' + t.codec : ''}`).join('  ')
        );
        if (needsRemuxForLang) {
            console.warn(
                `[audio-tracks] MISMATCH: default track is '${result.defaultLang}' but ` +
                `preferred '${want}' exists at a:${result.chosenAudioIndex} — remuxing to it`
            );
        } else if (needsRemuxForCodec) {
            console.warn(
                `[audio-tracks] '${chosen.codec}' cannot be decoded directly (silent playback) ` +
                `— remuxing a:${chosen.audioIndex} to AAC`
            );
        }

        return result;
    });

    // Speech detection for a track whose language the stream does not report: 20 s of it (from a fifth of the way
    // in, past intros and logos) sent to the local nemo-speech server (Nemotron 3.5 returns a language tag).
    ipcMain.handle('detect-audio-language', async (_event, { url, proxy, audioIndex = 0, durationSeconds } = {}) => {
        if (!url || typeof url !== 'string') return { success: false, error: 'No source provided' };
        const started = Date.now();
        const total = Number(durationSeconds) || 0;
        // a fifth of the way in (past intros and logos), 30 s to 15 min, and always leaving the 20 s sample
        let at = Math.max(30, Math.min(900, Math.round((total || 600) * 0.2)));
        if (total) at = Math.max(0, Math.min(at, Math.floor(total - 21)));
        const isRemote = /^https?:\/\//i.test(url);
        const args = ['-v', 'error', '-nostdin'];
        if (isRemote) args.push('-user_agent', 'Mozilla/5.0', '-reconnect', '1', '-reconnect_streamed', '1');
        args.push('-ss', String(at), '-i', url, '-map', `0:a:${Number(audioIndex) || 0}`, '-t', '20',
            '-ac', '1', '-ar', '16000', '-f', 'wav', 'pipe:1');
        let wav;
        try {
            wav = await new Promise((resolve, reject) => {
                execFile(utils.getFFmpegPath(), args, {
                    windowsHide: true, timeout: DETECT_TIMEOUT_MS, killSignal: 'SIGKILL', encoding: 'buffer',
                    maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...proxyEnv(proxy) },
                }, (err, stdout, stderr) => {
                    if (err && !(stdout && stdout.length)) return reject(new Error(String(stderr || err.message).slice(-200)));
                    resolve(stdout);
                });
            });
        } catch (e) {
            console.warn('[audio-tracks] detection sample failed:', e.message);
            return { success: false, error: 'could not read the audio track' };
        }
        if (!wav || wav.length < 16000 * 2 * 3) return { success: false, error: 'track too short or silent' };
        try {
            const form = new FormData();
            form.append('file', new Blob([wav], { type: 'audio/wav' }), 'sample.wav');
            form.append('response_format', 'verbose_json');
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), DETECT_TIMEOUT_MS);
            const res = await fetch(`${NEMO_SPEECH_URL}/v1/audio/transcriptions`, { method: 'POST', body: form, signal: controller.signal })
                .finally(() => clearTimeout(timer));
            if (!res.ok) return { success: false, error: `nemo-speech HTTP ${res.status}` };
            const j = await res.json();
            const lang = normLang(j.language);
            const words = String(j.text || '').trim().split(/\s+/).filter(Boolean).length;
            console.log(`[audio-tracks] a:${audioIndex} detected '${lang}' (${j.language}, ${words} words) in ${Date.now() - started}ms`);
            // too little speech to trust (music, effects): report nothing rather than a guess
            if (lang === 'und' || words < 5) return { success: false, error: 'not enough speech to tell' };
            return { success: true, audioIndex: Number(audioIndex) || 0, lang, rawLang: j.language, langSource: 'detected', words };
        } catch (e) {
            console.warn('[audio-tracks] nemo-speech failed:', e.message);
            return { success: false, error: 'speech detection unavailable' };
        }
    });
}

// H.264 profile name -> profile_idc, for the avc1.PPCCLL codec string.
const H264_PROFILE_IDC = {
    'baseline': 0x42, 'constrained baseline': 0x42,
    'main': 0x4d,
    'extended': 0x58,
    'high': 0x64, 'high 10': 0x6e, 'high 4:2:2': 0x7a, 'high 4:4:4 predictive': 0xf4,
};

/**
 * Build the MediaSource codec string for a `-c:v copy` remux (audio is always
 * re-encoded to AAC-LC, so the audio half is fixed).
 *
 * Returns null when the video codec can't be expressed reliably — the caller
 * then re-encodes to H.264 instead, which has a known-good codec string.
 */
function mseCodecForCopy(videoInfo) {
    if (!videoInfo || !videoInfo.codec) return null;
    const codec = String(videoInfo.codec).toLowerCase();

    if (codec === 'h264' || codec === 'avc1') {
        const idc = H264_PROFILE_IDC[String(videoInfo.profile || 'high').toLowerCase()];
        const level = videoInfo.level;
        if (!idc || !level) return null;
        const hex = (n) => n.toString(16).padStart(2, '0');
        // avc1.PPCCLL — profile_idc, constraint flags (0), level as hex.
        return `video/mp4; codecs="avc1.${hex(idc)}00${hex(level)}, mp4a.40.2"`;
    }

    if (codec === 'hevc' || codec === 'h265') {
        const level = videoInfo.level;
        if (!level) return null;
        // Dolby Vision profile 7 carries an enhancement layer and profile 5 has no HDR10 base: copied as plain HEVC
        // they break the decoder (MSE "SourceBuffer error" a few seconds in) or show wrong colours. Re-encode.
        if (videoInfo.dvProfile === 7 || videoInfo.dvProfile === 5) return null;
        // hvc1.<profile_idc>.<compat flags>.L<level>.<constraints>: Main = 1.6, Main 10 = 2.4. Every HEVC used to be
        // labelled Main (1.6), so a 10-bit HDR stream configured the decoder for 8-bit and failed mid-play.
        const p = String(videoInfo.profile || '').toLowerCase();
        const tenBit = /10/.test(p) || /10le|p010/i.test(String(videoInfo.pixFmt || ''));
        if (p && p !== 'main' && !/main 10/.test(p)) return null;     // Rext etc.: no dependable mapping
        return `video/mp4; codecs="${tenBit ? 'hvc1.2.4' : 'hvc1.1.6'}.L${level}.B0, mp4a.40.2"`;
    }

    // AV1/VP9/etc: no dependable mapping here — re-encode instead.
    return null;
}

module.exports = { registerAudioTracksIpc, mseCodecForCopy, normLang, langFromTitle };
