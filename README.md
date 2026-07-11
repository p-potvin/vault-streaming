# 📂 Vault Explorer

Vault Explorer is a hybrid desktop media vault and decentralized Home Media Server. It bridges powerful local hardware AI workflows (Whisper/NeMo transcription, ESRGAN upscaling, custom search indexing) with frictionless, cross-platform streaming access across phones, TVs, and web browsers.

## Features

- **Windows File Explorer Capabilities**: Fully-featured file management directly within the app, supporting Cut, Copy, Paste, Zip, and comprehensive file properties.
- **Home Media Server**: Lightweight embedded HLS/DASH streaming server for cross-platform access without native apps.
- **Livestream Translation**: Real-time AI transcription and translation for live video feeds.
- **Advanced Metadata**: Scrapes TMDB/TVDB for rich cover art, backdrops, and cast info. Compatible with Plex/Jellyfin NFOs.
- **Hybrid Streaming**: Seamlessly integrates local files with Real-Debrid unrestricted cloud streams.
- **Hardware AI Workflows**: Leverage your local GPU for video upscaling and audio processing.
- **Video Clipping**: Create and export video clips with custom start/end times, multiple format options, and quality settings.

## Development

Currently transitioning to a robust web-based media server while maintaining the rich desktop client functionality. The app is built with Electron and utilizes local FFmpeg and PowerShell scripts for backend processing.

Check the `ROADMAP.md` for our current implementation status across all application tabs.

---

## 🎬 Video Clipping Feature

The video clipping feature allows users to create custom clips from videos with precise start/end time selection, real-time preview, and multiple export options.

### Usage

1. Play any video in the Vault tab
2. Click the ⚡ (lightning bolt) clip button or press `C`
3. The video pauses and two markers appear on the seek bar:
   - **Start marker**: Positioned at `currentTime - 30s` (or 0 if < 30s)
   - **End marker**: Positioned at `currentTime`
4. Drag either marker to adjust the clip region
5. A live preview frame appears showing the current marker position
6. Click "Export Clip" to save the clip

### Clip Export Options

| Option | Description |
|--------|-------------|
| **Format** | WebM (VP9), MP4 (H.264), GIF |
| **Quality** | Original, 1080p, 720p, 480p |
| **Destination** | Desktop or Videos folder |

---

## 📋 FFmpeg Configuration Documentation

This section documents the EXACT FFmpeg setup used in Vault Explorer for video clipping. This documentation allows replication of the same environment in other projects.

### FFmpeg Version Requirements

**Recommended Version**: FFmpeg 6.0 or later

**Minimum Version**: FFmpeg 4.4 (for VP9/WebM support)

**Verification Command**:
```bash
ffmpeg -version
```

Expected output should include:
- `libvpx` encoder for WebM/VP9
- `libx264` encoder for MP4/H.264
- `libopus` encoder for WebM audio
- `aac` encoder for MP4 audio

### Installation

#### Windows (Recommended)

**Method 1: Official Builds**
1. Download from: https://ffmpeg.org/download.html
2. Choose: **Windows builds from gyan.dev** (recommended)
3. Download the `ffmpeg-master-latest-win64-gpl.zip`
4. Extract to `C:\ffmpeg`
5. Add `C:\ffmpeg\bin` to system PATH
6. Verify: `ffmpeg -version` in CMD

**Method 2: Chocolatey**
```powershell
choco install ffmpeg -y
```

**Method 3: Winget**
```powershell
winget install Gyan.FFmpeg -s winget
```

#### macOS

**Method 1: Homebrew**
```bash
brew install ffmpeg
```

**Method 2: Official Builds**
1. Download from: https://evermeet.cx/ffmpeg/
2. Extract and add to PATH

#### Linux (Ubuntu/Debian)

```bash
sudo apt update
sudo apt install ffmpeg -y
```

#### Linux (Fedora/RHEL)

```bash
sudo dnf install ffmpeg -y
```

### FFmpeg Path Resolution in Vault Explorer

The application searches for FFmpeg in the following order:

```javascript
const searchPaths = [
    'ffmpeg',                              // PATH lookup
    'C:\\ffmpeg\\bin\\ffmpeg.exe',       // Official Windows install
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\Program Files (x86)\\ffmpeg\\bin\\ffmpeg.exe',
    path.join(process.env['ProgramW6432'] || 'C:\\Program Files', 'ffmpeg', 'bin', 'ffmpeg.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'ffmpeg', 'bin', 'ffmpeg.exe'),
    path.join(process.cwd(), 'ffmpeg.exe'),   // Current directory
    path.join(process.cwd(), 'bin', 'ffmpeg.exe'),
    path.join(__dirname, '..', 'ffmpeg.exe'),  // App directory
    path.join(__dirname, '..', 'bin', 'ffmpeg.exe')
];
```

The first existing path is used.

### Clip Generation Parameters

#### Base Command Structure

```bash
ffmpeg -i {inputPath} -ss {startTime} -t {duration} [format-specific-options] -y {outputPath}
```

#### Format-Specific Parameters

##### WebM (VP9 + Opus) - **Default/Recommended**

**Use Case**: Best for web sharing, smallest file size, good quality

```bash
ffmpeg -i input.mp4 \
  -ss 10 \
  -t 30 \
  -c:v libvpx-vp9 \
  -crf 30 \
  -b:v 0 \
  -c:a libopus \
  -b:a 128k \
  -y output.webm
```

**Parameters Explained**:
- `-c:v libvpx-vp9`: Use VP9 video codec (royalty-free, excellent compression)
- `-crf 30`: Constant Rate Factor (0-63, lower = better quality, higher = smaller file)
  - 30 = Good balance (similar to YouTube's default)
  - 25-28 = Higher quality
  - 35-40 = Smaller files
- `-b:v 0`: Let encoder determine bitrate (CRF mode)
- `-c:a libopus`: Use Opus audio codec (superior to AAC for WebM)
- `-b:a 128k`: Audio bitrate (128kbps is sufficient for most content)

##### MP4 (H.264 + AAC) - Universal Compatibility

**Use Case**: Maximum compatibility across all devices and platforms

```bash
ffmpeg -i input.mp4 \
  -ss 10 \
  -t 30 \
  -c:v libx264 \
  -crf 23 \
  -preset fast \
  -c:a aac \
  -b:a 192k \
  -y output.mp4
```

**Parameters Explained**:
- `-c:v libx264`: Use H.264 video codec (widest compatibility)
- `-crf 23`: CRF value for H.264
  - 18-22 = High quality
  - 23 = Default (good balance)
  - 24-28 = Smaller files
- `-preset fast`: Encoding speed vs compression tradeoff
  - Options: `ultrafast`, `superfast`, `veryfast`, `faster`, `fast`, `medium`, `slow`, `slower`, `veryslow`
  - `fast` = Good balance (4-6x faster than `medium` with minimal quality loss)
- `-c:a aac`: Use AAC audio codec
- `-b:a 192k`: Audio bitrate (192kbps is CD quality)

##### GIF - Animated Image (No Audio)

**Use Case**: Looping animations, memes, social media (no audio support)

```bash
ffmpeg -i input.mp4 \
  -ss 10 \
  -t 30 \
  -vf "fps=15,scale=trunc(iw/2)*2:trunc(ih/2)*2" \
  -c:v gif \
  -f gif \
  -y output.gif
```

**Parameters Explained**:
- `-vf "fps=15"`: Reduce to 15 frames per second (standard for GIFs)
- `-vf "scale=trunc(iw/2)*2:trunc(ih/2)*2"`: Ensure even dimensions (required for GIF)
- `-c:v gif`: Use GIF encoder
- `-f gif`: Force GIF format
- **Note**: GIFs do not support audio. The audio stream is automatically dropped.

#### Quality/Resolution Scaling

When a quality option other than "Original" is selected, the following scaling is applied:

```bash
# 1080p
-vf "scale=1920:-2"

# 720p
-vf "scale=1280:-2"

# 480p
-vf "scale=854:-2"
```

**Parameter Explained**:
- `-2` in the scale filter maintains the aspect ratio
- Width is set to the target (1920, 1280, 854)
- Height is calculated automatically to maintain aspect ratio
- Even numbers ensure compatibility with most codecs

**Note**: The scaling filter is added BEFORE the codec options in the command.

#### Complete Command Examples

**Example 1: WebM, 720p, 30 seconds starting at 1:30**
```bash
ffmpeg -i "My Video.mp4" \
  -ss 90 \
  -t 30 \
  -vf "scale=1280:-2" \
  -c:v libvpx-vp9 \
  -crf 30 \
  -b:v 0 \
  -c:a libopus \
  -b:a 128k \
  -y "My Video_clip_1234567890.webm"
```

**Example 2: MP4, Original Quality, 15 seconds starting at 0:00**
```bash
ffmpeg -i "My Video.mp4" \
  -ss 0 \
  -t 15 \
  -c:v libx264 \
  -crf 23 \
  -preset fast \
  -c:a aac \
  -b:a 192k \
  -y "My Video_clip_1234567890.mp4"
```

**Example 3: GIF, 480p, 10 seconds starting at 2:00**
```bash
ffmpeg -i "My Video.mp4" \
  -ss 120 \
  -t 10 \
  -vf "fps=15,scale=854:-2" \
  -c:v gif \
  -f gif \
  -y "My Video_clip_1234567890.gif"
```

### Output File Naming Convention

```
{originalFilename}_clip_{timestamp}.{extension}
```

**Example**: `My Movie.mp4` → `My Movie_clip_1718000000000.webm`

- `{originalFilename}`: Base filename without extension
- `{timestamp}`: JavaScript `Date.now()` (milliseconds since epoch)
- `{extension}`: `webm`, `mp4`, or `gif`

### Output Directory

The application saves clips to:

1. **Primary**: User's Videos folder (`app.getPath('videos')`)
2. **Fallback**: User's Desktop (`app.getPath('desktop')`)

If the Videos folder doesn't exist, it falls back to Desktop.

### Required Codecs

For full functionality, FFmpeg must be compiled with the following codecs:

| Codec | Purpose | Check Command |
|-------|---------|---------------|
| libvpx-vp9 | WebM video encoding | `ffmpeg -codecs | grep libvpx` |
| libx264 | MP4 video encoding | `ffmpeg -codecs | grep libx264` |
| libopus | WebM audio encoding | `ffmpeg -codecs | grep libopus` |
| aac | MP4 audio encoding | `ffmpeg -codecs | grep aac` |
| gif | GIF encoding | `ffmpeg -codecs | grep gif` |

**Verification**:
```bash
ffmpeg -codecs 2>&1 | grep -E "libvpx|libx264|libopus|aac|gif"
```

### Error Handling

The application provides the following error messages:

| Error | Cause | Solution |
|-------|-------|----------|
| "ffmpeg not found" | FFmpeg binary not in PATH or known locations | Install FFmpeg as documented above |
| "Input file not found" | Source video file doesn't exist | Check file path |
| "Output file was not created" | FFmpeg failed silently | Check FFmpeg logs |
| "ffmpeg failed with code {N}" | FFmpeg returned non-zero exit code | See stderr for details |

### Performance Considerations

1. **Clip Duration**: Longer clips take more time and disk space
2. **Resolution**: Higher resolution = larger file size
3. **Format**: WebM (VP9) typically produces smaller files than MP4 (H.264)
4. **CRF Values**:
   - Lower CRF = Better quality, larger files
   - Higher CRF = Smaller files, lower quality
   - Recommended range: 23-30 for most use cases

### File Size Estimates

| Resolution | Format | CRF | Approx Size per Minute |
|-----------|--------|-----|----------------------|
| 1080p | WebM (VP9) | 30 | 30-50 MB |
| 720p | WebM (VP9) | 30 | 15-25 MB |
| 480p | WebM (VP9) | 30 | 8-12 MB |
| 1080p | MP4 (H.264) | 23 | 50-80 MB |
| 720p | MP4 (H.264) | 23 | 25-40 MB |
| 480p | MP4 (H.264) | 23 | 12-20 MB |

*Note: Actual sizes vary based on video content (motion, detail, etc.)*

### Testing FFmpeg Installation

**Basic Test**:
```bash
ffmpeg -version
```

**Codec Test**:
```bash
ffmpeg -encoders 2>&1 | grep -E "libvpx|libx264|libopus|aac|gif"
```

**Actual Clip Test**:
```bash
# Create a 10-second test clip
ffmpeg -i "test_video.mp4" -ss 0 -t 10 -c:v libvpx-vp9 -crf 30 -b:v 0 -c:a libopus -b:a 128k -y test_clip.webm
```

If this command succeeds and creates a playable `test_clip.webm`, your FFmpeg is properly configured.

---

### Troubleshooting

#### Issue: "ffmpeg not found"
**Solution**: Install FFmpeg and add it to PATH, or place `ffmpeg.exe` in the application directory.

#### Issue: "No video codec available"
**Solution**: Your FFmpeg build is missing required codecs. Download a full build (e.g., from gyan.dev).

#### Issue: "Permission denied"
**Solution**: Ensure write permissions in the output directory (Videos or Desktop).

#### Issue: Clips have no audio
**Solution**: Your FFmpeg build may lack audio codecs. Verify with `ffmpeg -codecs | grep opus` and `ffmpeg -codecs | grep aac`.

#### Issue: Poor quality clips
**Solution**: Lower the CRF value:
- WebM: Try CRF 25-28
- MP4: Try CRF 18-22

#### Issue: Large file sizes
**Solution**: 
- Use WebM format instead of MP4
- Increase CRF value
- Lower resolution
- Shorten clip duration

---

## 🔧 Replicating FFmpeg Environment in Other Projects

To replicate the exact FFmpeg behavior from Vault Explorer in another project:

### 1. FFmpeg Binary
Use the official builds from https://ffmpeg.org or https://gyan.dev/ffmpeg/builds/ (Windows).

### 2. Command Construction
```javascript
function buildFFmpegCommand(inputPath, outputFormat, startTime, duration, quality) {
    const args = [];
    
    // Input
    args.push('-i', inputPath);
    
    // Trim
    args.push('-ss', String(startTime));
    args.push('-t', String(duration));
    
    // Quality scaling (apply before codec)
    if (quality !== 'original') {
        const scaleMap = { '1080p': 1920, '720p': 1280, '480p': 854 };
        args.push('-vf', `scale=${scaleMap[quality]}:-2`);
    }
    
    // Format-specific codec options
    if (outputFormat === 'webm') {
        args.push('-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0');
        args.push('-c:a', 'libopus', '-b:a', '128k');
    } else if (outputFormat === 'mp4') {
        args.push('-c:v', 'libx264', '-crf', '23', '-preset', 'fast');
        args.push('-c:a', 'aac', '-b:a', '192k');
    } else if (outputFormat === 'gif') {
        args.push('-vf', 'fps=15,scale=trunc(iw/2)*2:trunc(ih/2)*2');
        args.push('-c:v', 'gif', '-f', 'gif');
    }
    
    // Force overwrite
    args.push('-y');
    
    // Output
    args.push(outputPath);
    
    return args;
}
```

### 3. Process Execution
```javascript
const { execFile } = require('child_process');

async function clipVideo(inputPath, outputPath, startTime, duration, quality) {
    const ffmpegPath = getFFmpegPath(); // Implement your own path resolution
    const args = buildFFmpegCommand(inputPath, outputFormat, startTime, duration, quality);
    
    return new Promise((resolve, reject) => {
        const proc = execFile(ffmpegPath, args, { 
            cwd: path.dirname(inputPath),
            windowsHide: false
        });
        
        let stderr = '';
        proc.stderr.on('data', (data) => { stderr += data.toString(); });
        
        proc.on('close', (code) => {
            if (code === 0) resolve({ success: true, outputPath });
            else reject(new Error(`FFmpeg failed with code ${code}: ${stderr.substring(0, 200)}`));
        });
        
        proc.on('error', (err) => reject(err));
    });
}
```

### 4. Progress Tracking (Optional)
```javascript
// Parse FFmpeg stderr for progress
proc.stderr.on('data', (data) => {
    const text = data.toString();
    const timeMatch = text.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
    if (timeMatch) {
        const currentTime = timeMatch[1];
        // Send progress update to UI
        onProgress({ currentTime, totalTime: duration });
    }
});
```

---

## 📝 Known Limitations

1. **GIF Export**: No audio support (GIF format limitation)
2. **Large Files**: Clipping very large files (>2GB) may be slow
3. **Seek Accuracy**: FFmpeg's `-ss` parameter has ~1-second accuracy
4. **Real-time Preview**: Preview updates have ~100ms delay for performance
5. **Multiple Clips**: Only one clip can be created at a time (sequential processing)

---

## 🎯 Future Enhancements

- Hardware-accelerated encoding (NVENC, QSV, AMF)
- Parallel clip processing queue
- Custom FFmpeg parameter presets
- Clip batch processing
- Direct upload to cloud storage
- Clip stitching (combine multiple clips)
