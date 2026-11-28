"""
nemotron_wrapper.py — cache-aware STREAMING ASR around
``nvidia/nemotron-3.5-asr-streaming-0.6b`` (FastConformer-CacheAware-RNNT, 0.6B).

Replaces the Parakeet-TDT wrapper for live subtitles. The two models differ in a
way that drives this whole design:

* Parakeet-TDT emitted **word-level timestamps**, so the old pipeline could
  re-transcribe a growing buffer and segment on word gaps.
* Nemotron emits **no timestamps**, but is a true cache-aware streaming model:
  audio is fed as fixed chunks, encoder/decoder state is carried in a cache, and
  each step returns the transcription so far.

So cue timing is derived from the **stream position** — we know exactly how many
samples have been fed (chunks x chunk duration), which is more reliable than the
old word timestamps and removes the "ASR races ahead of the playhead" behaviour
of the re-transcribe-a-growing-buffer approach.

Latency presets map to the encoder's right-context in 80 ms frames:

    0.08s -> 0    0.16s -> 1    0.32s -> 3    0.56s -> 6    1.12s -> 13

1.12s is the default here: the largest context = the most accurate transcription,
which is what we want for subtitles (we are not a voice agent, so ~1s of latency
is irrelevant — cues are placed by absolute timestamp anyway).
"""

import os
import logging

# Pre-import datasets to resolve the Windows MKL/OpenMP PyTorch/PyArrow import
# conflict that causes a silent exit code 1.
try:
    import datasets  # noqa: F401
except Exception:
    pass

import shutil

# NeMo leaves temp manifest locks on Windows; ignore PermissionError on cleanup.
_original_rmtree = shutil.rmtree


def _patched_rmtree(path, *args, **kwargs):
    try:
        return _original_rmtree(path, *args, **kwargs)
    except PermissionError:
        if "temp" in str(path).lower() or "tmp" in str(path).lower():
            pass
        else:
            raise


shutil.rmtree = _patched_rmtree

import warnings

warnings.filterwarnings("ignore")

os.environ.setdefault("NEMO_LOGGING_LEVEL", "ERROR")
os.environ.setdefault("TORCHAUDIO_DEBUG", "0")
os.environ.setdefault("PYTHONWARNINGS", "ignore")
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
os.environ.setdefault("OMP_NUM_THREADS", "1")

logging.basicConfig(level=logging.WARNING)
for _n in ("nemo_logging", "torchaudio", "torio", "pytorch_lightning"):
    logging.getLogger(_n).setLevel(logging.ERROR)

try:
    from nemo.utils import logging as _nemo_logging

    _nemo_logging.setLevel(_nemo_logging.ERROR)
except Exception:
    pass

try:
    import torch as _torch

    _torch.set_warn_always(False)
except Exception:
    pass

try:
    import lhotse

    lhotse.set_current_audio_backend("LibsndfileBackend")
    import lhotse.utils

    lhotse.utils.fix_random_seed = lambda seed: None
except Exception:
    pass

# Patch numpy.__version__ for numba before numba is imported
import sys
import types
try:
    import numpy as _np
    _np.__version__ = "2.4.0"
except Exception:
    pass

# Patch sys.modules for missing/renamed NeMo prompt model modules and classes to prevent ModuleNotFoundError / AttributeError
try:
    import nemo.collections.asr.models as _nemo_models
    import nemo.collections.asr.models.hybrid_rnnt_ctc_bpe_models_prompt as _hybrid_prompt

    _prompt_mod = types.ModuleType("nemo.collections.asr.models.rnnt_bpe_models_prompt")
    for _attr in dir(_hybrid_prompt):
        setattr(_prompt_mod, _attr, getattr(_hybrid_prompt, _attr))
    for _attr in dir(_nemo_models):
        if not hasattr(_prompt_mod, _attr):
            setattr(_prompt_mod, _attr, getattr(_nemo_models, _attr))

    if hasattr(_nemo_models, "EncDecHybridRNNTCTCBPEModelWithPrompt"):
        setattr(_prompt_mod, "EncDecRNNTBPEModelWithPrompt", _nemo_models.EncDecHybridRNNTCTCBPEModelWithPrompt)
    elif hasattr(_hybrid_prompt, "EncDecHybridRNNTCTCBPEModelWithPrompt"):
        setattr(_prompt_mod, "EncDecRNNTBPEModelWithPrompt", _hybrid_prompt.EncDecHybridRNNTCTCBPEModelWithPrompt)

    sys.modules["nemo.collections.asr.models.rnnt_bpe_models_prompt"] = _prompt_mod
    sys.modules["nemo.collections.asr.models.ctc_bpe_models_prompt"] = _prompt_mod

    # Intercept class resolution during model config instantiation
    import nemo.utils.model_utils as _model_utils
    _orig_import_class = _model_utils.import_class_by_path

    def _patched_import_class_by_path(path: str):
        try:
            return _orig_import_class(path)
        except Exception:
            if "rnnt_bpe_models_prompt" in path or "EncDecRNNTBPEModelWithPrompt" in path:
                target_cls = getattr(_nemo_models, "EncDecHybridRNNTCTCBPEModelWithPrompt", None) or getattr(_hybrid_prompt, "EncDecHybridRNNTCTCBPEModelWithPrompt", None) or getattr(_nemo_models, "EncDecRNNTBPEModel", None)
                if target_cls:
                    return target_cls
            raise

    _model_utils.import_class_by_path = _patched_import_class_by_path
    _model_utils.import_class_by_path.cache_clear = lambda: None

    # Patch state dict loading to automatically retry non-strictly if optional CTC decoder weights are missing
    from nemo.core.connectors.save_restore_connector import SaveRestoreConnector
    _orig_load_instance = SaveRestoreConnector.load_instance_with_state_dict

    def _patched_load_instance(self, instance, state_dict, strict):
        try:
            return _orig_load_instance(self, instance, state_dict, strict=strict)
        except Exception as e:
            if "ctc_decoder" in str(e) or "Missing key" in str(e):
                return _orig_load_instance(self, instance, state_dict, strict=False)
            raise

    SaveRestoreConnector.load_instance_with_state_dict = _patched_load_instance
except Exception:
    pass


SAMPLE_RATE = 16000

# chunk length (seconds) -> encoder right-context in 80 ms frames
LATENCY_PRESETS = {
    0.08: 0,
    0.16: 1,
    0.32: 3,
    0.56: 6,
    1.12: 13,
}
DEFAULT_CHUNK_S = 1.12


class NemotronStreamingASR:
    """
    Cache-aware streaming recogniser.

    Usage::

        asr = NemotronStreamingASR(chunk_s=1.12)
        asr.reset()
        for chunk in audio_chunks:               # chunk_samples() floats each
            text_so_far = asr.feed(chunk)        # accumulated text for this utterance
        asr.reset()                              # at an utterance boundary

    ``feed`` returns the full accumulated transcription **since the last reset**,
    so callers track deltas themselves. Reset at natural pauses to bound the
    hypothesis length and start a new cue.
    """

    DEFAULT_MODEL = "nvidia/nemotron-3.5-asr-streaming-0.6b"

    def __init__(self, model_name: str = None, chunk_s: float = DEFAULT_CHUNK_S,
                 status_callback=None, left_context: int = 70):
        import time

        t0 = time.perf_counter()
        import torch
        import nemo.collections.asr as nemo_asr

        self.logger = logging.getLogger("vault_streaming.nemotron")
        self.chunk_s = chunk_s if chunk_s in LATENCY_PRESETS else DEFAULT_CHUNK_S
        if chunk_s not in LATENCY_PRESETS:
            self.logger.warning("chunk_s=%s unsupported; falling back to %.2fs", chunk_s, self.chunk_s)

        model_name = model_name or os.environ.get("VAULT_ASR_MODEL") or self.DEFAULT_MODEL

        if status_callback:
            status_callback("Loading Nemotron streaming ASR model...")

        # Prefer a local .nemo (downloaded by the app into VAULT_MODEL_DIR, or an
        # HF-cached snapshot) so we never hit the network on a warm start.
        local = self._find_local_model()
        if local:
            self.logger.info("Loading local model: %s", local)
            self.model = self._restore_local(local)
        else:
            self.logger.info("Loading model from HF cache / downloading: %s", model_name)
            self.model = self._from_pretrained(model_name)

        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model = self.model.to(self.device)
        self.model.eval()

        # --- Cache-aware streaming configuration -------------------------------
        right = LATENCY_PRESETS[self.chunk_s]
        try:
            self.model.encoder.set_default_att_context_size([left_context, right])
        except Exception as e:
            self.logger.warning("set_default_att_context_size failed (%s); using model default", e)
        self.model.encoder.setup_streaming_params()

        # RNNT streaming decoding must be greedy (batched greedy keeps state).
        try:
            self.model.change_decoding_strategy(decoding_cfg=None)
        except Exception:
            pass

        self._drop_extra = int(getattr(self.model.encoder.streaming_cfg, "drop_extra_pre_encoded", 0) or 0)

        # Setup prompt ID for prompt-conditioned models (e.g. Nemotron 3.5)
        prompt_dict = getattr(self.model.cfg.model_defaults, "prompt_dictionary", None) or {}
        self.num_prompts = int(getattr(self.model.cfg.model_defaults, "num_prompts", 128) or 128)
        lang_key = "en-US" if "en-US" in prompt_dict else ("en" if "en" in prompt_dict else (list(prompt_dict.keys())[0] if prompt_dict else None))
        self.prompt_id = prompt_dict[lang_key] if (lang_key and lang_key in prompt_dict) else 0

        self.reset()

        print(f"[ASR Telemetry] Nemotron streaming init: {time.perf_counter() - t0:.2f}s "
              f"(chunk={self.chunk_s}s, right_context={right}, device={self.device})")

    # ------------------------------------------------------------------
    # Model loading
    #
    # ``ASRModel`` is an ABSTRACT base class — calling ``restore_from`` on it
    # raises "Can't instantiate abstract class ASRModel without an implementation
    # for abstract methods 'setup_training_data', 'setup_validation_data'". The
    # concrete class must be used, so we read the ``target`` field out of the
    # .nemo archive's model_config.yaml and import that, with concrete fallbacks.
    # ------------------------------------------------------------------
    @staticmethod
    def _resolve_target_class(nemo_path):
        """Import the concrete model class named by the archive's `target:` field."""
        import tarfile
        import importlib
        import re

        try:
            with tarfile.open(nemo_path, "r:*") as tf:
                member = next((m for m in tf.getmembers()
                               if m.name.endswith("model_config.yaml")), None)
                if member is None:
                    return None
                text = tf.extractfile(member).read().decode("utf-8", "ignore")
        except Exception:
            return None

        m = re.search(r"^target:\s*(\S+)", text, re.M)
        if not m:
            return None
        dotted = m.group(1).strip().strip("\"'")
        mod_name, _, cls_name = dotted.rpartition(".")
        for try_mod in (
            mod_name,
            mod_name.replace("_prompt", ""),
            "nemo.collections.asr.models.hybrid_rnnt_ctc_bpe_models_prompt",
            "nemo.collections.asr.models.rnnt_bpe_models",
        ):
            try:
                mod = importlib.import_module(try_mod)
                cls = getattr(mod, cls_name, None)
                if cls is not None:
                    return cls
            except Exception:
                continue
        return None

    @staticmethod
    def _concrete_candidates():
        """Concrete ASR classes that can hold a cache-aware streaming RNNT."""
        import nemo.collections.asr as nemo_asr

        out = []
        for name in ("EncDecRNNTBPEModel", "EncDecHybridRNNTCTCBPEModel",
                     "EncDecCTCModelBPE", "EncDecMultiTaskModel"):
            cls = getattr(nemo_asr.models, name, None)
            if cls is not None:
                out.append(cls)
        return out

    def _restore_local(self, nemo_path):
        errors = []
        candidates = []
        target = self._resolve_target_class(nemo_path)
        if target is not None:
            candidates.append(target)
        candidates += [c for c in self._concrete_candidates() if c is not target]

        for cls in candidates:
            try:
                self.logger.info("restore_from via %s (strict=False)", cls.__name__)
                return cls.restore_from(nemo_path, strict=False)
            except TypeError:
                try:
                    return cls.restore_from(nemo_path)
                except Exception as e:
                    errors.append(f"{cls.__name__}: {e}")
            except Exception as e:
                errors.append(f"{cls.__name__}: {e}")
        raise RuntimeError("could not restore model; tried -> " + " | ".join(errors))

    def _from_pretrained(self, model_name):
        import nemo.collections.asr as nemo_asr

        errors = []
        # ASRModel.from_pretrained normally dispatches to the concrete class, so
        # try it first; fall back to explicit concrete classes if it doesn't.
        try:
            return nemo_asr.models.ASRModel.from_pretrained(model_name, strict=False)
        except Exception:
            try:
                return nemo_asr.models.ASRModel.from_pretrained(model_name)
            except Exception as e:
                errors.append(f"ASRModel.from_pretrained: {e}")

        for cls in self._concrete_candidates():
            try:
                self.logger.info("from_pretrained via %s (strict=False)", cls.__name__)
                return cls.from_pretrained(model_name, strict=False)
            except Exception:
                try:
                    return cls.from_pretrained(model_name)
                except Exception as e:
                    errors.append(f"{cls.__name__}: {e}")
        raise RuntimeError("could not load model; tried -> " + " | ".join(errors))

    @staticmethod
    def _find_local_model():
        """Locate a local .nemo for the streaming model, if one was downloaded."""
        import glob

        candidates = []
        model_dir = os.environ.get("VAULT_MODEL_DIR")
        if model_dir:
            candidates += glob.glob(os.path.join(model_dir, "*nemotron*asr*streaming*.nemo"))
        candidates += glob.glob(os.path.expanduser(
            "~/.cache/huggingface/hub/models--nvidia--nemotron-3.5-asr-streaming-0.6b/snapshots/*/*.nemo"))
        return next((c for c in candidates if c and os.path.exists(c)), None)

    # ------------------------------------------------------------------
    def chunk_samples(self) -> int:
        """Exact number of 16 kHz mono samples the caller should feed per step."""
        return int(round(self.chunk_s * SAMPLE_RATE))

    def reset(self):
        """Drop cache + hypotheses and begin a fresh utterance."""
        (self.cache_last_channel,
         self.cache_last_time,
         self.cache_last_channel_len) = self.model.encoder.get_initial_cache_state(batch_size=1)
        self.previous_hypotheses = None
        self.pred_out_stream = None
        self._step = 0
        self._text = ""

    @property
    def text(self) -> str:
        return self._text

    def feed(self, audio_f32) -> str:
        """
        Feed one chunk of mono float32 audio (values in [-1, 1]) and return the
        accumulated transcription since the last :meth:`reset`.
        """
        import numpy as np
        import torch

        if audio_f32 is None or len(audio_f32) == 0:
            return self._text

        arr = np.ascontiguousarray(np.asarray(audio_f32, dtype=np.float32))
        sig = torch.from_numpy(arr).to(self.device).unsqueeze(0)
        sig_len = torch.tensor([sig.shape[1]], dtype=torch.int64, device=self.device)

        try:
            with torch.inference_mode():
                processed, processed_len = self.model.preprocessor(input_signal=sig, length=sig_len)

                # The pre-encode cache already covers the model's look-back after
                # the first step, so later chunks must drop the duplicated frames.
                drop = 0 if self._step == 0 else self._drop_extra

                if getattr(self.model, "concat", False) and hasattr(self.model, "prompt_kernel"):
                    (encoded,
                     encoded_len,
                     self.cache_last_channel,
                     self.cache_last_time,
                     self.cache_last_channel_len) = self.model.encoder.cache_aware_stream_step(
                        processed_signal=processed,
                        processed_signal_length=processed_len,
                        cache_last_channel=self.cache_last_channel,
                        cache_last_time=self.cache_last_time,
                        cache_last_channel_len=self.cache_last_channel_len,
                        keep_all_outputs=False,
                        drop_extra_pre_encoded=drop,
                    )

                    encoded_t = torch.transpose(encoded, 1, 2)
                    prompt_tensor = torch.zeros(encoded_t.shape[0], encoded_t.shape[1], self.num_prompts, dtype=encoded_t.dtype, device=self.device)
                    prompt_tensor[:, :, self.prompt_id] = 1.0
                    concat_enc = torch.cat([encoded_t, prompt_tensor], dim=-1)
                    encoded_t = self.model.prompt_kernel(concat_enc).to(encoded_t.dtype)
                    encoded = torch.transpose(encoded_t, 1, 2)

                    best_hyp = self.model.decoding.rnnt_decoder_predictions_tensor(
                        encoder_output=encoded,
                        encoded_lengths=encoded_len,
                        return_hypotheses=True,
                        partial_hypotheses=self.previous_hypotheses,
                    )
                    self.previous_hypotheses = best_hyp
                    transcribed = best_hyp
                else:
                    (self.pred_out_stream,
                     transcribed,
                     self.cache_last_channel,
                     self.cache_last_time,
                     self.cache_last_channel_len,
                     self.previous_hypotheses) = self.model.conformer_stream_step(
                        processed_signal=processed,
                        processed_signal_length=processed_len,
                        cache_last_channel=self.cache_last_channel,
                        cache_last_time=self.cache_last_time,
                        cache_last_channel_len=self.cache_last_channel_len,
                        keep_all_outputs=False,
                        previous_hypotheses=self.previous_hypotheses,
                        previous_pred_out=self.pred_out_stream,
                        drop_extra_pre_encoded=drop,
                        return_transcription=True,
                    )
        except Exception as e:
            self.logger.error("streaming step failed: %s", e)
            raise

        self._step += 1
        self._text = self._extract_text(transcribed) or self._text
        return self._text

    # ------------------------------------------------------------------
    @staticmethod
    def _extract_text(transcribed) -> str:
        """NeMo returns a batch list of str or Hypothesis objects."""
        import re

        if not transcribed:
            return ""
        item = transcribed[0] if isinstance(transcribed, (list, tuple)) else transcribed
        if item is None:
            return ""
        if hasattr(item, "text"):
            item = item.text
        raw = (item or "").strip() if isinstance(item, str) else ""
        if not raw:
            return ""
        # Strip language prompt tags like <en-US>, <es-ES>, etc.
        cleaned = re.sub(r"<[^>]+>", "", raw).strip()
        return cleaned
