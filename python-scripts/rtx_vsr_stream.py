#!/usr/bin/env python3
"""
rtx_vsr_stream.py — Real-time RTX Video Super Resolution pipeline for Vault Explorer.

Modes:
  stream:  Decode → VSR (2x) → NVENC → fragmented MP4 to stdout (for MediaSource)
  enhance: Decode → VSR (2x) → NVENC → file output (permanent enhancement)

Usage:
  python rtx_vsr_stream.py stream   <video_path> [--start-time SEC]
  python rtx_vsr_stream.py enhance <video_path> <output_path> [--quality LEVEL]
"""

import argparse
import io
import os
import re
import struct
import subprocess
import sys
import threading
import time

import numpy as np
import torch

# nvvfx has nanobind leak warnings on exit; we suppress them by flushing
# stdout before exit and using os._exit(0) in non-error paths.
try:
    import nvvfx
except ImportError as e:
    print(f"[RTX VSR] FATAL: nvidia-vfx not installed: {e}", file=sys.stderr)
    sys.exit(2)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
CHUNK_SIZE = 4096          # Bytes read from ffmpeg stdout at a time
FFMPEG_PIX_FMT = "rgb24"   # Raw RGB bytes from decoder

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
    """ffmpeg command that outputs raw RGB24 frames on stdout."""
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostats"]
    if start_time > 0:
        cmd += ["-ss", str(start_time)]
    cmd += [
        "-i", path,
        "-pix_fmt", FFMPEG_PIX_FMT,
        "-f", "rawvideo",
        "-",
    ]
    return cmd


def _build_encoder_stream_cmd(width: int, height: int, fps: float, bitrate: str = "12M", chroma: str = "yuv420p"):
    """ffmpeg command that reads raw yuv420p on stdin and outputs
    fragmented MP4 (fMP4) suitable for MediaSource sequence mode."""
    # Derive maxrate and bufsize from bitrate string
    import re
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
    maxrate = f"{int(bps * 1.25)}{suffix}" if suffix else f"{int(bps * 1.25)}"
    bufsize = f"{int(bps * 2)}{suffix}" if suffix else f"{int(bps * 2)}"
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostats",
        "-f", "rawvideo",
        "-pix_fmt", FFMPEG_PIX_FMT,
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
    """ffmpeg command for permanent file enhancement."""
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
        "-y", out_path,
    ]
    return cmd


# ---------------------------------------------------------------------------
# VSR processing
# ---------------------------------------------------------------------------

def _create_vsr(quality_level, out_w: int, out_h: int):
    """Create and load a VideoSuperRes effect."""
    vsr = nvvfx.VideoSuperRes(quality=quality_level)
    vsr.output_width = out_w
    vsr.output_height = out_h
    vsr.load()
    return vsr


def _process_frame_tensor(vsr, frame_torch: torch.Tensor):
    """Run a single (3, H, W) float32 CUDA frame through VSR.
    Returns cloned output tensor on CUDA."""
    result = vsr.run(frame_torch)
    out = torch.from_dlpack(result.image).clone()
    return out


def _tensor_to_yuv(tensor: torch.Tensor, chroma: str = "yuv420p"):
    """Convert a (3, H, W) float32 [0,1] RGB CUDA tensor to a YUV byte buffer.
    Supports yuv420p and yuv444p. Returns bytes suitable for ffmpeg stdin."""
    rgb = (tensor * 255.0).clamp(0, 255).to(torch.uint8)
    rgb = rgb.to("cpu").contiguous().numpy()  # (3, H, W) uint8

    h, w = rgb.shape[1], rgb.shape[2]
    r, g, b = rgb[0].astype(np.float32), rgb[1].astype(np.float32), rgb[2].astype(np.float32)

    y = (0.2126 * r + 0.7152 * g + 0.0722 * b).clip(0, 255).astype(np.uint8)
    u = (-0.1146 * r - 0.3854 * g + 0.5000 * b + 128.0).clip(0, 255).astype(np.uint8)
    v = (0.5000 * r - 0.4542 * g - 0.0458 * b + 128.0).clip(0, 255).astype(np.uint8)

    if chroma == "yuv444p":
        return y.tobytes() + u.tobytes() + v.tobytes()
    # yuv420p — downsample chroma 2x2 with averaging for better quality
    u_avg = ((u[0::2, 0::2].astype(np.uint16) + u[0::2, 1::2].astype(np.uint16) +
              u[1::2, 0::2].astype(np.uint16) + u[1::2, 1::2].astype(np.uint16)) // 4).astype(np.uint8)
    v_avg = ((v[0::2, 0::2].astype(np.uint16) + v[0::2, 1::2].astype(np.uint16) +
              v[1::2, 0::2].astype(np.uint16) + v[1::2, 1::2].astype(np.uint16)) // 4).astype(np.uint8)
    return y.tobytes() + u_avg.tobytes() + v_avg.tobytes()


# ---------------------------------------------------------------------------
# Pipeline worker
# ---------------------------------------------------------------------------

def _run_pipeline(video_path: str, out_target, quality_level, start_time: float = 0.0, is_stream: bool = False, scale: float = 2.0, bitrate: str = "12M", chroma: str = "yuv420p"):
    """Core pipeline: decode → VSR → encode.

    out_target: either a file path (str) or a writable buffer (for stream mode).
    is_stream: True → write fragmented MP4 chunks to stdout.
    """
    probe = _probe_video(video_path)
    src_w, src_h = probe["width"], probe["height"]
    fps = probe["fps"]

    if src_w == 0 or src_h == 0:
        print("[RTX VSR] FATAL: could not probe source video", file=sys.stderr)
        return False

    out_w = int(src_w * scale)
    out_h = int(src_h * scale)

    print(f"[RTX VSR] Source: {src_w}x{src_h} @ {fps:.2f}fps → Output: {out_w}x{out_h}", file=sys.stderr)

    # Build ffmpeg commands
    dec_cmd = _build_decoder_cmd(video_path, start_time)
    if is_stream:
        enc_cmd = _build_encoder_stream_cmd(out_w, out_h, fps, bitrate, chroma)
    else:
        enc_cmd = _build_encoder_file_cmd(out_w, out_h, fps, out_target, chroma)

    # Spawn decoder
    dec_proc = subprocess.Popen(
        dec_cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0,
    )

    # Spawn encoder
    enc_proc = subprocess.Popen(
        enc_cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE if is_stream else None,
        stderr=subprocess.PIPE,
        bufsize=0,
    )

    # Load VSR on GPU
    vsr = _create_vsr(quality_level, out_w, out_h)

    frame_bytes = src_w * src_h * 3
    frame_count = 0
    error_flag = [False]

    def read_decoder_stderr():
        for line in iter(dec_proc.stderr.readline, b""):
            line_str = line.decode("utf-8", errors="ignore").strip()
            if line_str:
                print(f"[ffmpeg-dec] {line_str}", file=sys.stderr)

    def read_encoder_stderr():
        for line in iter(enc_proc.stderr.readline, b""):
            line_str = line.decode("utf-8", errors="ignore").strip()
            if line_str:
                print(f"[ffmpeg-enc] {line_str}", file=sys.stderr)

    dec_err_thread = threading.Thread(target=read_decoder_stderr, daemon=True)
    enc_err_thread = threading.Thread(target=read_encoder_stderr, daemon=True)
    dec_err_thread.start()
    enc_err_thread.start()

    try:
        while True:
            raw = dec_proc.stdout.read(frame_bytes)
            if not raw or len(raw) < frame_bytes:
                break

            # RGB24 → torch tensor (3, H, W), float32, [0,1], CUDA
            arr = np.frombuffer(raw, dtype=np.uint8).reshape((src_h, src_w, 3))
            arr = np.transpose(arr, (2, 0, 1))  # (3, H, W)
            frame_torch = torch.from_numpy(arr).to(dtype=torch.float32, device="cuda") / 255.0

            # VSR
            out_torch = _process_frame_tensor(vsr, frame_torch)

            # Tensor → YUV bytes → encoder stdin
            yuv_bytes = _tensor_to_yuv(out_torch, chroma)
            enc_proc.stdin.write(yuv_bytes)

            frame_count += 1
            if frame_count % 30 == 0:
                print(f"[RTX VSR] Processed {frame_count} frames", file=sys.stderr)

    except BrokenPipeError:
        print("[RTX VSR] Pipeline broken (expected on stop)", file=sys.stderr)
    except Exception as e:
        print(f"[RTX VSR] Pipeline error: {e}", file=sys.stderr)
        error_flag[0] = True
    finally:
        # Close encoder stdin to signal EOF
        try:
            enc_proc.stdin.close()
        except Exception:
            pass

        # Wait for encoder to finish
        try:
            enc_proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            enc_proc.kill()

        # Kill decoder if still running
        if dec_proc.poll() is None:
            dec_proc.kill()
        dec_proc.wait()

        vsr.close()
        del vsr
        import gc
        gc.collect()
        torch.cuda.empty_cache()

    if error_flag[0]:
        return False

    print(f"[RTX VSR] Total frames processed: {frame_count}", file=sys.stderr)
    return True


# ---------------------------------------------------------------------------
# Stream mode
# ---------------------------------------------------------------------------

def stream_mode(video_path: str, start_time: float = 0.0, quality: str = "HIGH", scale: float = 2.0, bitrate: str = "12M", chroma: str = "yuv420p"):
    """Stream fragmented MP4 to stdout for MediaSource consumption."""
    quality_map = {
        "LOW": nvvfx.VideoSuperRes.QualityLevel.LOW,
        "MEDIUM": nvvfx.VideoSuperRes.QualityLevel.MEDIUM,
        "HIGH": nvvfx.VideoSuperRes.QualityLevel.HIGH,
        "ULTRA": nvvfx.VideoSuperRes.QualityLevel.ULTRA,
    }
    ql = quality_map.get(quality.upper(), nvvfx.VideoSuperRes.QualityLevel.HIGH)

    # For streaming we write raw fMP4 bytes to stdout in binary mode
    # We don't use the _run_pipeline helper directly because we need
    # to forward encoder stdout to our stdout in real time.
    probe = _probe_video(video_path)
    src_w, src_h = probe["width"], probe["height"]
    fps = probe["fps"]

    if src_w == 0 or src_h == 0:
        print("[RTX VSR] FATAL: could not probe source video", file=sys.stderr)
        sys.exit(1)

    out_w, out_h = int(src_w * scale), int(src_h * scale)
    print(f"[RTX VSR] stream: {src_w}x{src_h} → {out_w}x{out_h} quality={quality} scale={scale} bitrate={bitrate}", file=sys.stderr)

    dec_cmd = _build_decoder_cmd(video_path, start_time)
    enc_cmd = _build_encoder_stream_cmd(out_w, out_h, fps, bitrate, chroma)

    dec_proc = subprocess.Popen(dec_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
    enc_proc = subprocess.Popen(enc_cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)

    vsr = _create_vsr(ql, out_w, out_h)
    frame_bytes = src_w * src_h * 3
    frame_count = 0
    stopped = [False]

    # Forward encoder stdout → our stdout (MediaSource chunks)
    def forward_stdout():
        try:
            while True:
                chunk = enc_proc.stdout.read(CHUNK_SIZE)
                if not chunk:
                    break
                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()
        except Exception as e:
            print(f"[RTX VSR] forward error: {e}", file=sys.stderr)

    fwd_thread = threading.Thread(target=forward_stdout, daemon=True)
    fwd_thread.start()

    def log_stderr(proc, label):
        for line in iter(proc.stderr.readline, b""):
            line_str = line.decode("utf-8", errors="ignore").strip()
            if line_str:
                print(f"[{label}] {line_str}", file=sys.stderr)

    dec_err = threading.Thread(target=log_stderr, args=(dec_proc, "dec"), daemon=True)
    enc_err = threading.Thread(target=log_stderr, args=(enc_proc, "enc"), daemon=True)
    dec_err.start()
    enc_err.start()

    try:
        while not stopped[0]:
            raw = dec_proc.stdout.read(frame_bytes)
            if not raw or len(raw) < frame_bytes:
                break

            arr = np.frombuffer(raw, dtype=np.uint8).reshape((src_h, src_w, 3))
            arr = np.transpose(arr, (2, 0, 1))
            frame_torch = torch.from_numpy(arr).to(dtype=torch.float32, device="cuda") / 255.0
            out_torch = _process_frame_tensor(vsr, frame_torch)
            yuv_bytes = _tensor_to_yuv(out_torch, chroma)
            enc_proc.stdin.write(yuv_bytes)
            frame_count += 1
    except BrokenPipeError:
        pass
    except Exception as e:
        print(f"[RTX VSR] stream error: {e}", file=sys.stderr)
    finally:
        stopped[0] = True
        try:
            enc_proc.stdin.close()
        except Exception:
            pass

        try:
            enc_proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            enc_proc.kill()

        if dec_proc.poll() is None:
            dec_proc.kill()
        dec_proc.wait()

        fwd_thread.join(timeout=5)

        vsr.close()
        del vsr
        import gc
        gc.collect()
        torch.cuda.empty_cache()

    print(f"[RTX VSR] Stream ended after {frame_count} frames", file=sys.stderr)


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
    quality_map = {
        "LOW": nvvfx.VideoSuperRes.QualityLevel.LOW,
        "MEDIUM": nvvfx.VideoSuperRes.QualityLevel.MEDIUM,
        "HIGH": nvvfx.VideoSuperRes.QualityLevel.HIGH,
        "ULTRA": nvvfx.VideoSuperRes.QualityLevel.ULTRA,
    }
    ql = quality_map.get(quality.upper(), nvvfx.VideoSuperRes.QualityLevel.HIGH)

    temp_path = output_path + ".tmp"
    # Remove any stale temp file from a previous interrupted run.
    if os.path.exists(temp_path):
        try:
            os.remove(temp_path)
        except Exception as e:
            print(f"[RTX VSR] Warning: could not remove stale temp file {temp_path}: {e}", file=sys.stderr)

    success = _run_pipeline(video_path, temp_path, ql, start_time=0.0, is_stream=False, scale=scale, chroma=chroma)

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
        # nanobind leak detector causes exit code 1; force clean exit
        sys.stdout.flush()
        os._exit(0)
    elif args.cmd == "enhance":
        enhance_mode(args.video_path, args.output_path, args.quality, args.scale, args.chroma)
        sys.stdout.flush()
        os._exit(0)


if __name__ == "__main__":
    main()
