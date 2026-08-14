"""Model-run telemetry bridge for the media scripts.

Records one run per model invocation through ``vaultwares_adk.telemetry``, so
local ASR sits in the same series as HuggingFace, Ollama and ComfyUI work
instead of being invisible.

Two constraints shape this file, both from asr.py's own rules:

* **Nothing heavy at import time.** asr.py exists because importing torch/NeMo
  unconditionally made every ffmpeg-only action pay a multi-second penalty. The
  recorder is stdlib-only, but it is still resolved lazily and cached so a
  script that never transcribes pays nothing.
* **Never break the caller.** Every function here swallows its own errors. A
  transcription must not fail because telemetry could not be recorded.

The ADK is resolved from the vendored submodule when it is not installed, so
this works in a checkout that has only run ``git submodule update --init``.
"""

from __future__ import annotations

import os
import sys
import wave
from pathlib import Path
from typing import Any, Optional

_adk: Any = None
_state = "unloaded"  # unloaded | ready | unavailable


def _load() -> bool:
    """Resolve vaultwares_adk.telemetry once, tolerating its absence."""
    global _adk, _state
    if _state != "unloaded":
        return _state == "ready"

    # Walk up looking for the vendored submodule; the scripts run from several
    # working directories (Electron spawn, CLI, tests).
    here = Path(__file__).resolve()
    candidates = [os.environ.get("VW_ADK_PATH")]
    for parent in list(here.parents)[:5]:
        candidates.append(str(parent / "vaultwares-adk"))
    for candidate in candidates:
        if candidate and Path(candidate).is_dir() and candidate not in sys.path:
            sys.path.insert(0, candidate)

    try:
        from vaultwares_adk import telemetry  # type: ignore

        _adk = telemetry
        _state = "ready"
    except Exception:
        _adk = None
        _state = "unavailable"
    return _state == "ready"


def available() -> bool:
    return _load()


def audio_duration_seconds(path: str) -> Optional[float]:
    """Length of a WAV, for the real-time factor.

    RTF (processing time / audio length) is the metric that actually matters
    for ASR -- a 40 s transcription means nothing until you know whether the
    clip was 30 s or 3 hours. Read with the stdlib wave module rather than
    ffprobe so this costs no subprocess.
    """
    try:
        with wave.open(str(path), "rb") as handle:
            rate = handle.getframerate()
            if not rate:
                return None
            return round(handle.getnframes() / float(rate), 3)
    except Exception:
        return None


def run(
    *,
    model: str,
    task: str = "audio-asr",
    provider: str = "nvidia-nemo",
    runtime: str = "nemo",
    project: Optional[str] = None,
    service: Optional[str] = None,
    **fields: Any,
):
    """Context manager for one model invocation.

    Returns a no-op stand-in when the recorder is unavailable, so call sites
    read the same either way.
    """
    if not _load():
        return _NullRun()
    try:
        return _adk.ModelRun(
            provider=provider,
            runtime=runtime,
            model=model,
            task=task,
            project=project or os.environ.get("VW_PROJECT") or "vault-explorer",
            service=service,
            # Local GPU work: a real zero, not an unmeasured cost.
            cost_usd=0.0,
            priced_exactly=True,
            is_free=True,
            **fields,
        )
    except Exception:
        return _NullRun()


def flush(timeout: float = 10.0) -> None:
    """Ship queued runs. These scripts are short-lived, so a run recorded and
    never flushed would be lost when the process exits."""
    if not _load():
        return
    try:
        _adk.shutdown(timeout=timeout)
    except Exception:
        pass


class _NullRun:
    """Stand-in with the same surface as ModelRun, doing nothing."""

    record = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def __getattr__(self, _name):
        def _noop(*_args, **_kwargs):
            return self

        return _noop
