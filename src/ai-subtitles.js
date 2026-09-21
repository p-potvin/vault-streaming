// src/ai-subtitles.js — AI Subtitle pipeline via `vw better-subtitles`.
// Executes Start-BetterSubtitles.ps1 with -NoSeparate and all defaults,
// passing -TranslateTo "fr" -TranslateFrom "en" when translation is needed.
// Always generates .srt and converts to .vtt for browser rendering.

const path = require('path');
const fs = require('fs');
const os = require('os');
const child_process = require('child_process');
const utils = require('./utils');

// Active child processes to kill on abort or application shutdown
const activeProcesses = new Set();

function resolveBetterSubtitlesScript() {
    const candidates = [
        path.join(process.env.USERPROFILE || os.homedir(), 'Desktop', 'Github Repos', 'vault-commander', 'cli', 'Start-BetterSubtitles.ps1'),
        path.join(__dirname, '..', '..', 'vault-commander', 'cli', 'Start-BetterSubtitles.ps1'),
        path.join(__dirname, '..', '..', 'vault-commander-identify-video', 'cli', 'Start-BetterSubtitles.ps1')
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function srtToVtt(srtText) {
    if (!srtText) return 'WEBVTT\n\n';
    let vtt = srtText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    vtt = vtt.replace(/^\uFEFF/, '');
    vtt = vtt.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    vtt = vtt.replace(/(\d{2}:\d{2}),(\d{3})/g, '00:$1.$2');
    if (!vtt.trim().startsWith('WEBVTT')) {
        vtt = 'WEBVTT\n\n' + vtt;
    }
    return vtt;
}

function getSubtitlesSaveDir(shouldSavePermanently) {
    if (shouldSavePermanently) {
        const defaultWinSubs = path.join(process.env.USERPROFILE || os.homedir(), 'Videos', 'Subtitles');
        fs.mkdirSync(defaultWinSubs, { recursive: true });
        return defaultWinSubs;
    }
    const tempSubs = path.join(os.tmpdir(), 'vault-streaming', 'subtitles');
    fs.mkdirSync(tempSubs, { recursive: true });
    return tempSubs;
}

async function extractAudioFromStream(url, tempAudioPath) {
    const ffmpegPath = utils.getFFmpegPath ? utils.getFFmpegPath() : 'ffmpeg';
    fs.mkdirSync(path.dirname(tempAudioPath), { recursive: true });
    
    return new Promise((resolve, reject) => {
        // Extract 16kHz mono audio from HTTP stream
        const args = [
            '-y',
            '-i', url,
            '-vn',
            '-ac', '1',
            '-ar', '16000',
            '-c:a', 'pcm_s16le',
            tempAudioPath
        ];
        console.log('[ai-subtitles] extracting stream audio with ffmpeg:', args.join(' '));
        const proc = child_process.spawn(ffmpegPath, args, { windowsHide: true });
        activeProcesses.add(proc);

        proc.on('error', (err) => {
            activeProcesses.delete(proc);
            reject(err);
        });

        proc.on('close', (code) => {
            activeProcesses.delete(proc);
            if (code === 0 && fs.existsSync(tempAudioPath)) {
                resolve(tempAudioPath);
            } else {
                reject(new Error(`ffmpeg audio extraction failed with exit code ${code}`));
            }
        });
    });
}

function parseSrtCues(srtContent) {
    const cues = [];
    if (!srtContent) return cues;
    const blocks = srtContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split(/\n\s*\n/);
    
    for (const block of blocks) {
        const lines = block.trim().split('\n');
        if (lines.length < 2) continue;
        const timeLineIdx = lines[0].includes('-->') ? 0 : 1;
        if (!lines[timeLineIdx] || !lines[timeLineIdx].includes('-->')) continue;

        const timeParts = lines[timeLineIdx].split('-->').map(s => s.trim());
        const parseTime = (tStr) => {
            const m = tStr.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
            if (!m) return 0;
            return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseInt(m[4], 10) / 1000;
        };

        const start = parseTime(timeParts[0]);
        const end = parseTime(timeParts[1]);
        const text = lines.slice(timeLineIdx + 1).join('\n').trim();
        if (text) {
            cues.push({ start, end, text, index: cues.length + 1, partial: false });
        }
    }
    return cues;
}

async function runBetterSubtitles({
    videoPath,
    savePermanently = false,
    translateTo = null,
    onProgress = () => {},
    onCue = () => {}
}) {
    const scriptPath = resolveBetterSubtitlesScript();
    if (!scriptPath) {
        throw new Error('Start-BetterSubtitles.ps1 not found in vault-commander cli repository.');
    }

    const outputDir = getSubtitlesSaveDir(savePermanently);
    let inputMedia = videoPath;
    let tempAudioFile = null;

    const isHttp = /^https?:\/\//i.test(videoPath);
    if (isHttp) {
        onProgress({ status: 'extracting', message: 'Extracting audio from stream…' });
        tempAudioFile = path.join(os.tmpdir(), 'vault-streaming', `audio_${Date.now()}.wav`);
        await extractAudioFromStream(videoPath, tempAudioFile);
        inputMedia = tempAudioFile;
    }

    const args = [
        '-ExecutionPolicy', 'Bypass',
        '-NoProfile',
        '-File', scriptPath,
        '-Input', inputMedia,
        '-Output', outputDir,
        '-NoSeparate'
    ];

    // Translation flag handling
    const needsTranslation = translateTo && (translateTo.startsWith('fr') || translateTo.startsWith('qc'));
    if (needsTranslation) {
        args.push('-TranslateTo', 'fr', '-TranslateFrom', 'en');
    }

    console.log('[ai-subtitles] spawning powershell with args:', args.join(' '));
    onProgress({ status: 'running', message: 'Generating AI subtitles (vw better-subtitles)…' });

    return new Promise((resolve, reject) => {
        const proc = child_process.spawn('powershell.exe', args, {
            windowsHide: true,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
        });
        activeProcesses.add(proc);

        let stdoutBuf = '';
        let stderrBuf = '';

        proc.stdout.on('data', (d) => {
            const str = d.toString('utf8');
            stdoutBuf += str;
            console.log('[ai-subtitles:stdout]', str.trim());
        });

        proc.stderr.on('data', (d) => {
            const str = d.toString('utf8');
            stderrBuf += str;
            console.warn('[ai-subtitles:stderr]', str.trim());
        });

        proc.on('error', (err) => {
            activeProcesses.delete(proc);
            if (tempAudioFile) { try { fs.unlinkSync(tempAudioFile); } catch (_) {} }
            reject(err);
        });

        proc.on('close', (code) => {
            activeProcesses.delete(proc);
            if (tempAudioFile) { try { fs.unlinkSync(tempAudioFile); } catch (_) {} }

            // Look for generated .srt in outputDir
            try {
                const files = fs.readdirSync(outputDir)
                    .filter(f => f.toLowerCase().endsWith('.srt'))
                    .map(f => ({
                        name: f,
                        path: path.join(outputDir, f),
                        mtime: fs.statSync(path.join(outputDir, f)).mtimeMs
                    }))
                    .sort((a, b) => b.mtime - a.mtime);

                if (files.length === 0) {
                    return reject(new Error(`vw better-subtitles exited with code ${code} and no .srt was found in ${outputDir}`));
                }

                const srtFile = files[0];
                const srtContent = fs.readFileSync(srtFile.path, 'utf8');
                
                // Write WebVTT beside the .srt file every time
                const vttPath = srtFile.path.replace(/\.srt$/i, '.vtt');
                const vttContent = srtToVtt(srtContent);
                fs.writeFileSync(vttPath, vttContent, 'utf8');

                // Parse cues and emit them
                const parsedCues = parseSrtCues(srtContent);
                for (const c of parsedCues) {
                    onCue(c);
                }

                onProgress({ status: 'SUCCESS', cues: parsedCues.length, final: true });
                resolve({
                    success: true,
                    srtPath: srtFile.path,
                    vttPath,
                    path: vttPath,
                    cuesCount: parsedCues.length
                });
            } catch (scanErr) {
                reject(scanErr);
            }
        });
    });
}

function cleanupAllAiSubtitles() {
    console.log('[ai-subtitles] cleaning up processes and temp storage...');
    // Kill active child processes
    for (const proc of activeProcesses) {
        try {
            proc.kill('SIGKILL');
        } catch (_) {
            try { proc.kill(); } catch (__) {}
        }
    }
    activeProcesses.clear();

    // Clean temp vw-* folders and vault-streaming temp files
    try {
        const tmp = os.tmpdir();
        const entries = fs.readdirSync(tmp);
        for (const entry of entries) {
            if (entry.startsWith('vw-') || entry.startsWith('vault-streaming')) {
                const full = path.join(tmp, entry);
                try {
                    fs.rmSync(full, { recursive: true, force: true });
                } catch (_) {}
            }
        }
    } catch (_) {}
}

module.exports = {
    runBetterSubtitles,
    cleanupAllAiSubtitles,
    getSubtitlesSaveDir,
    srtToVtt
};
