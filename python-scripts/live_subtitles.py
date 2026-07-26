"""
live_subtitles.py — real-time streaming ASR subtitles for local playback.

Runs as a long-lived **daemon** so the heavy model is loaded exactly once per app
session (NeMo import + untarring the 2.5 GB .nemo costs ~29s; the GPU upload is
only 0.3s of that). The Electron main process spawns this once, ~3s after the UI
finishes loading, and then drives it over stdin with JSON commands:

    {"cmd":"start","videoPath":..,"langs":[..],"volumeBoost":1.5,"start":12.0,
     "translateTo":"fr"}      -> begin a streaming session (replaces any current)
    {"cmd":"stop"}            -> stop the current session
    {"cmd":"quit"}           -> exit the daemon

Engine: ``nvidia/nemotron-3.5-asr-streaming-0.6b`` (FastConformer-CacheAware-RNNT,
multilingual). Audio is fed as fixed 1.12s chunks and the model carries its own
encoder/decoder cache, so each step returns the transcription so far — no
re-transcribing a growing buffer, and no racing ahead of the playhead.

This model emits **no timestamps**, so cue times come from the stream position:
we know exactly how much audio has been fed (chunks x chunk duration), which is
both simpler and more reliable than the old word-timestamp segmentation. A cue is
closed on a real pause (silence >= ``minSilence``) or at ``maxUtt`` seconds, and
the model state is reset at that boundary to bound hypothesis growth. With
``translateTo`` set, finalised text is translated (source auto) before display/SRT.

Cues/status are emitted as tagged JSON lines on stdout, each carrying videoPath.
"""

import os
import sys
import json
import time
import queue
import threading
import subprocess

# UTF-8 everywhere — subtitle text is multilingual. The spawn env also sets
# PYTHONUTF8/PYTHONIOENCODING as a belt-and-suspenders guarantee.
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

os.environ["PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION"] = "python"

_script_dir = os.path.dirname(os.path.abspath(__file__))
_project_root = os.path.abspath(os.path.join(_script_dir, ".."))
sys.path.insert(0, _project_root)


def emit(tag, payload):
    try:
        print(f"{tag}:{json.dumps(payload, ensure_ascii=False)}", flush=True)
    except Exception:
        pass


def dbg(msg):
    try:
        print(f"[live-subs] {msg}", file=sys.stderr, flush=True)
    except Exception:
        pass


def redact(value):
    """
    Strip the Comet base64 config segment from a URL before logging — it embeds
    the AllDebrid / TorBox / Real-Debrid API keys.
    """
    import re
    return re.sub(r"/eyJ[^/\s]+", "/<config>", str(value))


# ---------------------------------------------------------------------------
# SRT sidecar writer — its own thread so file I/O never stalls ASR.
# ---------------------------------------------------------------------------
def _fmt_ts(seconds):
    if seconds < 0:
        seconds = 0.0
    ms = int(round((seconds - int(seconds)) * 1000))
    s = int(seconds)
    h, s = divmod(s, 3600)
    m, s = divmod(s, 60)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


class SrtWriter(threading.Thread):
    def __init__(self, srt_path):
        super().__init__(daemon=True)
        self.srt_path = srt_path
        self.q = queue.Queue()
        self._idx = 0
        self._fh = None

    def run(self):
        try:
            self._fh = open(self.srt_path, "w", encoding="utf-8")
        except Exception as e:
            emit("LIVE_STATUS", {"status": "warn", "message": f"SRT open failed: {e}"})
            return
        while True:
            cue = self.q.get()
            if cue is None:
                break
            self._idx += 1
            try:
                self._fh.write(
                    f"{self._idx}\n"
                    f"{_fmt_ts(cue['start'])} --> {_fmt_ts(cue['end'])}\n"
                    f"{cue['text'].strip()}\n\n"
                )
                self._fh.flush()
            except Exception:
                pass
            self.q.task_done()
        try:
            if self._fh:
                self._fh.close()
        except Exception:
            pass

    def submit(self, cue):
        self.q.put(cue)

    def close(self):
        self.q.put(None)


def build_ffmpeg_cmd(video_path, start, sample_rate, volume_boost):
    af = (
        "highpass=f=90,"
        "lowpass=f=7500,"
        "afftdn=nf=-25,"
        "dynaudnorm=f=200:g=15,"
        f"volume={volume_boost:.3f}"
    )
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin"]
    # Remote sources: this is a SECOND connection to a link the player is already
    # streaming, so a debrid provider can answer 429 (rate limit). Reconnect with
    # backoff instead of dying, and identify as a normal client.
    if str(video_path).lower().startswith(("http://", "https://")):
        cmd += [
            "-reconnect", "1",
            "-reconnect_streamed", "1",
            "-reconnect_delay_max", "10",
            "-user_agent", "Mozilla/5.0",
        ]
    if start and start > 0.05:
        cmd += ["-ss", f"{start:.3f}"]
    cmd += [
        "-i", video_path,
        # Force the FIRST audio track. Without -map, ffmpeg auto-selects the
        # stream with the most channels, which on a multi-audio release is often a
        # 5.1 foreign dub — so the model transcribed Czech/Polish while the <video>
        # element (which plays the first/default track) played English. 0:a:0
        # matches what the browser plays, keeping ASR and playback on the same audio.
        "-map", "0:a:0",
        "-vn",
        "-af", af,
        "-f", "s16le", "-ac", "1", "-ar", str(sample_rate),
        "pipe:1",
    ]
    return cmd


class Translator:
    """Lazy GoogleTranslator (deep_translator) with a per-session text cache."""

    def __init__(self, target):
        self.target = target
        self._impl = None
        self._cache = {}

    def _ensure(self):
        if self._impl is None:
            from deep_translator import GoogleTranslator
            self._impl = GoogleTranslator(source="auto", target=self.target)

    def translate(self, text):
        if not text:
            return text
        if text in self._cache:
            return self._cache[text]
        try:
            self._ensure()
            out = self._impl.translate(text) or text
        except Exception as e:
            dbg(f"translate failed ({e}); using source text")
            out = text
        self._cache[text] = out
        return out


# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------
def load_model():
    t0 = time.perf_counter()
    from vault_explorer.nemotron_wrapper import NemotronStreamingASR, DEFAULT_CHUNK_S
    chunk_s = float(os.environ.get("VAULT_ASR_CHUNK_S") or DEFAULT_CHUNK_S)
    m = NemotronStreamingASR(chunk_s=chunk_s)
    dbg(f"Nemotron streaming model loaded in {time.perf_counter() - t0:.1f}s (chunk={m.chunk_s}s)")
    return m


# ---------------------------------------------------------------------------
# One streaming session (runs on its own thread; checks stop_event to abort)
# ---------------------------------------------------------------------------
def run_session(model, opts, stop_event):
    import numpy as np

    video_path = opts["videoPath"]
    is_remote = video_path.lower().startswith(("http://", "https://"))
    if not is_remote:
        video_path = os.path.abspath(video_path)
        if not os.path.exists(video_path):
            emit("JSON_STATUS", {"status": "FAILED", "error": f"File not found: {video_path}",
                                 "videoPath": video_path, "final": True})
            return

    langs = [l for l in (opts.get("langs") or ["en"]) if l] or ["en"]
    primary_lang = langs[0]
    volume_boost = min(2.5, max(1.0, float(opts.get("volumeBoost") or 1.5)))
    start = max(0.0, float(opts.get("start") or 0.0))
    translate_to = (opts.get("translateTo") or "").strip() or None

    # A quiet stretch this long closes the current cue. With 1.12s chunks a
    # single silent chunk already qualifies, which is the natural line break.
    min_silence = max(0.2, float(opts.get("minSilence") or 0.8))
    max_utt_s = max(4.0, float(opts.get("maxUtt") or 12.0))

    sample_rate = 16000
    silence_rms = 0.006

    translator = Translator(translate_to) if translate_to else None

    # SRT sidecar is OPT-IN (default off) and only for local files — there's
    # nowhere to write a sidecar next to a remote http(s) stream URL.
    write_srt = bool(opts.get("writeSrt"))
    is_remote = video_path.lower().startswith(("http://", "https://"))
    srt_path = None
    writer = None
    if write_srt and not is_remote:
        base, _ = os.path.splitext(video_path)
        srt_path = f"{base}.{primary_lang}.srt"
        writer = SrtWriter(srt_path)
        writer.start()
    elif write_srt and is_remote:
        dbg("writeSrt requested but source is a remote URL — skipping sidecar")

    dbg(f"session: video={redact(video_path)!r} langs={langs} boost={volume_boost} start={start:.2f}s "
        f"translateTo={translate_to} writeSrt={write_srt and not is_remote} min_silence={min_silence}s max_utt={max_utt_s}s")

    emit("LIVE_STATUS", {"status": "started", "message": "Live subtitles running",
                         "videoPath": video_path, "srtPath": srt_path, "startTime": start,
                         "translateTo": translate_to})

    ff_cmd = build_ffmpeg_cmd(video_path, start, sample_rate, volume_boost)
    dbg(f"ffmpeg: {redact(' '.join(ff_cmd))}")
    try:
        proc = subprocess.Popen(ff_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except Exception as e:
        if writer:
            writer.close()
        emit("JSON_STATUS", {"status": "FAILED", "error": f"ffmpeg spawn failed: {e}",
                             "videoPath": video_path, "final": True})
        return

    read_bytes = 16384
    buf = np.zeros(0, dtype=np.int16)
    stream_pos = start          # absolute time of all audio fed to the model
    utt_start = start           # absolute start of the utterance being built
    utt_text = ""               # accumulated text for the current utterance
    silence_run = 0.0           # consecutive quiet seconds fed
    last_final_end = start
    final_count = [0]
    cue_index = [0]

    # Cache-aware streaming: the model takes fixed chunks and carries its own
    # state, so we feed exactly chunk_samples() at a time and derive cue times
    # from how much audio has been fed (no timestamps from this model).
    chunk_samples = model.chunk_samples()
    chunk_dur = chunk_samples / sample_rate
    model.reset()

    def emit_final(seg_start, seg_end, text):
        nonlocal last_final_end
        t = (text or "").strip()
        if not t or seg_start < last_final_end - 0.05:
            return
        if translator:
            t = translator.translate(t)
        cue_index[0] += 1
        final_count[0] += 1
        cue = {"index": cue_index[0], "start": round(seg_start, 3), "end": round(seg_end, 3),
               "text": t, "lang": primary_lang, "partial": False, "videoPath": video_path}
        emit("SUBTITLE_CUE", cue)
        if writer:
            writer.submit(cue)
        last_final_end = max(last_final_end, seg_end)
        dbg(f"  FINAL #{cue_index[0]} [{seg_start:.2f}-{seg_end:.2f}] {t!r}")

    def feed_chunk(piece_i16, chunk_start):
        """
        Push one fixed chunk into the streaming model and update utterance state.
        Returns True if a cue was finalised.
        """
        nonlocal utt_text, utt_start, silence_run

        audio_f32 = piece_i16.astype(np.float32) / 32768.0
        rms = float(np.sqrt(np.mean(audio_f32 ** 2))) if audio_f32.size else 0.0
        if rms < silence_rms:
            silence_run += chunk_dur
        else:
            silence_run = 0.0

        try:
            text_now = (model.feed(audio_f32) or "").strip()
        except Exception as e:
            dbg(f"ASR error: {e}")
            return False

        if text_now and text_now != utt_text:
            # First words of a new utterance: anchor it to this chunk's start so
            # the cue doesn't stretch back across preceding silence.
            if not utt_text:
                utt_start = chunk_start
            utt_text = text_now
            silence_run = 0.0          # decoded speech is not a pause

        # Finalise on a real pause, or when an utterance has run too long.
        if utt_text and (silence_run >= min_silence or (stream_pos - utt_start) >= max_utt_s):
            emit_final(utt_start, stream_pos, utt_text)
            model.reset()              # bound hypothesis growth at a safe boundary
            utt_text = ""
            utt_start = stream_pos
            silence_run = 0.0
            return True

        if not utt_text:
            # Idle silence: keep the origin current so the next cue starts at the
            # speech, and periodically clear state during long quiet stretches.
            utt_start = stream_pos
            if silence_run >= max(4.0, min_silence * 3):
                model.reset()
                silence_run = 0.0
        return False

    dbg(f"reading ffmpeg audio stream (chunk={chunk_dur:.2f}s / {chunk_samples} samples)...")
    total_bytes = 0
    stopped = False
    try:
        while True:
            if stop_event.is_set():
                stopped = True
                dbg("stop requested")
                break
            chunk = proc.stdout.read(read_bytes)
            if not chunk:
                dbg(f"ffmpeg stream ended (read {total_bytes} bytes)")
                break
            total_bytes += len(chunk)
            samples = np.frombuffer(chunk, dtype=np.int16)
            buf = np.concatenate([buf, samples]) if buf.size else samples.copy()

            # Feed every complete chunk the buffer can supply.
            while buf.size >= chunk_samples:
                piece = buf[:chunk_samples]
                buf = buf[chunk_samples:]
                chunk_start = stream_pos
                stream_pos += chunk_dur
                feed_chunk(piece, chunk_start)
                if stop_event.is_set():
                    break

        # Natural end: pad the tail to a full chunk, flush it, then emit whatever
        # utterance is still open (skip on manual stop).
        if not stopped:
            if buf.size:
                pad = np.zeros(chunk_samples, dtype=np.int16)
                pad[:buf.size] = buf
                chunk_start = stream_pos
                stream_pos += buf.size / sample_rate
                feed_chunk(pad, chunk_start)
            if utt_text:
                emit_final(utt_start, stream_pos, utt_text)
    finally:
        try:
            proc.terminate()
        except Exception:
            pass
        if writer:
            writer.close()
            writer.join(timeout=3.0)

    if stopped:
        emit("LIVE_STATUS", {"status": "stopped", "videoPath": video_path})
    else:
        emit("JSON_STATUS", {"status": "SUCCESS", "srtPath": srt_path, "cues": final_count[0],
                             "videoPath": video_path, "final": True})
    dbg(f"session done: finals={final_count[0]} stopped={stopped}")


# ---------------------------------------------------------------------------
# Daemon: load once, take start/stop/quit commands on stdin
# ---------------------------------------------------------------------------
def run_daemon():
    emit("LIVE_STATUS", {"status": "loading", "message": "Loading Nemotron streaming ASR model..."})
    try:
        model = load_model()
    except Exception as e:
        dbg(f"model load FAILED: {e}")
        emit("LIVE_STATUS", {"status": "error", "message": f"Model load failed: {e}"})
        emit("DAEMON", {"ready": False})
        return
    emit("LIVE_STATUS", {"status": "ready", "message": "Model ready"})
    emit("DAEMON", {"ready": True})
    dbg("daemon ready — awaiting commands")

    cur_thread = None
    cur_stop = None

    def stop_current():
        nonlocal cur_thread, cur_stop
        if cur_thread and cur_thread.is_alive():
            cur_stop.set()
            cur_thread.join(timeout=6.0)
        cur_thread = None
        cur_stop = None

    while True:
        line = sys.stdin.readline()
        if not line:
            break  # stdin closed — parent gone
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except Exception:
            dbg(f"bad command: {line!r}")
            continue

        action = cmd.get("cmd")
        if action == "start":
            stop_current()
            cur_stop = threading.Event()
            cur_thread = threading.Thread(target=run_session, args=(model, cmd, cur_stop), daemon=True)
            cur_thread.start()
        elif action == "stop":
            stop_current()
        elif action == "quit":
            stop_current()
            break

    dbg("daemon exiting")


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Live streaming ASR subtitles (Nemotron cache-aware streaming)")
    parser.add_argument("--daemon", action="store_true", help="Run as a persistent stdin-driven daemon")
    # One-shot CLI mode (handy for testing): pass a video path directly.
    parser.add_argument("video_path", nargs="?", default=None)
    parser.add_argument("--langs", default="en")
    parser.add_argument("--volume-boost", type=float, default=1.5)
    parser.add_argument("--start", type=float, default=0.0)
    parser.add_argument("--translate-to", default=None)
    args = parser.parse_args()

    if args.daemon or not args.video_path:
        run_daemon()
        return

    # One-shot: load then run a single session synchronously.
    model = load_model()
    opts = {
        "videoPath": args.video_path,
        "langs": [l.strip() for l in args.langs.split(",") if l.strip()],
        "volumeBoost": args.volume_boost,
        "start": args.start,
        "translateTo": args.translate_to,
    }
    run_session(model, opts, threading.Event())


if __name__ == "__main__":
    main()
