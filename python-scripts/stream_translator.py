import sys
import os
# Configure UTF-8 streams for secure emoji and accent output under Windows terminal environments
try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass
# Force python-based protocol buffers to bypass any library version mismatch
os.environ["PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION"] = "python"

# ── httpx compatibility patch ───────────────────────────────────────────────
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

import sys
import time
import tempfile
import wave
import subprocess
import threading
import queue
import argparse
import numpy as np
import sounddevice as sd
from huggingface_hub import hf_hub_download
from kokoro_onnx import Kokoro
from deep_translator import GoogleTranslator
from pycaw.pycaw import AudioUtilities

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

def save_wav(pcm_bytes, filepath, sample_rate=16000):
    with wave.open(filepath, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_bytes)

def play_audio_worker(playback_queue, volume_multiplier=1.0):
    ducking_mgr = AudioDuckingManager(target_volume=0.15)
    while True:
        item = playback_queue.get()
        if item is None:
            break
        samples, sr = item
        # Apply mixing volume multiplier
        adjusted_samples = samples * volume_multiplier
        
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

        ducking_mgr.duck()
        try:
            sd.play(adjusted_samples, sr)
            sd.wait()
        except Exception as play_err:
            print(f"[Playback Error] {play_err}", flush=True)
        finally:
            ducking_mgr.restore()
        playback_queue.task_done()

import re
import urllib.request
import urllib.parse
import html

def resolve_direct_stream_url(url):
    parsed = urllib.parse.urlparse(url)
    path_lower = parsed.path.lower()
    if path_lower.endswith(('.mp4', '.m3u8', '.webm', '.ogg', '.mov', '.ts')):
        return url

    scheme = parsed.scheme if parsed.scheme else 'https'
    print(f"[Init] URL does not appear to be a direct media stream. Attempting to resolve webpage: {url}", flush=True)
    try:
        req = urllib.request.Request(
            url,
            headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
            }
        )
        with urllib.request.urlopen(req, timeout=10) as response:
            html_content = response.read().decode('utf-8', errors='ignore')
        
        clean_html = html.unescape(html_content).replace('\\/', '/')
        candidates = []
        
        src_matches = re.findall(r'<source\s+[^>]*src=["\']([^"\']+)["\']', clean_html, re.IGNORECASE)
        video_matches = re.findall(r'<video\s+[^>]*src=["\']([^"\']+)["\']', clean_html, re.IGNORECASE)
        all_srcs = src_matches + video_matches
 
        general_matches = re.findall(r'(?:https?:)?//[^\s"\'`<>]+?\.(?:mp4|m3u8|mkv|webm|mov)(?:\?[^\s"\'`<>]*)?', clean_html, re.IGNORECASE)
        all_srcs.extend(general_matches)

        for f_url in all_srcs:
            f_url = f_url.split('\\')[0].split('"')[0].split("'")[0].split('`')[0].strip()
            if f_url.startswith('//'):
                f_url = f"{scheme}:{f_url}"
            if f_url.startswith(('http://', 'https://')):
                if f_url not in candidates:
                    candidates.append(f_url)

        var_patterns = [
            r'(?:video_url|videoUrl|hls_url|hlsUrl|file|source_url|video_src|video_file|hls_file)\s*[:=]\s*["\']([^"\'\\]+)["\']',
            r'"(?:video_url|videoUrl|hls_url|hlsUrl|file|source_url|video_src|video_file|hls_file)"\s*:\s*"([^"]+)"'
        ]
        for pat in var_patterns:
            for match in re.finditer(pat, clean_html, re.IGNORECASE):
                u = match.group(1).replace('\\', '').strip()
                if u.startswith('//'):
                    u = f"{scheme}:{u}"
                if u.startswith(('http://', 'https://')):
                    if u not in candidates:
                        candidates.append(u)
                    
        candidates.sort(key=lambda x: (
            10 if '.m3u8' in x.lower() else
            9 if '1080' in x.lower() else
            8 if '720' in x.lower() else
            5 if '.mp4' in x.lower() else 1
        ), reverse=True)

        if candidates:
            resolved = candidates[0]
            print(f"[Init] Successfully resolved direct stream URL: {resolved}", flush=True)
            return resolved
        else:
            print("[Init] Webpage resolved but no video streams found in HTML source.", flush=True)
            
    except Exception as e:
        print(f"[Warning] Webpage resolution failed: {e}. Attempting direct passage to FFmpeg.", flush=True)
        
    return url

def main():
    parser = argparse.ArgumentParser(description="Vault Explorer HTTPS Stream Spoken Translator")
    parser.add_argument("stream_url", type=str, help="HTTPS Stream URL")
    parser.add_argument("--voice", type=str, default="ff_siwis", help="Kokoro voice name")
    parser.add_argument("--lang", type=str, default="fr-fr", help="Language code")
    parser.add_argument("--threshold", type=float, default=0.005, help="ASR trigger threshold")
    parser.add_argument("--volume", type=float, default=0.80, help="TTS mixing volume")
    args = parser.parse_args()

    print("\n=========================================================", flush=True)
    print("      VAULT EXPLORER HTTPS STREAM SPOKEN TRANSLATOR      ", flush=True)
    print("================================================*********\n", flush=True)
    print(f"[Config] Voice: {args.voice} | Lang: {args.lang} | Volume: {args.volume}\n", flush=True)

    # Initialize benchmark logger
    logger = BenchmarkLogger("spoken_translator_benchmark.log")
    logger.log("Start-Boot", 0, "Initiating spoken translator pipeline")

    # 1. Warm-load ASR
    t0 = time.perf_counter()
    print("[Init] Loading NVIDIA NeMo Parakeet ASR model...\n", flush=True)
    try:
        asr_model = ParakeetV3Wrapper()
        logger.log("Load-ASR", (time.perf_counter() - t0) * 1000, "NeMo Parakeet ASR model loaded successfully")
    except Exception as asr_err:
        print(f"\n[Error] Failed to initialize Parakeet ASR: {asr_err}\n", flush=True)
        return

    # 2. Warm-load Kokoro ONNX TTS
    t0 = time.perf_counter()
    print("[Init] Loading Kokoro ONNX Text-to-Speech engine...\n", flush=True)
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
        print(f"\n[Error] Failed to initialize Kokoro TTS: {tts_err}\n", flush=True)
        return

    # Setup translation fallback
    translator = GoogleTranslator(source='en', target='fr')

    # Spawning playback queue and thread
    playback_queue = queue.Queue()
    play_thread = threading.Thread(target=play_audio_worker, args=(playback_queue, args.volume), daemon=True)
    play_thread.start()

    # Resolve webpage URL to direct stream
    stream_url = resolve_direct_stream_url(args.stream_url)

    # Launching FFmpeg process to capture HTTPS live stream audio natively
    print(f"[Init] Launching FFmpeg capture for stream: {stream_url}\n", flush=True)
    sample_rate = 16000
    bytes_per_second = sample_rate * 2  # 16-bit = 2 bytes
    chunk_seconds = 2.5
    chunk_bytes_limit = int(bytes_per_second * chunk_seconds)

    ffmpeg_cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", stream_url,
        "-f", "s16le", "-ac", "1", "-ar", str(sample_rate), "pipe:1"
    ]

    try:
        process = subprocess.Popen(ffmpeg_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except Exception as ffmpeg_err:
        print(f"\n[Error] Failed to start FFmpeg process: {ffmpeg_err}\n", flush=True)
        return

    print("\n[Status] Capturing and translating stream in real-time...\n", flush=True)
    print("[Status] Press Ctrl+C at any time to terminate safely.\n", flush=True)

    consecutive_flushes = 0
    max_retries = 3
    retry_count = 0
    try:
        while True:
            # Read 2.5 seconds of raw PCM audio
            pcm_data = process.stdout.read(chunk_bytes_limit)
            if not pcm_data:
                retry_count += 1
                if retry_count <= max_retries:
                    print(f"\n[Warning] Stream connection lost. Reconnecting... (Attempt {retry_count} of {max_retries})\n", flush=True)
                    try:
                        process.terminate()
                        process.wait(timeout=2)
                    except Exception:
                        pass
                    time.sleep(3.0)
                    try:
                        process = subprocess.Popen(ffmpeg_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                        continue
                    except Exception as spawn_err:
                        print(f"[Error] Reconnection attempt failed to spawn FFmpeg: {spawn_err}\n", flush=True)
                
                print("\n[Info] Stream ended or connection lost.\n", flush=True)
                break
            
            # Reset retry count if we successfully read data
            retry_count = 0

            # Save chunk to temp WAV file for NeMo Parakeet processing
            t_save = time.perf_counter()
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_wav:
                temp_path = temp_wav.name
            
            try:
                save_wav(pcm_data, temp_path, sample_rate)
                logger.log("Save-WAV", (time.perf_counter() - t_save) * 1000, "Saved temp audio WAV chunk")

                # 1. Decode and translate natively (target_language='fr')
                t_asr = time.perf_counter()
                segments = asr_model.transcribe_file(temp_path, target_language="fr")
                logger.log("ASR-Transcribe", (time.perf_counter() - t_asr) * 1000, f"Transcribed {len(segments) if segments else 0} segments")
                
                if os.path.exists(temp_path):
                    os.remove(temp_path)

                if not segments:
                    continue

                transcribed_text = " ".join([s.text for s in segments]).strip()
                if not transcribed_text:
                    continue

                print(f"\n🇺🇸 [Transcribed]: {transcribed_text}", flush=True)

                # Determine if we should apply fallback translation (if model output is still English)
                t_trans = time.perf_counter()
                translated_text = transcribed_text
                try:
                    translated_text = translator.translate(transcribed_text)
                except Exception as t_err:
                    pass
                logger.log("Translation", (time.perf_counter() - t_trans) * 1000, "Translated text to French")

                print(f"🇫🇷 [French] : {translated_text}\n", flush=True)

                # Calculate pending queue playback duration to dynamically scale speech speed
                pending_duration = 0.0
                with playback_queue.mutex:
                    for q_item in playback_queue.queue:
                        if q_item is not None:
                            q_samples, q_sr = q_item
                            pending_duration += len(q_samples) / q_sr

                # Dynamic lag mitigation (catch-up algorithm)
                speed_factor = 1.0
                if pending_duration > 5.0:
                    # Excessive lag: drop backlog completely to jump directly to live head
                    consecutive_flushes += 1
                    print(f"[Lag Mitigation] Lag is too high ({pending_duration:.2f}s). Skipping translation backlog to catch up with live stream! (Consecutive: {consecutive_flushes})", flush=True)
                    if consecutive_flushes >= 3:
                        print(f"\n[Warning] Consecutive translation lag detected ({consecutive_flushes} times in a row)! The system hardware may be running slower than real-time. Suggest lowering voice quality or sensitivity settings.\n", flush=True)
                    with playback_queue.mutex:
                        num_items = len(playback_queue.queue)
                        playback_queue.queue.clear()
                    for _ in range(num_items):
                        playback_queue.task_done()
                    speed_factor = 1.0
                elif pending_duration > 3.5:
                    consecutive_flushes = 0
                    speed_factor = 1.35  # Speak much faster to catch up
                    print(f"[Lag Mitigation] High latency ({pending_duration:.2f}s). Speeding up translation speech rate to {speed_factor}x to catch up.", flush=True)
                elif pending_duration > 2.0:
                    consecutive_flushes = 0
                    speed_factor = 1.15  # Speak slightly faster
                    print(f"[Lag Mitigation] Moderate latency ({pending_duration:.2f}s). Speeding up translation speech rate to {speed_factor}x to catch up.", flush=True)
                else:
                    consecutive_flushes = 0

                # 2. Synthesize French speech
                t_tts = time.perf_counter()
                # Transcript output for UI embedded console
                print(f"🗣️ [Speaking (Kokoro)]: {translated_text}", flush=True)
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
                samples, sr = kokoro.create(translated_text, voice=args.voice, speed=speed_factor, lang=kokoro_lang)
                logger.log("TTS-Synthesis", (time.perf_counter() - t_tts) * 1000, "French speech voice synthesized")

                # 3. Queue playback
                playback_queue.put((samples, sr))

            except Exception as loop_err:
                print(f"\n[Error] Chunk processing failed: {loop_err}\n", flush=True)
                if os.path.exists(temp_path):
                    try: os.remove(temp_path)
                    except Exception: pass

    except KeyboardInterrupt:
        print("\n[Exit] Terminating livestream translation pipeline...\n", flush=True)
    finally:
        process.terminate()
        # Wait for any remaining audio segments in the queue to finish playing fully
        playback_queue.join()
        playback_queue.put(None)
        play_thread.join(timeout=3.0)
        print("\n[Exit] Done.\n", flush=True)

if __name__ == '__main__':
    main()
