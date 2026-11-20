// tests/test_fmp4_headers.js
const http = require('http');
const child_process = require('child_process');
const utils = require('../src/utils');

const ffmpegPath = utils.getFFmpegPath();

// Test server simulating /api/transcode
const server = http.createServer((req, res) => {
    console.log('Received request:', req.method, req.url, 'Headers:', req.headers);

    const args = [
        '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24',
        '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000',
        '-t', '5',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
        '-movflags', 'frag_keyframe+default_base_moof',
        '-f', 'mp4',
        'pipe:1'
    ];

    res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Cache-Control': 'no-store',
        'Connection': 'keep-alive'
    });

    const proc = child_process.spawn(ffmpegPath, args, { windowsHide: true });
    proc.stdout.pipe(res);
    proc.on('close', (code) => {
        console.log('FFmpeg closed with code:', code);
    });
});

server.listen(8799, '127.0.0.1', async () => {
    console.log('Test server running on http://127.0.0.1:8799');

    // Simulate Firefox client requesting first 64KB with Range: bytes=0-
    const req = http.request({
        host: '127.0.0.1',
        port: 8799,
        path: '/video.mp4',
        headers: {
            'Range': 'bytes=0-',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0'
        }
    }, (res) => {
        console.log('Response status:', res.statusCode, 'headers:', res.headers);
        let received = 0;
        let chunks = [];
        res.on('data', (d) => {
            received += d.length;
            chunks.push(d);
            if (received > 20000) {
                const buf = Buffer.concat(chunks);
                console.log('Total bytes received:', buf.length);
                // Check ftyp and moov
                const ftypIdx = buf.indexOf('ftyp');
                const moovIdx = buf.indexOf('moov');
                console.log('ftyp found at:', ftypIdx, 'moov found at:', moovIdx);
                if (moovIdx > 0) {
                    const moovSize = buf.readUInt32BE(moovIdx - 4);
                    console.log('moov atom size:', moovSize, '(Non-empty moov verified!)');
                }
                res.destroy();
                server.close();
                process.exit(0);
            }
        });
    });
    req.end();
});
