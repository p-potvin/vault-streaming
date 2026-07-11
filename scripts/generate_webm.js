const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const util = require('util');
const execFilePromise = util.promisify(execFile);

// Target Directory input via Command Line Argument
const targetPathArg = process.argv[2];
if (!targetPathArg) {
    console.log(`
Vault Explorer - PowerShell Directory Preview Generator
======================================================
Usage:
  node scripts/generate_webm.js "<directory_path>"

Example:
  node scripts/generate_webm.js "C:\\Users\\Administrator\\Videos"
  
Running with default directory: "${process.cwd()}"
`);
}

const TARGET_DIR = targetPathArg ? path.resolve(targetPathArg) : process.cwd();
const VIDEO_EXTS = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.wmv'];

function findVideosSync(dir) {
    let results = [];
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name !== '.thumbs' && entry.name !== '.git' && !entry.name.endsWith('.trickplay')) {
                    results.push(...findVideosSync(fullPath));
                }
            } else {
                const ext = path.extname(entry.name).toLowerCase();
                if (VIDEO_EXTS.includes(ext)) {
                    results.push(fullPath);
                }
            }
        }
    } catch (e) {
        console.error(`Error reading directory: ${dir}`, e.message);
    }
    return results;
}

async function getVideoDuration(videoPath) {
    try {
        const { stdout } = await execFilePromise('ffprobe', [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            videoPath
        ]);
        const dur = parseFloat(stdout.trim());
        return isNaN(dur) ? 0 : dur;
    } catch (e) {
        return 0;
    }
}

async function start() {
    if (!fs.existsSync(TARGET_DIR)) {
        console.error(`Error: Target directory "${TARGET_DIR}" does not exist.`);
        process.exit(1);
    }

    console.log(`Scanning "${TARGET_DIR}" recursively for video files...`);
    const videos = findVideosSync(TARGET_DIR);
    console.log(`Found ${videos.length} videos. Commencing preview generation...\n`);

	let erroredFilenames = [];
    let count = 0;
    for (const vidPath of videos) {
        const dir = path.dirname(vidPath);
        const ext = path.extname(vidPath);
        const baseName = path.basename(vidPath, ext);
        
        // Ensure local .thumbs folder at the exact folder level of the video
        const thumbsDir = path.join(dir, '.thumbs');
        if (!fs.existsSync(thumbsDir)) {
            try {
                fs.mkdirSync(thumbsDir, { recursive: true });
            } catch (e) {
                console.error(`Failed to create thumbs folder: ${thumbsDir}`, e.message);
                continue;
            }
        }

        const outThumbPath = path.join(thumbsDir, `${baseName}.jpg`);
        const outWebmPath = path.join(thumbsDir, `${baseName}.webm`);

        const isThumbExists = fs.existsSync(outThumbPath);
        const isWebmExists = fs.existsSync(outWebmPath);

        if (isThumbExists && isWebmExists) {
            console.log(`[${++count}/${videos.length}] Skipping (already exists): ${baseName}`);
            continue;
        }

        console.log(`[${++count}/${videos.length}] Processing: ${path.basename(vidPath)}`);

        // Get video duration to pick representative keyframes
        const duration = await getVideoDuration(vidPath);

        // 1. Generate Keyframe Thumbnail (.jpg)
        if (!isThumbExists) {
            const middleTime = duration > 0 ? (duration / 2).toFixed(2) : '5.00';
            try {
                await execFilePromise('ffmpeg', [
                    '-y',
                    '-ss', middleTime,
                    '-i', vidPath,
                    '-vf', "select='eq(pict_type,I)'",
                    '-vframes', '1',
                    '-q:v', '2',
                    outThumbPath,
                    '-loglevel', 'error'
                ]);
                console.log(`  -> Created thumbnail: ${baseName}.jpg`);
            } catch (err) {
				erroredFilenames.push(vidPath);
                console.error(`  -> Failed to create thumbnail: ${err.message}`);
            }
        }

        // 2. Generate Concatenated WebM Preview
        if (!isWebmExists) {
            try {
                if (duration <= 30) {
                    // Small video, generate quick 1-take preview
                    await execFilePromise('ffmpeg', [
                        '-y',
                        '-i', vidPath,
                        '-c:v', 'libvpx',
                        '-b:v', '800k',
                        '-speed', '4',
                        '-an',
                        outWebmPath,
                        '-loglevel', 'error'
                    ]);
                } else {
                    // Larger video: extract 5 pieces of 2 seconds each
                    const numClips = 5;
                    const interval = duration / numClips;
                    const clipDuration = 2.0;

                    const args = ['-y'];
                    let filterStr = '';
                    for (let i = 0; i < numClips; i++) {
                        const seekTime = interval * i;
                        args.push('-ss', seekTime.toFixed(2), '-t', clipDuration.toFixed(2), '-i', vidPath);
                        filterStr += `[${i}:v]`;
                    }
                    filterStr += `concat=n=${numClips}:v=1:a=0[outv]`;
                    
                    args.push(
                        '-filter_complex', filterStr,
                        '-map', '[outv]',
                        '-c:v', 'libvpx',
                        '-b:v', '800k',
                        '-speed', '4',
                        '-an',
                        outWebmPath,
                        '-loglevel', 'error'
                    );

                    await execFilePromise('ffmpeg', args);
                }
                console.log(`  -> Created WebM preview: ${baseName}.webm`);
            } catch (err) {
				if (erroredFilenames.at(-1) != vidPath) erroredFilenames.push(vidPath);
                console.error(`  -> Failed to create WebM preview: ${err.message}`);
            }
        }
    }

	if (erroredFilenames.length > 0) {
		console.log(`\nAll the following files have failed, usually due to a corrupted stream: `);
		let i = 0;
		erroredFilenames.forEach((filename) => {
			console.log(`\n#${i}: ${filename}`);
			++i;
		});
	}
	
    console.log(`\nAll previews fully synchronized inside the directory structures!`);
}

start();
