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

// ISO 639-2/B -> 639-1 for the tags ffprobe reports (eng, fre, rus, ...).
const LANG_MAP = {
    eng: 'en', en: 'en',
    fre: 'fr', fra: 'fr', fr: 'fr',
    rus: 'ru', ru: 'ru',
    spa: 'es', es: 'es',
    ger: 'de', deu: 'de', de: 'de',
    ita: 'it', it: 'it',
    por: 'pt', pt: 'pt',
    dut: 'nl', nld: 'nl', nl: 'nl',
    pol: 'pl', pl: 'pl',
    cze: 'cs', ces: 'cs', cs: 'cs',
    jpn: 'ja', ja: 'ja',
    kor: 'ko', ko: 'ko',
    chi: 'zh', zho: 'zh', zh: 'zh',
    hin: 'hi', hi: 'hi',
    ara: 'ar', ar: 'ar',
    tur: 'tr', tr: 'tr',
    ukr: 'uk', uk: 'uk',
    swe: 'sv', sv: 'sv',
    hun: 'hu', hu: 'hu',
};

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

// A movie shorter than this is a trailer, sample, or the wrong file inside the
// release — no legitimate feature runs under 15 minutes. Episodes legitimately
// do, so callers only apply this to movies.
const MIN_FEATURE_DURATION_SECONDS = 15 * 60;

function normLang(tag) {
    if (!tag) return 'und';
    const t = String(tag).toLowerCase().split(/[-_]/)[0];
    return LANG_MAP[t] || t;
}

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
            '-show_entries', 'stream=index,codec_type,codec_name,profile,level,channels,disposition:stream_tags=language,title:format=duration',
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
        const videoInfo = videoStream ? {
            codec: videoStream.codec_name || null,
            profile: videoStream.profile || null,
            level: typeof videoStream.level === 'number' ? videoStream.level : null,
        } : null;

        // Audio streams in file order, so the array index IS the audio-relative
        // index used by `-map 0:a:<idx>`.
        const tracks = allStreams.filter((s) => s.codec_type === 'audio').map((s, i) => {
            const tags = s.tags || {};
            return {
                audioIndex: i,                       // for -map 0:a:<audioIndex>
                streamIndex: s.index,                // absolute index in the file
                lang: normLang(tags.language),
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
        // hvc1.<profile_space><profile_idc>.<compat>.L<level>.<constraints>
        return `video/mp4; codecs="hvc1.1.6.L${level}.B0, mp4a.40.2"`;
    }

    // AV1/VP9/etc: no dependable mapping here — re-encode instead.
    return null;
}

module.exports = { registerAudioTracksIpc, mseCodecForCopy };
