"""Lazy ASR model access.

Two rules matter here and both come from the live-subs daemon, which is the
best-behaved torch process in the stack:

1. **Never import torch/NeMo until transcription is actually requested.** The
   monolith imported the Parakeet wrapper at module scope, so *every* action paid
   the multi-second import even when it only needed ffmpeg. Splitting the scripts
   is pointless if the import cost is unconditional.
2. **Load the model once per process and release it deterministically.** Batch
   runs reuse a single instance; :func:`release` drops the reference and hands
   the memory back so RAM does not creep across a long queue.

The wrapper lives in a differently-named package in each repo, so we probe.
"""

import gc
import importlib
import os
import subprocess
import tempfile
import time

from . import telemetry
from .progress import log

# Every known way a host project exposes the Parakeet wrapper, as
# (module path, class name), in preference order. vault-explorer, vault-streaming
# and vaultwares-media-processing each ship a package with the same module name;
# vw-cli keeps its ASR flat in utils/ under a different class name.
_WRAPPER_SOURCES = (
    ("vault_explorer.parakeet_wrapper", "ParakeetV3Wrapper"),
    ("vault_streaming.parakeet_wrapper", "ParakeetV3Wrapper"),
    ("vaultwares_media_processing.parakeet_wrapper", "ParakeetV3Wrapper"),
    ("vaultwares_realtime.parakeet_wrapper", "ParakeetV3Wrapper"),
    ("parakeet_wrapper", "ParakeetV3Wrapper"),
    ("parakeet_asr", "ParakeetTDTASR"),
)

_model = None
_model_name = None

# Load time is recorded against the transcription that paid for it, then
# cleared. Attributing a 20 s cold NeMo load to every later run in the same
# process would make a warm batch look as slow as a cold start.
_pending_load_ms = None

DEFAULT_MODEL = "nvidia/parakeet-tdt-0.6b-v3"


def _import_wrapper():
    errors = []
    for module_path, class_name in _WRAPPER_SOURCES:
        try:
            module = importlib.import_module(module_path)
            return getattr(module, class_name)
        except Exception as err:
            errors.append(f"{module_path}.{class_name}: {err}")
    raise ImportError(
        "Could not locate an ASR wrapper in any known host project.\n  "
        + "\n  ".join(errors)
    )


def get_model(model_name=None, status_callback=None):
    """Return the shared ASR model, loading it on first use."""
    global _model, _model_name

    requested = model_name or os.environ.get("VW_ASR_MODEL") or None
    if _model is not None and (requested is None or requested == _model_name):
        return _model

    if _model is not None:
        # A different model was asked for; free the old one before loading.
        release()

    global _pending_load_ms
    wrapper_cls = _import_wrapper()
    started = time.perf_counter()
    _model = wrapper_cls(**({"model_name": requested} if requested else {}),
                         status_callback=status_callback)
    _model_name = requested
    elapsed = time.perf_counter() - started
    _pending_load_ms = round(elapsed * 1000, 3)
    log("asr", f"Model ready in {elapsed:.1f}s")
    return _model


def release():
    """Drop the model and return its memory.

    Mirrors the live-subs teardown: clear the reference, collect, then empty the
    CUDA allocator cache so the next process (or the next model) starts clean.
    """
    global _model, _model_name
    if _model is None:
        return
    _model = None
    _model_name = None
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
    except Exception:
        pass


# ---------------------------------------------------------------- nemo-speech
# Default engine. The PyTorch/NeMo wrapper below stays as a fallback, but it is
# no longer the first choice: it pulls torch and the NeMo stack into the process
# for a job that a 1.3 MB native binary already does, and the native path shares
# the same engine, models and defaults as the `vw better-subtitles` command, so
# a transcript produced here matches one produced there.
#
# parakeet-tdt is the default to match vault-commander. Measured on 111 minutes
# of podcast it returned 20,565 words with 3.6 minutes of gaps in 59 s, against
# nemotron-3.5's 18,984 words, 14.2 minutes of gaps and 339 s. nemotron-3.5 is
# still the one to pick for multilingual or code-switched audio -- set
# VW_ASR_MODEL=nemotron-3.5 -- because it is the only model that takes a
# language prompt or reports a detected language.
NEMO_SPEECH_MODEL = "parakeet-tdt"

_CUDA_BIN = (
    r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.3\bin\x64",
    r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.3\bin",
)


def find_nemo_speech():
    """Locate nemo-speech.exe, or return None if this machine has no build.

    Mirrors the search vault-commander's subtitles_server.py uses, including the
    build order: build-cuda is the production build, build-s2s is the same CUDA
    configuration plus the S2S targets, build-norelpos is the relpos-off variant
    kept for A/B work.
    """
    override = os.environ.get("VW_NEMO_SPEECH")
    if override:
        p = override
        if os.path.isdir(p):
            p = os.path.join(p, "nemo-speech.exe")
        if os.path.isfile(p):
            return p
        return None

    here = os.path.dirname(os.path.abspath(__file__))
    repos = os.path.abspath(os.path.join(here, "..", "..", ".."))
    roots = [
        os.path.join(repos, "vault-cacophony", "NeMo-Speech.cpp"),
        os.path.join(os.path.expanduser("~"), "Desktop", "Github Repos",
                     "vault-cacophony", "NeMo-Speech.cpp"),
    ]
    for build in ("build-cuda", "build-s2s", "build-norelpos"):
        for root in roots:
            exe = os.path.join(root, build, "bin", "nemo-speech.exe")
            if os.path.isfile(exe):
                return exe
    return None


def _nemo_speech_transcribe(wav_path, language, model_name, status_callback):
    """Transcribe through nemo-speech.exe, returning segment dicts.

    The engine writes SRT itself, so the cue grouping is the engine's rather
    than a second implementation here, and subtitles.read_srt turns it straight
    back into the {"start","end","text"} contract this module already returns.
    """
    from . import subtitles as _subtitles

    exe = find_nemo_speech()
    if not exe:
        return None

    if status_callback:
        status_callback(f"Transcribing with {model_name}...")

    out_dir = tempfile.mkdtemp(prefix="vw_asr_")
    out_srt = os.path.join(out_dir, "out.srt")
    cmd = [exe, "transcribe", "--model", model_name,
           "-f", "srt", "-o", out_srt, wav_path]
    # Only the nemotron models are prompt-conditioned; parakeet takes no
    # language and ignores it.
    if language and model_name.startswith("nemotron"):
        cmd += ["-l", language]

    env = os.environ.copy()
    existing = env.get("PATH", "")
    env["PATH"] = os.pathsep.join([p for p in _CUDA_BIN if os.path.isdir(p)] + [existing])

    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, env=env)
        if proc.returncode != 0 or not os.path.isfile(out_srt):
            detail = (proc.stderr or proc.stdout or "").strip().splitlines()
            raise RuntimeError(
                "nemo-speech transcribe failed (exit {}): {}".format(
                    proc.returncode, detail[-1] if detail else "no output"))
        return _subtitles.read_srt(out_srt)
    finally:
        try:
            if os.path.isfile(out_srt):
                os.remove(out_srt)
            os.rmdir(out_dir)
        except OSError:
            pass


def transcribe(wav_path, language="en", model=None, status_callback=None):
    """Transcribe *wav_path*, returning segment dicts.

    Returns ``[{"start": float, "end": float, "text": str}, ...]``. An empty list
    means the model ran but found no speech — callers must treat that as a real
    result, not as a reason to substitute placeholder text.
    """
    global _pending_load_ms

    audio_seconds = telemetry.audio_duration_seconds(wav_path)

    with telemetry.run(
        model=_model_name or DEFAULT_MODEL,
        task="audio-asr",
        service="vw-media-asr",
        audio_seconds=audio_seconds,
        language=language,
    ) as run:
        # nemo-speech first: same engine, models and defaults as the
        # `vw better-subtitles` command, and no torch import. Falls through to
        # the PyTorch wrapper when no build is present on this machine, or when
        # VW_ASR_ENGINE=torch pins it explicitly.
        result = None
        if model is None and os.environ.get("VW_ASR_ENGINE", "").lower() != "torch":
            native_model = (
                os.environ.get("VW_ASR_MODEL") or NEMO_SPEECH_MODEL)
            result = _nemo_speech_transcribe(
                wav_path, language, native_model, status_callback)
            if result is not None:
                run.set(model=native_model)
                run.tag("nemo-speech")

        if result is None:
            engine = model or get_model(status_callback=status_callback)
            if _pending_load_ms is not None:
                run.set(load_ms=_pending_load_ms)
                _pending_load_ms = None
                run.tag("cold-start")
            # The model name is only known once the wrapper has resolved it.
            run.set(model=getattr(engine, "model_name", None) or _model_name or DEFAULT_MODEL)

            segments = engine.transcribe_file(wav_path, language=language) or []
            result = [
                {"start": float(seg.start), "end": float(seg.end), "text": str(seg.text)}
                for seg in segments
            ]

        # Zero segments is a real answer -- silence -- not a failure, so it is
        # recorded as a successful run with no output rather than an error.
        run.set(
            segment_count=len(result),
            completion_chars=sum(len(item["text"]) for item in result),
        )
        return result
