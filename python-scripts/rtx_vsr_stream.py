#!/usr/bin/env python3
"""
rtx_vsr_stream.py — Real-time RTX Video Super Resolution pipeline for Vault Explorer.

Modes:
  stream:  Decode → VSR (2x) → NVENC → fragmented MP4 to stdout (for MediaSource)
  enhance: Decode → VSR (2x) → NVENC → file output (permanent enhancement)

Usage:
  python rtx_vsr_stream.py stream  <video_path> [--start-time SEC] [--quality LEVEL] [--scale FACTOR] [--bitrate RATE] [--chroma FMT]
  python rtx_vsr_stream.py enhance <video_path> <output_path> [--quality LEVEL] [--scale FACTOR] [--chroma FMT]
"""

import argparse
import io
import os
import queue
import re
import struct
import subprocess
import sys
import threading
import time

import torch
import torch.nn.functional as F

# nvvfx has nanobind leak warnings on exit; we suppress them by flushing
# stdout before exit and using os._exit(0) in non-error paths.
def check_nvvfx():
    try:
        import nvvfx
        return nvvfx
    except ImportError as e:
        print(f"[RTX VSR] FATAL: nvidia-vfx not installed: {e}", file=sys.stderr)
        sys.exit(2)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
PIPE_BUF_SIZE = 16 * 1024 * 1024  # 16 MB pipe buffer for high-throughput raw video
STREAM_CHUNK_SIZE = 65536         # 64 KB chunks for stdout fMP4 forwarding
FFMPEG_PIX_FMT = "rgb24"          # Raw RGB bytes from decoder
QUEUE_MAXSIZE = 4                 # Bounded queue depth to overlap decode/VSR/encode

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _probe_video(path: str):
    """Return dict with width, height, fps, duration via ffprobe."""
    cmd = [
        "ffprobe", "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate,duration",
        "-of", "json",
        path,
    ]
    try:
        out = subprocess.check_output(cmd, stderr=subprocess.DEVNULL, text=True)
        import json
        data = json.loads(out)
        stream = data.get("streams", [{}])[0]
        w = int(stream.get("width", 0))
        h = int(stream.get("height", 0))
        fps = 0.0
        rfr = stream.get("r_frame_rate", "")
        if "/" in rfr:
            a, b = rfr.split("/")
            fps = float(a) / float(b) if float(b) != 0 else 0.0
        dur = float(stream.get("duration", 0) or 0)
        return {"width": w, "height": h, "fps": fps, "duration": dur}
    except Exception as e:
        print(f"[RTX VSR] ffprobe failed: {e}", file=sys.stderr)
        return {"width": 0, "height": 0, "fps": 0.0, "duration": 0.0}


def _build_decoder_cmd(path: str, start_time: float = 0.0):
    """ffmpeg command that outputs raw RGB24 frames on stdout with multi-threading."""
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostats", "-threads", "0"]
    if start_time > 0:
        cmd += ["-ss", str(start_time)]
    cmd += [
        "-i", path,
        "-map", "0:v:0",           # Select only the video stream, ignoring audio/subtitles
        "-pix_fmt", FFMPEG_PIX_FMT,
        "-f", "rawvideo",
        "-",
    ]
    return cmd


def _build_encoder_stream_cmd(width: int, height: int, fps: float, bitrate: str = "12M", chroma: str = "yuv420p"):
    """ffmpeg command that reads raw yuv on stdin and outputs
    fragmented MP4 (fMP4) suitable for MediaSource sequence mode."""
    # Derive maxrate and bufsize from bitrate string
    m = re.match(r"(\d+)([MmKk]?)", bitrate)
    if m:
        val = int(m.group(1))
        suffix = m.group(2).upper() if m.group(2) else "M"
        if suffix == "K":
            bps = val * 1000
        else:
            bps = val * 1000000
    else:
        bps = 12000000
    maxrate = str(int(bps * 1.25))
    bufsize = str(int(bps * 2))
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostats",
        "-f", "rawvideo",
        "-pix_fmt", chroma,
        "-s", f"{width}x{height}",
        "-r", str(fps) if fps > 0 else "30",
        "-i", "-",                     # stdin
        "-c:v", "h264_nvenc",
        "-preset", "p1",               # lowest latency preset
        "-tune", "ll",                 # low-latency tuning
        "-rc", "cbr",
        "-b:v", bitrate,
        "-maxrate", maxrate,
        "-bufsize", bufsize,
        "-g", "30",                    # 1-second GOP at 30 fps
        "-movflags", "frag_keyframe+empty_moov+default_base_moof",
        "-f", "mp4",
        "-",
    ]
    return cmd


def _build_encoder_file_cmd(width: int, height: int, fps: float, out_path: str, chroma: str = "yuv420p"):
    """ffmpeg command for permanent file enhancement using NVENC."""
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostats",
        "-f", "rawvideo",
        "-pix_fmt", chroma,
        "-s", f"{width}x{height}",
        "-r", str(fps) if fps > 0 else "30",
        "-i", "-", 
        "-c:v", "h264_nvenc",
        "-preset", "p4",               # balanced quality/speed
        "-rc", "vbr",
        "-cq", "20",
        "-b:v", "15M",
        "-maxrate", "20M",
        "-bufsize", "40M",
        "-movflags", "+faststart",
        "-f", "mp4",
        "-y", out_path,
    ]
    return cmd


# ---------------------------------------------------------------------------
# GPU-Accelerated YUV Converter
# ---------------------------------------------------------------------------

class GpuYuvConverter:
    """Fast fused GPU BT.709 RGB->YUV converter with pinned memory DMA transfers."""

    def __init__(self, width: int, height: int, chroma: str = "yuv420p", pool_size: int = 4):
        self.w = width
        self.h = height
        self.chroma = chroma
        self.pool_size = pool_size
        self.pool_idx = 0

        self.y_size = self.w * self.h
        if self.chroma == "yuv420p":
            self.uv_w = self.w // 2
            self.uv_h = self.h // 2
            self.uv_size = self.uv_w * self.uv_h
            self.total_bytes = self.y_size + 2 * self.uv_size
        else:
            self.uv_w = self.w
            self.uv_h = self.h
            self.uv_size = self.y_size
            self.total_bytes = self.y_size * 3

        # BT.709 color conversion matrix (standard for HD video)
        # Y = 0.2126 * R + 0.7152 * G + 0.0722 * B
        # U = -0.1146 * R - 0.3854 * G + 0.5000 * B + 128
        # V = 0.5000 * R - 0.4542 * G - 0.0458 * B + 128
        self.mat = torch.tensor([
            [0.2126 * 255.0, 0.7152 * 255.0, 0.0722 * 255.0],
            [-0.1146 * 255.0, -0.3854 * 255.0, 0.5000 * 255.0],
            [0.5000 * 255.0, -0.4542 * 255.0, -0.0458 * 255.0]
        ], dtype=torch.float32, device="cuda")
        self.bias = torch.tensor([0.0, 128.0, 128.0], dtype=torch.float32, device="cuda").view(3, 1, 1)

        # Pre-allocated GPU buffer for flat assembled frame
        self.yuv_gpu = torch.empty(self.total_bytes, dtype=torch.uint8, device="cuda")

        # Pre-allocated host pinned memory buffer pool for zero-copy DMA transfers
        self.pinned_pool = [
            torch.empty(self.total_bytes, dtype=torch.uint8, pin_memory=True)
            for _ in range(self.pool_size)
        ]

    def convert_to_bytes(self, rgb_tensor: torch.Tensor) -> bytes:
        """Convert a (3, H, W) float32 [0,1] CUDA tensor into YUV raw bytes."""
        # 1. Vectorized linear projection on GPU
        yuv_float = torch.einsum('ij,jhw->ihw', self.mat, rgb_tensor) + self.bias
        y_u8 = yuv_float[0].clamp(0, 255).to(torch.uint8)

        if self.chroma == "yuv420p":
            # 2. Batched 2x2 average pool for U and V channels simultaneously on GPU
            uv_sub = F.avg_pool2d(yuv_float[1:].unsqueeze(0), kernel_size=2, stride=2).squeeze(0)
            uv_u8 = uv_sub.clamp(0, 255).to(torch.uint8)

            # 3. Assemble flat contiguous frame in GPU memory
            self.yuv_gpu[:self.y_size] = y_u8.reshape(-1)
            self.yuv_gpu[self.y_size:self.y_size + self.uv_size] = uv_u8[0].reshape(-1)
            self.yuv_gpu[self.y_size + self.uv_size:] = uv_u8[1].reshape(-1)
        else:
            uv_u8 = yuv_float[1:].clamp(0, 255).to(torch.uint8)
            self.yuv_gpu[:self.y_size] = y_u8.reshape(-1)
            self.yuv_gpu[self.y_size:self.y_size + self.uv_size] = uv_u8[0].reshape(-1)
            self.yuv_gpu[self.y_size + self.uv_size:] = uv_u8[1].reshape(-1)

        # 4. DMA transfer to host pinned memory
        pinned_buf = self.pinned_pool[self.pool_idx % self.pool_size]
        self.pool_idx += 1
        pinned_buf.copy_(self.yuv_gpu, non_blocking=False)

        return pinned_buf.numpy().tobytes()


# ---------------------------------------------------------------------------
# VSR processing
# ---------------------------------------------------------------------------

def _create_vsr(quality_level, out_w: int, out_h: int):
    """Create and load a VideoSuperRes effect."""
    nvvfx = check_nvvfx()
    vsr = nvvfx.VideoSuperRes(quality=quality_level)
    vsr.output_width = out_w
    vsr.output_height = out_h
    vsr.load()
    return vsr


# ---------------------------------------------------------------------------
# Pipelined Worker
# ---------------------------------------------------------------------------

def _run_pipeline(video_path: str, out_target, quality_level, start_time: float = 0.0,
                  is_stream: bool = False, scale: float = 2.0, bitrate: str = "12M",
                  chroma: str = "yuv420p"):
    """Core 3-stage concurrent pipeline: Decode (I/O) ∥ VSR + YUV (GPU) ∥ NVENC (Encode)."""
    probe = _probe_video(video_path)
    src_w, src_h = probe["width"], probe["height"]
    fps, duration = probe["fps"], probe["duration"]

    if src_w == 0 or src_h == 0:
        print("[RTX VSR] FATAL: could not probe source video", file=sys.stderr)
        return False

    out_w = int(src_w * scale)
    out_h = int(src_h * scale)
    # Dimensions must be even for NVENC and YUV420p subsampling
    out_w = out_w - (out_w % 2)
    out_h = out_h - (out_h % 2)

    print(f"[RTX VSR] Source: {src_w}x{src_h} @ {fps:.2f}fps → Output: {out_w}x{out_h}", file=sys.stderr)

    dec_cmd = _build_decoder_cmd(video_path, start_time)
    if is_stream:
        enc_cmd = _build_encoder_stream_cmd(out_w, out_h, fps, bitrate, chroma)
    else:
        enc_cmd = _build_encoder_file_cmd(out_w, out_h, fps, out_target, chroma)

    # Spawn decoder & encoder with high-throughput pipes
    dec_proc = subprocess.Popen(
        dec_cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=PIPE_BUF_SIZE,
    )

    enc_proc = subprocess.Popen(
        enc_cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE if is_stream else None,
        stderr=subprocess.PIPE,
        bufsize=PIPE_BUF_SIZE,
    )

    def log_stderr(proc, label):
        for line in iter(proc.stderr.readline, b""):
            line_str = line.decode("utf-8", errors="ignore").strip()
            if line_str:
                print(f"[{label}] {line_str}", file=sys.stderr)

    dec_err_thread = threading.Thread(target=log_stderr, args=(dec_proc, "ffmpeg-dec"), daemon=True)
    enc_err_thread = threading.Thread(target=log_stderr, args=(enc_proc, "ffmpeg-enc"), daemon=True)
    dec_err_thread.start()
    enc_err_thread.start()

    # Stream mode: Forward encoder stdout → process stdout in chunks
    fwd_thread = None
    if is_stream:
        def forward_stdout():
            try:
                while True:
                    chunk = enc_proc.stdout.read(STREAM_CHUNK_SIZE)
                    if not chunk:
                        break
                    sys.stdout.buffer.write(chunk)
                    sys.stdout.buffer.flush()
            except Exception as e:
                print(f"[RTX VSR] stdout forward error: {e}", file=sys.stderr)

        fwd_thread = threading.Thread(target=forward_stdout, daemon=True)
        fwd_thread.start()

    # Load VSR effect on GPU
    vsr = _create_vsr(quality_level, out_w, out_h)
    gpu_yuv = GpuYuvConverter(out_w, out_h, chroma=chroma, pool_size=QUEUE_MAXSIZE)

    frame_bytes = src_w * src_h * 3
    input_queue = queue.Queue(maxsize=QUEUE_MAXSIZE)
    output_queue = queue.Queue(maxsize=QUEUE_MAXSIZE)
    stop_event = threading.Event()
    error_flag = [False]

    # Stage 1: Reader thread (decodes frames into pre-allocated memory)
    def reader_worker():
        try:
            while not stop_event.is_set():
                buf = bytearray(frame_bytes)
                view = memoryview(buf)
                pos = 0
                while pos < frame_bytes:
                    nread = dec_proc.stdout.readinto(view[pos:])
                    if not nread:
                        break
                    pos += nread
                if pos < frame_bytes:
                    break
                input_queue.put(buf)
        except Exception as e:
            print(f"[RTX VSR] reader error: {e}", file=sys.stderr)
            error_flag[0] = True
        finally:
            input_queue.put(None)

    # Stage 3: Writer thread (sends encoded frames to NVENC stdin)
    def writer_worker():
        try:
            while True:
                data = output_queue.get()
                if data is None:
                    break
                enc_proc.stdin.write(data)
        except BrokenPipeError:
            pass
        except Exception as e:
            print(f"[RTX VSR] writer error: {e}", file=sys.stderr)
            error_flag[0] = True
        finally:
            try:
                enc_proc.stdin.close()
            except Exception:
                pass

    t_reader = threading.Thread(target=reader_worker, daemon=True)
    t_writer = threading.Thread(target=writer_worker, daemon=True)
    t_reader.start()
    t_writer.start()

    frame_count = 0
    total_frame_count = int(duration * fps) if duration > 0 else 0
    t_start = time.perf_counter()
    t_last = t_start

    # Stage 2: Main GPU Worker (Ingestion -> VSR -> Fused YUV)
    try:
        while not stop_event.is_set():
            buf = input_queue.get()
            if buf is None:
                break

            # bytearray-backed tensors are not pinned, so this upload is deliberately
            # synchronous. A future pinned-buffer pool can make this non-blocking.
            t_gpu = torch.frombuffer(buf, dtype=torch.uint8).reshape(src_h, src_w, 3).to("cuda")
            # Permute & normalize to float32 directly in CUDA memory
            frame_torch = t_gpu.permute(2, 0, 1).contiguous().to(dtype=torch.float32) / 255.0

            # Run VSR inference
            result = vsr.run(frame_torch)
            out_tensor = torch.from_dlpack(result.image)

            # Fused GPU YUV conversion & host DMA transfer
            yuv_bytes = gpu_yuv.convert_to_bytes(out_tensor)
            while not stop_event.is_set():
                try:
                    output_queue.put(yuv_bytes, timeout=0.1)
                    break
                except queue.Full:
                    if not t_writer.is_alive() or error_flag[0]:
                        raise RuntimeError("writer thread died unexpectedly")

            frame_count += 1
            if frame_count % 30 == 0:
                t_now = time.perf_counter()
                fps_instant = 30.0 / max(0.001, t_now - t_last)
                t_last = t_now
                if total_frame_count > 0:
                    print(f"[RTX VSR] Processed {frame_count} / {total_frame_count} frames ({fps_instant:.1f} FPS)", file=sys.stderr, end="\r", flush=True)
                else:
                    print(f"[RTX VSR] Processed {frame_count} frames ({fps_instant:.1f} FPS)", file=sys.stderr, end="\r", flush=True)

    except BrokenPipeError:
        print("[RTX VSR] Pipeline broken (expected on stop)", file=sys.stderr)
    except Exception as e:
        print(f"[RTX VSR] Pipeline error: {e}", file=sys.stderr)
        error_flag[0] = True
    finally:
        stop_event.set()
        while t_writer.is_alive():
            try:
                output_queue.put(None, timeout=0.1)
                break
            except queue.Full:
                continue
        t_writer.join(timeout=10)

        # Wait for encoder
        try:
            enc_proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            enc_proc.kill()

        # Terminate decoder
        if dec_proc.poll() is None:
            dec_proc.kill()
        dec_proc.wait()

        if fwd_thread:
            fwd_thread.join(timeout=5)

        vsr.close()
        del vsr
        import gc
        gc.collect()
        torch.cuda.empty_cache()

    if error_flag[0]:
        return False

    t_total = max(0.001, time.perf_counter() - t_start)
    avg_fps = frame_count / t_total
    print(f"\n[RTX VSR] Completed {frame_count} frames in {t_total:.2f}s ({avg_fps:.1f} avg FPS)", file=sys.stderr)
    return True


# ---------------------------------------------------------------------------
# Stream mode
# ---------------------------------------------------------------------------

def stream_mode(video_path: str, start_time: float = 0.0, quality: str = "HIGH", scale: float = 2.0, bitrate: str = "12M", chroma: str = "yuv420p"):
    """Stream fragmented MP4 to stdout for MediaSource consumption."""
    nvvfx = check_nvvfx()
    quality_map = {
        "LOW": nvvfx.VideoSuperRes.QualityLevel.LOW,
        "MEDIUM": nvvfx.VideoSuperRes.QualityLevel.MEDIUM,
        "HIGH": nvvfx.VideoSuperRes.QualityLevel.HIGH,
        "ULTRA": nvvfx.VideoSuperRes.QualityLevel.ULTRA,
    }
    ql = quality_map.get(quality.upper(), nvvfx.VideoSuperRes.QualityLevel.HIGH)

    success = _run_pipeline(
        video_path=video_path,
        out_target=None,
        quality_level=ql,
        start_time=start_time,
        is_stream=True,
        scale=scale,
        bitrate=bitrate,
        chroma=chroma
    )
    return success


# ---------------------------------------------------------------------------
# Enhance mode (permanent file)
# ---------------------------------------------------------------------------

def enhance_mode(video_path: str, output_path: str, quality: str = "HIGH", scale: float = 2.0, chroma: str = "yuv420p"):
    """Process entire video and save to output_path.

    Uses an atomic temp-file write: output_path.tmp is produced first, then
    renamed to output_path only when the pipeline completes successfully.
    A crash or cancellation therefore leaves the original final file intact
    and only a disposable .tmp file behind.
    """
    nvvfx = check_nvvfx()
    quality_map = {
        "LOW": nvvfx.VideoSuperRes.QualityLevel.LOW,
        "MEDIUM": nvvfx.VideoSuperRes.QualityLevel.MEDIUM,
        "HIGH": nvvfx.VideoSuperRes.QualityLevel.HIGH,
        "ULTRA": nvvfx.VideoSuperRes.QualityLevel.ULTRA,
    }
    ql = quality_map.get(quality.upper(), nvvfx.VideoSuperRes.QualityLevel.HIGH)

    temp_path = output_path + ".tmp"
    if os.path.exists(temp_path):
        try:
            os.remove(temp_path)
        except Exception as e:
            print(f"[RTX VSR] Warning: could not remove stale temp file {temp_path}: {e}", file=sys.stderr)

    success = _run_pipeline(
        video_path=video_path,
        out_target=temp_path,
        quality_level=ql,
        start_time=0.0,
        is_stream=False,
        scale=scale,
        chroma=chroma
    )

    if success and os.path.exists(temp_path) and os.path.getsize(temp_path) > 0:
        try:
            os.replace(temp_path, output_path)
            print(f"[RTX VSR] Enhanced file saved: {output_path}")
            sys.stdout.flush()
        except Exception as e:
            print(f"[RTX VSR] Failed to promote temp file to {output_path}: {e}", file=sys.stderr)
            try:
                os.remove(temp_path)
            except Exception:
                pass
            sys.exit(1)
    else:
        if os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except Exception:
                pass
        print(f"[RTX VSR] FAILED", file=sys.stderr)
        sys.exit(1)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="RTX VSR pipeline for Vault Explorer")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_stream = sub.add_parser("stream", help="Stream upscaled video to stdout")
    p_stream.add_argument("video_path")
    p_stream.add_argument("--start-time", type=float, default=0.0)
    p_stream.add_argument("--quality", default="HIGH")
    p_stream.add_argument("--scale", type=float, default=2.0)
    p_stream.add_argument("--bitrate", default="12M")
    p_stream.add_argument("--chroma", default="yuv420p")

    p_enhance = sub.add_parser("enhance", help="Enhance video file permanently")
    p_enhance.add_argument("video_path")
    p_enhance.add_argument("output_path")
    p_enhance.add_argument("--quality", default="HIGH")
    p_enhance.add_argument("--scale", type=float, default=2.0)
    p_enhance.add_argument("--chroma", default="yuv420p")

    args = parser.parse_args()

    if args.cmd == "stream":
        stream_mode(args.video_path, args.start_time, args.quality, args.scale, args.bitrate, args.chroma)
        sys.stdout.flush()
        os._exit(0)
    elif args.cmd == "enhance":
        enhance_mode(args.video_path, args.output_path, args.quality, args.scale, args.chroma)
        sys.stdout.flush()
        os._exit(0)


if __name__ == "__main__":
    main()
