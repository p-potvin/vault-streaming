"""
realtime_eou.py — lightweight wrapper around ``nvidia/parakeet_realtime_eou_120m-v1``.

This is the *streaming* transcription model: 120M params (vs. 600M for
parakeet-tdt-v3), English-only, ~7-12x real-time, and — crucially — it emits an
``<EOU>`` (end-of-utterance) token when a spoken phrase completes. That single
signal replaces everything the offline path needed timestamps + silence-gap
grouping (or Silero VAD) for: we segment subtitles on ``<EOU>`` and take the
timing from our own audio-stream position, so no per-word timestamps are
requested (faster) and no VAD model is loaded.

Trade-offs vs. the TDT wrapper: English only, and output has no punctuation or
capitalisation.
"""

import os
import glob
import logging

# Import the sibling wrapper purely for its NeMo/PyTorch/Lhotse log-silencing and
# Windows import-order side effects (env vars, rmtree patch, backend selection).
try:
    from vault_explorer import parakeet_wrapper as _pw  # noqa: F401
except Exception:
    pass

EOU_TOKEN = "<EOU>"


class RealtimeEOUTranscriber:
    """Loads the realtime EOU model and transcribes raw 16 kHz mono float32 audio."""

    DEFAULT_MODEL = "nvidia/parakeet_realtime_eou_120m-v1"

    def __init__(self, model_name: str = DEFAULT_MODEL, status_callback=None):
        import time
        import torch
        import nemo.collections.asr as nemo_asr

        self.logger = logging.getLogger("vault_explorer.realtime_eou")
        t0 = time.perf_counter()

        # Prefer a locally-bundled .nemo (fully offline, robust on Windows) over
        # any HF resolution. The bundled copy lives in the repo's tools/models/.
        resolved = model_name
        if not (model_name.endswith(".nemo") and os.path.exists(model_name)):
            repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
            candidates = [
                os.path.join(repo_root, "tools", "models", "parakeet_realtime_eou_120m-v1.nemo"),
            ]
            candidates += glob.glob(os.path.expanduser(
                "~/.cache/huggingface/hub/models--nvidia--parakeet_realtime_eou_120m-v1/snapshots/*/*.nemo"
            ))
            found = next((c for c in candidates if c and os.path.exists(c)), None)
            if found:
                resolved = found
                self.logger.info(f"Found local EOU model: {resolved}")

        if status_callback:
            status_callback("Loading realtime EOU model...")

        if resolved.endswith(".nemo") and os.path.exists(resolved):
            self.logger.info(f"Restoring EOU model from local .nemo: {resolved}")
            self.model = nemo_asr.models.ASRModel.restore_from(resolved)
        else:
            # No local .nemo — fall back to a one-time HF download (~0.5 GB).
            self.logger.info("Local .nemo not found; downloading from Hugging Face...")
            self.model = nemo_asr.models.ASRModel.from_pretrained(model_name)

        if torch.cuda.is_available():
            self.model = self.model.cuda()
        self.model.eval()
        self.logger.info(f"Realtime EOU model loaded in {time.perf_counter() - t0:.1f}s")

    def transcribe(self, audio_f32) -> str:
        """
        Transcribe a 1-D mono 16 kHz float32 numpy array. Returns the raw decoded
        text, which may contain a trailing (or embedded) ``<EOU>`` token, or ''
        when no speech is decoded. No timestamps are requested.
        """
        import torch

        with torch.no_grad():
            try:
                out = self.model.transcribe(
                    [audio_f32], batch_size=1, num_workers=0, timestamps=False, verbose=False
                )
            except TypeError:
                # Older/newer signatures may reject some kwargs — fall back minimal.
                out = self.model.transcribe([audio_f32])

        if not out:
            return ""
        item = out[0]
        if isinstance(item, str):
            return item
        text = getattr(item, "text", None)
        return text or ""
