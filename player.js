// Built-in player backend: FFmpeg turns any DHAKA FLIX file (MKV, HEVC, AC3/EAC3, several audio
// languages, embedded subtitles) into a stream the app's <video> element can play.
const { spawn, spawnSync } = require('child_process');
const http = require('http');

// Inside the packaged app the binary is unpacked next to app.asar.
const FFMPEG = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

const ALLOWED_URL_RE = /^http:\/\/172\.16\.50\.\d{1,3}\//;
const TEXT_SUB_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);
const DIRECT_VIDEO_CODECS = new Set(['h264', 'hevc', 'av1', 'vp9']);

function checkUrl(url) {
    if (!url || !ALLOWED_URL_RE.test(url)) throw new Error('URL not allowed');
    return url;
}

// Prefer the GPU encoder when one works on this PC; it is only needed for burned-in subtitles
// and for formats the app can't decode itself.
let encoder = null;
function videoEncoder() {
    if (encoder) return encoder;
    for (const [name, args] of [
        ['h264_nvenc', ['-preset', 'p4', '-cq', '23', '-b:v', '0']],
        ['h264_qsv', ['-global_quality', '23']],
        ['h264_amf', ['-quality', 'balanced', '-rc', 'cqp', '-qp_i', '22', '-qp_p', '24']]
    ]) {
        const test = spawnSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=24', '-t', '0.5',
            '-pix_fmt', 'yuv420p', '-c:v', name, '-f', 'null', '-'], { timeout: 15000 });
        if (test.status === 0) return (encoder = [name, ...args]);
    }
    return (encoder = ['libx264', '-preset', 'veryfast', '-crf', '21', '-tune', 'film']);
}

const probes = new Map();

// Read stream info (duration, video codec, audio languages, subtitle tracks) from FFmpeg's banner.
function probe(url) {
    checkUrl(url);
    if (probes.has(url)) return probes.get(url);
    const promise = new Promise((resolve, reject) => {
        const proc = spawn(FFMPEG, ['-hide_banner', '-i', url]);
        let err = '';
        proc.stderr.on('data', d => { err += d; });
        proc.on('error', reject);
        proc.on('close', () => {
            const info = parseProbe(err);
            if (!info.video && !info.audio.length) {
                probes.delete(url);
                return reject(new Error((err.trim().split('\n').pop() || 'Could not read the file').trim()));
            }
            resolve(info);
        });
    });
    probes.set(url, promise);
    setTimeout(() => probes.delete(url), 30 * 60 * 1000);
    return promise;
}

function parseProbe(text) {
    const info = { duration: 0, video: null, audio: [], subs: [] };
    const dur = text.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (dur) info.duration = +dur[1] * 3600 + +dur[2] * 60 + parseFloat(dur[3]);

    let current = null;
    for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*Stream #\d+:\d+(?:\[\w+\])?(?:\((\w+)\))?: (Video|Audio|Subtitle): (\w+)(?: \(([^)]*)\))?(.*)$/);
        if (m) {
            const [, lang = '', type, codec, profile = '', rest] = m;
            const flags = { default: /\(default\)/.test(rest), forced: /\(forced\)/.test(rest) };
            current = null;
            if (type === 'Video' && !info.video && !/attached pic/.test(rest)) {
                info.video = current = { codec, profile, tenBit: /10le|p010/.test(rest) };
            } else if (type === 'Audio') {
                const ch = rest.match(/Hz, ([^,]+)/);
                current = { index: info.audio.length, lang, codec, channels: ch ? ch[1] : '', title: '', ...flags };
                info.audio.push(current);
            } else if (type === 'Subtitle') {
                current = { index: info.subs.length, lang, codec, title: '', text: TEXT_SUB_CODECS.has(codec), ...flags };
                info.subs.push(current);
            }
            continue;
        }
        const t = line.match(/^\s+title\s*:\s*(.*)$/);
        if (t && current && 'title' in current && !current.title) current.title = t[1].trim();
        if (/^\S/.test(line)) current = null;
    }
    return info;
}

// GET /api/play?url=&start=&audio=&burn=&transcode=
// Fragmented MP4 that starts at `start` seconds. Video is copied untouched unless subtitles are
// burned in or the app can't decode it; audio is always converted to stereo AAC.
async function play(req, res) {
    let url;
    try { url = checkUrl(req.query.url); } catch (err) { return res.status(400).json({ error: err.message }); }
    const start = Math.max(0, parseFloat(req.query.start) || 0);
    const audio = Math.max(0, parseInt(req.query.audio, 10) || 0);
    const burn = req.query.burn !== undefined && req.query.burn !== '' ? parseInt(req.query.burn, 10) : -1;
    const info = await probe(url).catch(() => null);
    const codec = info && info.video ? info.video.codec : '';
    const transcode = burn >= 0 || req.query.transcode === '1' || (codec && !DIRECT_VIDEO_CODECS.has(codec));

    // Output timestamps start at 0; /api/keyframe tells the player which movie time that is.
    const args = ['-hide_banner', '-v', 'error', '-ss', String(start), '-i', url];
    if (burn >= 0) {
        args.push('-filter_complex', `[0:v:0][0:s:${burn}]overlay,format=yuv420p[v]`, '-map', '[v]');
    } else {
        args.push('-map', '0:v:0?');
        if (transcode) args.push('-vf', 'format=yuv420p');
    }
    args.push('-map', `0:a:${audio}?`);
    if (transcode) args.push('-c:v', ...videoEncoder());
    else args.push('-c:v', 'copy', ...(codec === 'hevc' ? ['-tag:v', 'hvc1'] : []));
    args.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k',
        '-sn', '-dn', '-map_chapters', '-1',
        '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '2000000',
        'pipe:1');

    {
        if (req.socket.destroyed) return;
        const proc = spawn(FFMPEG, args);
        let errText = '';
        proc.stderr.on('data', d => { errText = (errText + d).slice(-2000); });
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' });
        proc.stdout.pipe(res);
        const stop = () => proc.kill('SIGKILL');
        req.on('close', stop);
        proc.on('close', code => {
            if (code && errText && !/Broken pipe|Invalid argument/.test(errText)) console.error('Player:', errText.trim().split('\n').pop());
            res.end();
        });
    }
}

// Text subtitles are pulled out by a background FFmpeg run and handed to the player as they arrive,
// so the first lines show up within a second or two.
const subJobs = new Map();

function parseVttTime(t) {
    const p = t.trim().split(':').map(parseFloat);
    return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
}

function cleanCueText(text) {
    return text
        .replace(/\{\\[^}]*\}/g, '')          // ASS override tags
        .replace(/<(?!\/?[ib]>)[^>]+>/g, '')    // keep only <i> and <b>
        .replace(/\\N/g, '\n')
        .trim();
}

function subJob(url, track) {
    const key = `${url}#${track}`;
    let job = subJobs.get(key);
    if (job) {
        job.touched = Date.now();
        return job;
    }
    job = { cues: [], done: false, error: null, touched: Date.now(), buffer: '' };
    subJobs.set(key, job);
    const proc = spawn(FFMPEG, ['-hide_banner', '-v', 'error', '-i', url, '-map', `0:s:${track}`, '-f', 'webvtt', 'pipe:1']);
    job.proc = proc;
    const flushBlocks = final => {
        const blocks = job.buffer.split(/\r?\n\r?\n/);
        job.buffer = final ? '' : blocks.pop();
        for (const block of blocks) {
            const lines = block.split(/\r?\n/);
            const i = lines.findIndex(l => l.includes('-->'));
            if (i < 0) continue;
            const [a, b] = lines[i].split('-->');
            const text = cleanCueText(lines.slice(i + 1).join('\n'));
            if (text) job.cues.push({ start: parseVttTime(a), end: parseVttTime(b.trim().split(/\s/)[0]), text });
        }
    };
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', d => {
        job.buffer += d;
        flushBlocks(false);
    });
    let errText = '';
    proc.stderr.on('data', d => { errText = (errText + d).slice(-1000); });
    proc.on('close', code => {
        flushBlocks(true);
        job.done = true;
        if (code && !job.cues.length) job.error = errText.trim().split('\n').pop() || 'Could not read subtitles';
    });
    proc.on('error', err => {
        job.done = true;
        job.error = err.message;
    });
    return job;
}

// Drop subtitle jobs nobody has asked about for a while.
setInterval(() => {
    for (const [key, job] of subJobs) {
        if (Date.now() - job.touched > 10 * 60 * 1000) {
            if (!job.done && job.proc) job.proc.kill('SIGKILL');
            subJobs.delete(key);
        }
    }
}, 60 * 1000).unref();

function register(app) {
    app.get('/api/probe', async (req, res) => {
        try {
            res.json(await probe(req.query.url));
        } catch (err) {
            res.status(502).json({ error: err.message });
        }
    });

    app.get('/api/play', play);

    // GET /api/raw?url=  Byte-range pass-through to a DHAKA FLIX file, so the in-browser MKV engine
    // can be used from this page too (the file servers don't allow other sites to read them).
    app.get('/api/raw', (req, res) => {
        let url;
        try { url = checkUrl(req.query.url); } catch (err) { return res.status(400).json({ error: err.message }); }
        const upstream = http.get(url, { headers: req.headers.range ? { Range: req.headers.range } : {} }, up => {
            const headers = {};
            for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
                if (up.headers[h]) headers[h] = up.headers[h];
            }
            res.writeHead(up.statusCode, headers);
            up.pipe(res);
        });
        upstream.on('error', err => { if (!res.headersSent) res.status(502).json({ error: err.message }); else res.end(); });
        req.on('close', () => upstream.destroy());
    });

    // GET /api/keyframe?url=&start=  ->  { time }: where a stream started at `start` really begins
    // (copying video has to start on the keyframe at or before `start`).
    app.get('/api/keyframe', (req, res) => {
        let url;
        try { url = checkUrl(req.query.url); } catch (err) { return res.status(400).json({ error: err.message }); }
        const start = Math.max(0, parseFloat(req.query.start) || 0);
        const proc = spawn(FFMPEG, ['-hide_banner', '-v', 'error', '-ss', String(start), '-i', url, '-copyts',
            '-map', '0:v:0', '-c', 'copy', '-frames:v', '1', '-f', 'framemd5', 'pipe:1']);
        let out = '';
        proc.stdout.on('data', d => { out += d; });
        proc.on('close', () => {
            const tb = out.match(/#tb 0: (\d+)\/(\d+)/);
            const line = out.split('\n').find(l => /^\s*0,/.test(l));
            if (!tb || !line) return res.json({ time: start });
            const pts = parseInt(line.split(',')[2], 10);
            res.json({ time: pts * +tb[1] / +tb[2] });
        });
        req.on('close', () => proc.kill('SIGKILL'));
    });

    // GET /api/subs?url=&track=&from=  ->  { cues: [...new cues since `from`], done }
    // track is the subtitle track inside the video, or omitted for a separate .srt/.ass/.vtt file.
    app.get('/api/subs', (req, res) => {
        try {
            const job = subJob(checkUrl(req.query.url), parseInt(req.query.track, 10) || 0);
            const from = Math.max(0, parseInt(req.query.from, 10) || 0);
            res.json({ cues: job.cues.slice(from), total: job.cues.length, done: job.done, error: job.error });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });
}

module.exports = { register, probe, parseProbe };
