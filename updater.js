// Forced self-update for the portable Windows app.
// The newest GitHub release is checked on start (and every 30 minutes); if it is newer, the app
// downloads it, swaps its own .exe for the new one and restarts. Nothing else runs meanwhile.
const { app, net } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = 'aniktanims/dipa-cable-network-ftp';
const ASSET = 'DipaCableNetworkFTP-Portable.exe';
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;

// The portable .exe the user launched (electron-builder sets this); unset when running from source.
const exePath = () => process.env.PORTABLE_EXECUTABLE_FILE || null;

function isNewer(remote, local) {
    const a = remote.split('.').map(n => parseInt(n, 10) || 0);
    const b = local.split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
        if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
    }
    return false;
}

async function fetchWithTimeout(url, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
        return await net.fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    } finally {
        clearTimeout(timer);
    }
}

// Returns { version } when a newer release exists, null when up to date or GitHub can't be reached.
async function check() {
    if (!exePath()) return null;
    try {
        // …/releases/latest redirects to …/releases/tag/vX.Y.Z (no API rate limits this way).
        const res = await fetchWithTimeout(RELEASES_URL, 10000);
        const m = res.url.match(/\/releases\/tag\/v?(\d+\.\d+\.\d+)/);
        if (!m) return null;
        return isNewer(m[1], app.getVersion()) ? { version: m[1] } : null;
    } catch (e) {
        return null;
    }
}

// Download the new .exe next to the current one, then hand over to a small script that replaces
// the file once this app has exited and starts the new version.
async function install(onProgress) {
    const exe = exePath();
    const temp = exe + '.update';
    const res = await net.fetch(`${RELEASES_URL}/download/${ASSET}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
    const total = parseInt(res.headers.get('content-length'), 10) || 0;
    const out = fs.createWriteStream(temp);
    const reader = res.body.getReader();
    let done = 0;
    try {
        for (;;) {
            const { done: finished, value } = await reader.read();
            if (finished) break;
            if (!out.write(Buffer.from(value))) await new Promise(r => out.once('drain', r));
            done += value.length;
            if (total) onProgress(done / total);
        }
    } finally {
        await new Promise(r => out.end(r));
    }
    const head = Buffer.alloc(2);
    const fd = fs.openSync(temp, 'r');
    fs.readSync(fd, head, 0, 2, 0);
    fs.closeSync(fd);
    if (head.toString() !== 'MZ' || (total && done !== total)) {
        fs.rmSync(temp, { force: true });
        throw new Error('The downloaded update is incomplete');
    }

    // The .exe stays locked until this app (and the portable launcher) have exited, so keep retrying.
    const script = path.join(os.tmpdir(), `dipa-ftp-update-${Date.now()}.cmd`);
    fs.writeFileSync(script, [
        '@echo off',
        'set n=0',
        ':retry',
        `move /y "${temp}" "${exe}" >nul 2>&1 && goto done`,
        'set /a n+=1',
        'if %n% gtr 90 goto end',
        'timeout /t 1 /nobreak >nul',
        'goto retry',
        ':done',
        `start "" "${exe}"`,
        ':end',
        'del "%~f0"'
    ].join('\r\n'));
    spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    app.exit(0);
}

// Can we replace the .exe where it lives? (Not, for example, inside Program Files.)
function canSelfUpdate() {
    const exe = exePath();
    if (!exe) return false;
    try {
        const probe = path.join(path.dirname(exe), `.write-test-${process.pid}`);
        fs.writeFileSync(probe, '');
        fs.rmSync(probe);
        return true;
    } catch (e) {
        return false;
    }
}

module.exports = { check, install, canSelfUpdate, isNewer, RELEASES_URL };
