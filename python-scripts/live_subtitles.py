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

Engine: ``nvidia/parakeet-tdt-0.6b-v3`` (multilingual, word timestamps). We keep
a growing buffer of audio since the last finalised utterance and re-transcribe it
every ~0.6s, segmenting on the model's word-gap boundaries: settled segments are
finalised (and trimmed from the buffer), the newest is emitted as a live
"partial". With ``translateTo`` set, finalised text is translated (source auto)
before display/SRT; partials stay in the source language for responsiveness.

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


# ---------------------------------------------------------------------------
# SRT sidecar writer — its own thread so file I/O never stalls ASR.



def build_ffmpeg_cmd(video_path, start, sample_rate, volume_boost):
    af = (
        "highpass=f=90,"
        "lowpass=f=7500,"
        "afftdn=nf=-25,"
        "dynaudnorm=f=200:g=15,"
        f"volume={volume_boost:.3f}"
    )
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin"]
    if start and start > 0.05:
        cmd += ["-ss", f"{start:.3f}"]
    cmd += [
        "-i", video_path,
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
    from vault_explorer.parakeet_wrapper import ParakeetV3Wrapper
    m = ParakeetV3Wrapper()
    dbg(f"TDT model loaded in {time.perf_counter() - t0:.1f}s")
    return m


# ---------------------------------------------------------------------------
# One streaming session (runs on its own thread; checks stop_event to abort)
# ---------------------------------------------------------------------------
def run_session(model, opts, stop_event):
    import numpy as np

    video_path = os.path.abspath(opts["videoPath"])
    if not os.path.exists(video_path):
        emit("JSON_STATUS", {"status": "FAILED", "error": f"File not found: {video_path}",
                             "videoPath": video_path, "final": True})
        return

    langs = [l for l in (opts.get("langs") or ["en"]) if l] or ["en"]
    primary_lang = langs[0]
    volume_boost = min(2.5, max(1.0, float(opts.get("volumeBoost") or 1.5)))
    start = max(0.0, float(opts.get("start") or 0.0))
    translate_to = (opts.get("translateTo") or "").strip() or None

    step_s = float(opts.get("step") or 0.6)
    # Calmer pacing: merge words separated by <0.8s into one line, and drop
    # sub-0.3s blips — fewer, longer, more readable cues.
    min_silence = max(0.2, float(opts.get("minSilence") or 0.8))
    min_segment = max(0.1, float(opts.get("minSegment") or 0.3))
    max_utt_s = max(4.0, float(opts.get("maxUtt") or 12.0))

    sample_rate = 16000
    step_samples = int(max(0.2, step_s) * sample_rate)
    min_samples = int(0.3 * sample_rate)
    silence_rms = 0.006
    keep_lookahead = int(0.3 * sample_rate)

    translator = Translator(translate_to) if translate_to else None

    dbg(f"session: video={video_path!r} langs={langs} boost={volume_boost} start={start:.2f}s "
        f"translateTo={translate_to} min_silence={min_silence}s max_utt={max_utt_s}s")

    emit("LIVE_STATUS", {"status": "started", "message": "Live subtitles running",
                         "videoPath": video_path, "startTime": start,
                         "translateTo": translate_to})

    ff_cmd = build_ffmpeg_cmd(video_path, start, sample_rate, volume_boost)
    dbg(f"ffmpeg: {' '.join(ff_cmd)}")
    try:
        proc = subprocess.Popen(ff_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except Exception as e:
        emit("JSON_STATUS", {"status": "FAILED", "error": f"ffmpeg spawn failed: {e}",
                             "videoPath": video_path, "final": True})
        return

    read_bytes = 16384
    buf = np.zeros(0, dtype=np.int16)
    utt_start = start
    stream_pos = start
    last_tx_len = 0
    last_final_end = start
    final_count = [0]
    cue_index = [0]

    def transcribe(buffer_i16):
        audio_f32 = buffer_i16.astype(np.float32) / 32768.0
        try:
            return model.transcribe_audio_data(
                audio_f32, min_silence_s=min_silence, min_segment_s=min_segment, language=primary_lang
            ) or []
        except Exception as e:
            dbg(f"ASR error: {e}")
            return []

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
        last_final_end = max(last_final_end, seg_end)
        dbg(f"  FINAL #{cue_index[0]} [{seg_start:.2f}-{seg_end:.2f}] {t!r}")

    def reset_after(abs_time):
        nonlocal buf, utt_start, last_tx_len
        drop = max(0, int((abs_time - utt_start) * sample_rate))
        buf = buf[drop:] if drop < buf.size else np.zeros(0, dtype=np.int16)
        utt_start = abs_time
        last_tx_len = buf.size

    dbg("reading ffmpeg audio stream...")
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
            stream_pos = start + total_bytes / 2 / sample_rate

            if (buf.size - last_tx_len) < step_samples:
                continue
            last_tx_len = buf.size

            audio_f32 = buf.astype(np.float32) / 32768.0
            rms = float(np.sqrt(np.mean(audio_f32 ** 2))) if audio_f32.size else 0.0

            # Whole-buffer RMS: only quiet when nothing is mid-utterance, so it's
            # safe to shed the leading silence without dropping speech.
            if rms < silence_rms:
                if buf.size > keep_lookahead:
                    dropped = buf.size - keep_lookahead
                    utt_start += dropped / sample_rate
                    buf = buf[-keep_lookahead:]
                    last_tx_len = buf.size
                continue

            if buf.size < min_samples:
                continue

            segs = transcribe(buf)
            if not segs:
                if (stream_pos - utt_start) > 2.0:
                    reset_after(stream_pos - keep_lookahead / sample_rate)
                continue

            # Finals only: settled segments (a real pause follows) are emitted;
            # the newest segment stays buffered until its own pause arrives.
            segs_abs = [(utt_start + s.start, utt_start + s.end, s.text) for s in segs]
            if len(segs_abs) >= 2:
                for s0, s1, txt in segs_abs[:-1]:
                    emit_final(s0, s1, txt)
                reset_after(segs_abs[-2][1])
            else:
                s0, s1, txt = segs_abs[0]
                if (stream_pos - s1) >= min_silence or (stream_pos - utt_start) >= max_utt_s:
                    emit_final(s0, s1, txt)
                    reset_after(s1)

        # Natural end: flush trailing speech (skip on manual stop).
        if not stopped and buf.size >= min_samples:
            for s in transcribe(buf):
                emit_final(utt_start + s.start, utt_start + s.end, s.text)
    finally:
        try:
            proc.terminate()
        except Exception:
            pass

    if stopped:
        emit("LIVE_STATUS", {"status": "stopped", "videoPath": video_path})
    else:
        emit("JSON_STATUS", {"status": "SUCCESS", "cues": final_count[0],
                             "videoPath": video_path, "final": True})
    dbg(f"session done: finals={final_count[0]} stopped={stopped}")


# ---------------------------------------------------------------------------
# Daemon: load once, take start/stop/quit commands on stdin
# ---------------------------------------------------------------------------
def run_daemon():
    emit("LIVE_STATUS", {"status": "loading", "message": "Loading Parakeet-TDT model..."})
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
    parser = argparse.ArgumentParser(description="Live streaming ASR subtitles (Parakeet-TDT)")
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
