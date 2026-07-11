import sys
# Configure UTF-8 streams for secure emoji and accent output under Windows terminal environments
try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass
# Prevent COM thread mode conflicts (RPC_E_CHANGED_MODE) in comtypes / pycaw
sys.coinit_flags = 2

# ── httpx compatibility patch ───────────────────────────────────────────────
# Newer httpx (>=0.24) removed top-level aliases that NeMo/HuggingFace Hub rely
# on.  Inject the missing attributes before any downstream import touches httpx.
try:
    import httpx
    if not hasattr(httpx, 'RequestError'):
        httpx.RequestError = httpx.HTTPStatusError
    if not hasattr(httpx, 'ConnectError'):
        from httpx._exceptions import ConnectError
        httpx.ConnectError = ConnectError
    if not hasattr(httpx, 'TimeoutException'):
        from httpx._exceptions import TimeoutException
        httpx.TimeoutException = TimeoutException
except Exception:
    pass
# ────────────────────────────────────────────────────────────────────────────

from pycaw.pycaw import AudioUtilities

import os
# Force python-based protocol buffers to bypass any library version mismatch
os.environ["PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION"] = "python"
os.environ["NEMO_LOG_LEVEL"] = "40"
import warnings
warnings.filterwarnings("ignore")
import logging
logging.getLogger("nemo").setLevel(logging.ERROR)
logging.getLogger("pytorch_lightning").setLevel(logging.ERROR)

import time
import tempfile
import wave
import threading
import queue
import argparse
import numpy as np
import soundcard as sc
import sounddevice as sd
from huggingface_hub import hf_hub_download
from kokoro_onnx import Kokoro
from deep_translator import GoogleTranslator

# Ensure vault-explorer project root is in sys.path
script_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.abspath(os.path.join(script_dir, ".."))
sys.path.insert(0, project_root)

try:
    from vault_explorer.parakeet_wrapper import ParakeetV3Wrapper
except Exception as err:
    print(f"Error importing Parakeet: {err}")
    sys.exit(1)

# Asynchronous, thread-safe, non-blocking Benchmark Logger
class BenchmarkLogger:
    def __init__(self, filename="spoken_translator_benchmark.log"):
        self.log_file = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", filename))
        self.queue = queue.Queue()
        self.thread = threading.Thread(target=self._writer_worker, daemon=True)
        self.thread.start()

    def log(self, step, duration_ms, details=""):
        timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
        log_msg = f"[{timestamp}] [STEP: {step}] {duration_ms:.2f}ms | {details}"
        print(f"⏱️ {log_msg}", flush=True)
        self.queue.put(log_msg)

    def _writer_worker(self):
        while True:
            msg = self.queue.get()
            if msg is None:
                break
            try:
                os.makedirs(os.path.dirname(self.log_file), exist_ok=True)
                with open(self.log_file, "a", encoding="utf-8") as f:
                    f.write(msg + "\n")
            except Exception:
                pass
            self.queue.task_done()

# Pycaw Audio Ducking Manager
class AudioDuckingManager:
    def __init__(self, target_volume=0.15):
        self.target_volume = target_volume
        self.original_volumes = {}
        self.my_pid = os.getpid()

    def duck(self):
        self.original_volumes.clear()
        sessions = AudioUtilities.GetAllSessions()
        for s in sessions:
            if s.Process and s.Process.pid != self.my_pid:
                try:
                    name = s.Process.name().lower()
                    # Duck active browser sessions, music players, and Electron apps
                    if any(b in name for b in ["chrome", "edge", "firefox", "brave", "opera", "safari", "applemusic", "vlc", "mpc", "electron", "vault-explorer", "vault_explorer"]):
                        vol = s.SimpleAudioVolume
                        orig = vol.GetMasterVolume()
                        self.original_volumes[s.Process.pid] = orig
                        print(f"[Ducking] Lowering volume of {s.Process.name()} from {orig:.2f} to {self.target_volume:.2f}", flush=True)
                        vol.SetMasterVolume(self.target_volume, None)
                except Exception:
                    pass

    def restore(self):
        sessions = AudioUtilities.GetAllSessions()
        for s in sessions:
            if s.Process and s.Process.pid in self.original_volumes:
                try:
                    vol = s.SimpleAudioVolume
                    orig = self.original_volumes[s.Process.pid]
                    print(f"[Ducking] Restoring volume of {s.Process.name()} back to {orig:.2f}", flush=True)
                    vol.SetMasterVolume(orig, None)
                except Exception:
                    pass
        self.original_volumes.clear()

def save_wav(pcm_data, filepath, sample_rate=16000):
    # Convert float32 back to 16-bit PCM for writing
    pcm_16 = (pcm_data * 32767.0).astype(np.int16)
    with wave.open(filepath, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_16.tobytes())

def main():
    parser = argparse.ArgumentParser(description="Vault Explorer Loopback Livestream Spoken Translator")
    parser.add_argument("--voice", type=str, default="ff_siwis", help="Kokoro voice name")
    parser.add_argument("--lang", type=str, default="fr-fr", help="Language code")
    parser.add_argument("--threshold", type=float, default=0.005, help="ASR trigger threshold")
    parser.add_argument("--volume", type=float, default=0.80, help="TTS playback mixing volume")
    args = parser.parse_args()

    print("=========================================================", flush=True)
    print("    VAULT EXPLORER REAL-TIME LIVESTREAM TRANSLATOR       ", flush=True)
    print("=========================================================", flush=True)
    print(f"[Config] Voice: {args.voice} | Lang: {args.lang} | Volume: {args.volume} | Threshold: {args.threshold}", flush=True)
    
    # Initialize benchmark logger
    logger = BenchmarkLogger("spoken_translator_benchmark.log")
    logger.log("Start-Boot", 0, "Initiating spoken translator pipeline")

    # 1. Warm-load ASR
    t0 = time.perf_counter()
    print("[Init] Loading NVIDIA NeMo Parakeet ASR model...", flush=True)
    try:
        asr_model = ParakeetV3Wrapper()
        logger.log("Load-ASR", (time.perf_counter() - t0) * 1000, "NeMo Parakeet ASR model loaded successfully")
    except Exception as asr_err:
        print(f"[Error] Failed to initialize Parakeet ASR: {asr_err}", flush=True)
        return

    # 2. Warm-load Kokoro ONNX TTS
    t0 = time.perf_counter()
    print("[Init] Loading Kokoro ONNX Text-to-Speech engine...", flush=True)
    try:
        try:
            model_path = hf_hub_download(repo_id="fastrtc/kokoro-onnx", filename="kokoro-v1.0.onnx", local_files_only=True)
            voices_path = hf_hub_download(repo_id="fastrtc/kokoro-onnx", filename="voices-v1.0.bin", local_files_only=True)
            loaded_from_cache = True
        except Exception:
            print("[Init] Local cached models not found. Downloading from Hugging Face...", flush=True)
            model_path = hf_hub_download(repo_id="fastrtc/kokoro-onnx", filename="kokoro-v1.0.onnx", local_files_only=False)
            voices_path = hf_hub_download(repo_id="fastrtc/kokoro-onnx", filename="voices-v1.0.bin", local_files_only=False)
            loaded_from_cache = False
            
        kokoro = Kokoro(model_path, voices_path)
        logger.log("Load-TTS", (time.perf_counter() - t0) * 1000, f"Kokoro ONNX initialized successfully (Cached: {loaded_from_cache})")
    except Exception as tts_err:
        print(f"[Error] Failed to initialize Kokoro TTS: {tts_err}", flush=True)
        return

    # 3. Setup loopback recorder
    t0 = time.perf_counter()
    try:
        loopback = sc.all_microphones(include_loopback=True)[0]
        print(f"[Init] Loopback interface bound to: {loopback.name}", flush=True)
        logger.log("Load-Loopback", (time.perf_counter() - t0) * 1000, f"WASAPI loopback recorder bound to {loopback.name}")
    except Exception as sc_err:
        print(f"[Error] Failed to acquire WASAPI loopback interface: {sc_err}", flush=True)
        return

    # Initialize Pycaw Volume Ducking
    ducking_mgr = AudioDuckingManager(target_volume=0.15)
    translator = GoogleTranslator(source='en', target='fr')

    sample_rate = 16000
    chunk_seconds = 0.25
    chunk_samples = int(sample_rate * chunk_seconds)
    
    # Threshold for silence detection (RMS volume)
    silence_threshold = args.threshold
    silence_chunks_limit = 3  # 0.75s of silence triggers end of speech segment

    print("\n[Status] System loopback monitoring active! Play audio in your browser.", flush=True)
    print("[Status] Press Ctrl+C at any time to terminate the translator safely.\n", flush=True)

    accumulated_audio = []
    is_recording = False
    silence_chunks_count = 0

    try:
        with loopback.recorder(samplerate=sample_rate) as recorder:
            while True:
                # Capture a chunk of 0.25s
                chunk = recorder.record(numframes=chunk_samples)
                
                # Convert stereo to mono
                if len(chunk.shape) > 1:
                    chunk_mono = np.mean(chunk, axis=1)
                else:
                    chunk_mono = chunk

                rms = np.sqrt(np.mean(chunk_mono**2))

                if rms > silence_threshold:
                    if not is_recording:
                        print("\n🎤 [Audio Detected] Recording sentence...", flush=True)
                        is_recording = True
                    accumulated_audio.append(chunk_mono)
                    silence_chunks_count = 0  # reset silence timer
                else:
                    if is_recording:
                        accumulated_audio.append(chunk_mono)
                        silence_chunks_count += 1
                        
                        # Trigger translation once silence limit is reached
                        if silence_chunks_count >= silence_chunks_limit:
                            print("\n🛑 [Sentence Completed] Processing translation...", flush=True)
                            sentence_audio = np.concatenate(accumulated_audio)
                            
                            # Clean state for next recording
                            accumulated_audio = []
                            is_recording = False
                            silence_chunks_count = 0

                            # Process translation synchronously (blocks recording to avoid feedback loops!)
                            try:
                                t_save = time.perf_counter()
                                # Save to temp wav
                                with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_wav:
                                    temp_path = temp_wav.name
                                save_wav(sentence_audio, temp_path, sample_rate)
                                logger.log("Save-WAV", (time.perf_counter() - t_save) * 1000, "Saved temp audio WAV chunk")
                                
                                # 1. Transcribe English audio
                                t_asr = time.perf_counter()
                                import contextlib
                                with open(os.devnull, 'w') as devnull:
                                    with contextlib.redirect_stderr(devnull), contextlib.redirect_stdout(devnull):
                                        segments = asr_model.transcribe_file(temp_path)
                                logger.log("ASR-Transcribe", (time.perf_counter() - t_asr) * 1000, f"Transcribed {len(segments) if segments else 0} segments")
                                
                                if os.path.exists(temp_path):
                                    os.remove(temp_path)

                                if not segments:
                                    print("\nℹ️ [ASR] No speech transcribed in segment.\n", flush=True)
                                    continue
                                
                                english_text = " ".join([s.text for s in segments]).strip()
                                print(f"\n🇺🇸 [English]: {english_text}", flush=True)

                                if not english_text:
                                    continue

                                # 2. Translate to French
                                t_trans = time.perf_counter()
                                french_text = translator.translate(english_text)
                                logger.log("Translation", (time.perf_counter() - t_trans) * 1000, "Translated text to French")
                                print(f"🇫🇷 [French] : {french_text}\n", flush=True)

                                # 3. Synthesize French speech
                                t_tts = time.perf_counter()
                                # Normalize language code for Kokoro to prevent backend exceptions (e.g., fr-ca -> fr-fr)
                                kokoro_lang = args.lang.lower()
                                if kokoro_lang.startswith("fr"):
                                    kokoro_lang = "fr-fr"
                                elif kokoro_lang.startswith("en"):
                                    kokoro_lang = "en-us"
                                elif kokoro_lang.startswith("es"):
                                    kokoro_lang = "es-es"
                                elif kokoro_lang.startswith("it"):
                                    kokoro_lang = "it-it"
                                elif kokoro_lang.startswith("pt"):
                                    kokoro_lang = "pt-br"
                                elif kokoro_lang.startswith("de"):
                                    kokoro_lang = "de-de"
                                elif kokoro_lang.startswith("ja"):
                                    kokoro_lang = "ja-jp"
                                elif kokoro_lang.startswith("zh"):
                                    kokoro_lang = "zh-cn"
                                else:
                                    kokoro_lang = "en-us"

                                print(f"🗣️ [Speaking (Kokoro)]: {french_text}", flush=True)
                                samples, sr = kokoro.create(french_text, voice=args.voice, speed=1.0, lang=kokoro_lang)
                                logger.log("TTS-Synthesis", (time.perf_counter() - t_tts) * 1000, "French speech voice synthesized")

                                # Apply mixing volume multiplier
                                adjusted_samples = samples * args.volume
                                
                                # Calculate visualizer bars (20 bands)
                                chunk_size = len(adjusted_samples) // 20
                                if chunk_size > 0:
                                    levels = []
                                    for i in range(20):
                                        chunk_data = adjusted_samples[i*chunk_size:(i+1)*chunk_size]
                                        peak = float(np.max(np.abs(chunk_data))) if len(chunk_data) > 0 else 0.0
                                        levels.append(peak)
                                    levels_str = ",".join(f"{v:.4f}" for v in levels)
                                    print(f"[VISUALIZER]:{levels_str}", flush=True)

                                # 4. Duck Browser volume & Play Speech
                                ducking_mgr.duck()
                                try:
                                    sd.play(adjusted_samples, sr)
                                    sd.wait()  # Block until translation speaking completes
                                finally:
                                    ducking_mgr.restore()
                                    # Clear soundcard record buffer to flush any playback echoes
                                    recorder.flush()

                            except Exception as proc_err:
                                print(f"[Error] Failed processing step: {proc_err}", flush=True)

    except KeyboardInterrupt:
        print("\n[Exit] Gracefully terminating Spoken Translation Pipeline...", flush=True)
    finally:
        # Guarantee audio restoration on shutdown
        ducking_mgr.restore()
        print("[Exit] Done.", flush=True)

if __name__ == '__main__':
    main()
