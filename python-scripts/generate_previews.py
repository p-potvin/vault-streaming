import os
import sys
import subprocess
import shutil
import time

SUPPORTED_EXTENSIONS = ('.mp4', '.mkv', '.avi', '.mov', '.webm', '.ts', '.wmv')

def get_video_duration(path):
    cmd = [
        'ffprobe', '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', path
    ]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return float(res.stdout.strip())
    except Exception:
        return 0.0

def check_audio_stream(video_path):
    cmd = [
        'ffprobe', '-v', 'error', '-select_streams', 'a',
        '-show_entries', 'stream=codec_name',
        '-of', 'default=noprint_wrappers=1:nokey=1', video_path
    ]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return bool(res.stdout.strip())
    except Exception:
        return False

def generate_thumb_and_preview(video_path, vault_root):
    dir_name = os.path.dirname(video_path)
    
    # Skip trickplay or normalized folders recursively
    if '.trickplay' in dir_name or '.normalized' in dir_name or '.thumbs' in dir_name:
        return
        
    thumbs_dir = os.path.join(dir_name, '.thumbs')
    if not os.path.exists(thumbs_dir):
        os.makedirs(thumbs_dir, exist_ok=True)
        
    base_name = os.path.basename(video_path)
    name_without_ext, _ = os.path.splitext(base_name)
    
    thumb_path = os.path.join(thumbs_dir, f"{name_without_ext}.jpg")
    webm_path = os.path.join(thumbs_dir, f"{name_without_ext}.webm")
    
    # Migrate adjacent files into local .thumbs if they exist
    old_thumb_path = os.path.join(dir_name, f"{name_without_ext}.jpg")
    if os.path.exists(old_thumb_path) and not os.path.exists(thumb_path):
        try: shutil.move(old_thumb_path, thumb_path)
        except Exception: pass
        
    old_webm_path = os.path.join(dir_name, f"{name_without_ext}.webm")
    if os.path.exists(old_webm_path) and not os.path.exists(webm_path):
        try: shutil.move(old_webm_path, webm_path)
        except Exception: pass
        
    # Also migrate from global root .thumbs if exists
    global_thumbs_dir = os.path.join(vault_root, '.thumbs')
    if os.path.exists(global_thumbs_dir):
        base_without_ext, _ = os.path.splitext(video_path)
        rel_path = os.path.relpath(base_without_ext, vault_root)
        unique_base = "".join([c if c.isalnum() else '_' for c in rel_path])
        
        global_thumb = os.path.join(global_thumbs_dir, f"{unique_base}.jpg")
        global_webm = os.path.join(global_thumbs_dir, f"{unique_base}.webm")
        if os.path.exists(global_thumb) and not os.path.exists(thumb_path):
            try: shutil.move(global_thumb, thumb_path)
            except Exception: pass
        if os.path.exists(global_webm) and not os.path.exists(webm_path):
            try: shutil.move(global_webm, webm_path)
            except Exception: pass

    # Skip if BOTH exist
    if os.path.exists(thumb_path) and os.path.exists(webm_path):
        print(f"  -> Skipping: both thumbnail and WebM preview already exist.")
        return
        
    # If one exists but not the other, delete the partial one to force clean regeneration
    if os.path.exists(thumb_path):
        try: os.remove(thumb_path)
        except Exception: pass
    if os.path.exists(webm_path):
        try: os.remove(webm_path)
        except Exception: pass
        
    duration = get_video_duration(video_path)
    if duration <= 0:
        print(f"  -> Skipping {video_path}: invalid duration.")
        return
        
    has_audio = check_audio_stream(video_path)
        
    # 1. Generate non-blurry middle keyframe thumbnail
    middle_time = duration / 2.0 if duration > 0 else 5.0
    print(f"  -> Generating keyframe thumbnail closest to middle ({middle_time:.2f}s)...")
    cmd_thumb = [
        'ffmpeg', '-y',
        '-threads', '1',
        '-ss', f"{middle_time:.2f}",
        '-i', video_path,
        '-vf', "select='eq(pict_type,I)'",
        '-vframes', '1',
        '-q:v', '2',
        thumb_path,
        '-loglevel', 'error'
    ]
    try:
        subprocess.run(cmd_thumb, check=True)
    except subprocess.CalledProcessError as e:
        print(f"  [ERROR] Keyframe thumbnail failed: {e}")
        
    # 2. Generate seamless continuous WebM Preview
    print(f"  -> Generating seamless WebM preview (duration: {duration:.2f}s, audio: {has_audio})...")
    if duration <= 100.0:
        # Transcode full video
        cmd_webm = [
            'ffmpeg', '-y',
            '-threads', '2',
            '-i', video_path,
            '-c:v', 'libvpx-vp9',
            '-b:v', '1M',
            '-deadline', 'realtime',
            '-cpu-used', '8'
        ]
        if has_audio:
            cmd_webm.extend(['-c:a', 'libopus', '-b:a', '64k'])
        else:
            cmd_webm.append('-an')
        cmd_webm.extend([webm_path, '-loglevel', 'error'])
        
        try:
            subprocess.run(cmd_webm, check=True)
            print("  [SUCCESS] Full preview transcoded.")
        except subprocess.CalledProcessError as e:
            print(f"  [ERROR] Full transcode failed: {e}")
    else:
        # Generate multi-clip continuous WebM using a single filter_complex command to avoid VLC crashing
        num_clips = 12
        interval = duration / num_clips
        clip_dur = 5.0
        
        cmd_webm = ['ffmpeg', '-y', '-threads', '2']
        filter_str = ""
        for i in range(num_clips):
            seek_time = interval * i
            cmd_webm.extend(['-ss', f"{seek_time:.2f}", '-t', f"{clip_dur:.2f}", '-i', video_path])
            filter_str += f"[{i}:v]"
            if has_audio:
                filter_str += f"[{i}:a]"
                
        filter_str += f"concat=n={num_clips}:v=1:a={1 if has_audio else 0}[outv]"
        if has_audio:
            filter_str += "[outa]"
            
        cmd_webm.extend([
            '-filter_complex', filter_str,
            '-map', '[outv]'
        ])
        if has_audio:
            cmd_webm.extend(['-map', '[outa]'])
            
        cmd_webm.extend([
            '-c:v', 'libvpx-vp9',
            '-b:v', '1M',
            '-deadline', 'realtime',
            '-cpu-used', '8'
        ])
        if has_audio:
            cmd_webm.extend(['-c:a', 'libopus', '-b:a', '64k'])
        else:
            cmd_webm.append('-an')
            
        cmd_webm.extend([webm_path, '-loglevel', 'error'])
        
        try:
            subprocess.run(cmd_webm, check=True)
            print(f"  [SUCCESS] Continuous WebM preview compiled.")
        except subprocess.CalledProcessError as e:
            print(f"  [ERROR] Filter complex compile failed: {e}")

def main():
    if len(sys.argv) > 1:
        scan_dir = sys.argv[1]
    else:
        scan_dir = 'F:\\' if os.path.exists('F:\\') else os.path.abspath(os.sep)
        
    print(f"==================================================")
    print(f"Vault Previews Background Generator starting")
    print(f"Scanning target: {scan_dir}")
    print(f"Started at: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"==================================================")
    
    if not os.path.exists(scan_dir):
        print(f"Target directory {scan_dir} does not exist. Exiting.")
        sys.exit(1)
        
    # Gather files
    video_files = []
    for root, dirs, files in os.walk(scan_dir):
        # Skip existing .thumbs, .normalized, .trickplay, hidden, and Windows system/recycle directories
        dirs[:] = [d for d in dirs if d != '.thumbs' and d != '.normalized' and not d.startswith('.') and not d.endswith('.trickplay') and not d.startswith('$') and d.lower() != 'system volume information']
            
        for file in files:
            if file.lower().endswith(SUPPORTED_EXTENSIONS):
                file_lower = file.lower()
                # Ensure we don't process preview clips
                if '_p.mp4' in file_lower or '-preview.mp4' in file_lower or '-preview' in file_lower or file_lower.endswith('.webm'):
                    base, _ = os.path.splitext(file_lower)
                    has_primary_sibling = any(os.path.exists(os.path.join(root, base + ext)) for ext in ['.mp4', '.mkv', '.avi', '.mov', '.ts', '.wmv'])
                    if has_primary_sibling or file_lower.endswith('.webm') or file_lower.endswith('-preview'):
                        continue
                video_files.append(os.path.join(root, file))
                
    # Process newest files first so recently added content gets previews fastest
    video_files.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    
    total_files = len(video_files)
    print(f"Found {total_files} video files to check.")
    
    for idx, video_path in enumerate(video_files):
        print(f"[{idx+1}/{total_files}] Processing: {video_path}")
        try:
            generate_thumb_and_preview(video_path, scan_dir)
        except Exception as e:
            print(f"  [CRITICAL ERROR] Failed processing {video_path}: {e}")
            
    print(f"\n==================================================")
    print(f"Processing finished successfully!")
    print(f"Ended at: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"==================================================")

if __name__ == '__main__':
    main()
