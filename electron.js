const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const updater = require('./updater');

const UPDATE_CHECK_INTERVAL = 30 * 60 * 1000;

// The app was called "DHAKA FLIX Movie Fetcher" before; keep using that data folder so
// My List, resume positions and settings carry over.
app.setPath('userData', path.join(app.getPath('appData'), 'DHAKA FLIX Movie Fetcher'));

let mainWindow;
let updating = false;
let appUrl = null;

// Problems on other people's PCs end up in %APPDATA%\DHAKA FLIX Movie Fetcher\app.log.
function log(text) {
    try {
        fs.appendFileSync(path.join(app.getPath('userData'), 'app.log'), `[${new Date().toISOString()}] v${app.getVersion()} ${text}\n`);
    } catch (e) { /* logging must never break the app */ }
}
process.on('uncaughtException', err => log('Uncaught: ' + (err && err.stack || err)));
process.on('unhandledRejection', err => log('Unhandled: ' + (err && err.stack || err)));

// Only one copy of the app at a time; a second launch just focuses the first.
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    });

    app.whenReady().then(async () => {
        createWindow();
        // The Express server runs inside this process, so Node.js doesn't need to be installed.
        // It uses port 8000, or the next free one if another program has it.
        let serverReady;
        try {
            serverReady = require(path.join(__dirname, 'server.js')).ready;
        } catch (err) {
            serverReady = Promise.reject(err);
        }

        // A newer version must be installed before the app can be used. Without internet the
        // check gives up after a few seconds so the app still opens.
        const update = await Promise.race([updater.check(), new Promise(r => setTimeout(() => r(null), 6000))]);
        if (update) return runUpdate(update);
        let port;
        try {
            port = await serverReady;
        } catch (err) {
            log('Server failed: ' + (err && err.stack || err));
            return showError(`The app's built-in server could not start (${err.message || err}).`);
        }
        // 127.0.0.1 rather than "localhost", which some PCs resolve to IPv6 first.
        appUrl = `http://127.0.0.1:${port}/`;
        if (!updating) mainWindow.loadURL(appUrl);
        setInterval(async () => {
            if (updating) return;
            const later = await updater.check();
            if (later) runUpdate(later);
        }, UPDATE_CHECK_INTERVAL);
    });

    app.on('window-all-closed', () => app.quit());
}

// The splash and update screens are data: pages, so the logo goes in as a data URL.
function logoDataUrl() {
    try {
        return 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, 'assets', 'logo.png')).toString('base64');
    } catch (e) {
        return '';
    }
}

function screen(inner) {
    return 'data:text/html;charset=utf-8,' + encodeURIComponent(`
        <body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
                     background:#0d0f14;color:#eef0f5;font-family:'Segoe UI',sans-serif">
            <div style="text-align:center;max-width:460px;padding:0 20px">
                <img src="${logoDataUrl()}" style="width:300px;filter:drop-shadow(0 0 1px #fff)">
                ${inner}
                <div style="margin-top:26px;font-size:.8rem;color:#8d93a5">by Mostofa Tanim Anik · Senior Software Engineer</div>
            </div>
        </body>`);
}

function showError(message) {
    if (!mainWindow) return;
    mainWindow.loadURL(screen(`
        <h2 style="margin:22px 0 8px">Something went wrong</h2>
        <p style="color:#c9cdd8;line-height:1.5">${String(message).replace(/[<>&]/g, '')}</p>
        <a href="mfupdate://reload" style="${BUTTON};background:#e50914">Try again</a>
        <p style="color:#8d93a5;font-size:.78rem;margin-top:14px">Details are saved in %APPDATA%\\DHAKA FLIX Movie Fetcher\\app.log</p>`));
}

const BUTTON ='display:inline-block;margin:6px;padding:10px 18px;border-radius:8px;color:#fff;text-decoration:none;font-weight:600';

async function runUpdate({ version }) {
    updating = true;
    if (!updater.canSelfUpdate()) {
        // The .exe sits somewhere it can't be replaced (e.g. Program Files): send the user to the download.
        mainWindow.loadURL(screen(`
            <h2 style="margin:22px 0 8px">Update required</h2>
            <p style="color:#c9cdd8;line-height:1.5">Version ${version} is available. Please download it to keep using the app.</p>
            <a href="mfupdate://manual" style="${BUTTON};background:#e50914">Download update</a>`));
        return;
    }
    mainWindow.loadURL(screen(`
        <h2 style="margin:22px 0 6px">Updating to version ${version}…</h2>
        <p style="color:#8d93a5;margin:0 0 16px">The app restarts by itself when it's done.</p>
        <div style="height:8px;background:#2a2f3d;border-radius:8px;overflow:hidden">
            <div id="bar" style="height:100%;width:0;background:#e50914;transition:width .2s"></div>
        </div>
        <div id="pct" style="margin-top:8px;font-size:.85rem;color:#8d93a5">Starting download…</div>`));
    try {
        await updater.install(p => {
            if (!mainWindow) return;
            const pct = Math.round(p * 100);
            mainWindow.webContents.executeJavaScript(
                `document.getElementById('bar').style.width='${pct}%';document.getElementById('pct').textContent='${pct}%'`).catch(() => {});
        });
    } catch (err) {
        if (!mainWindow) return;
        mainWindow.loadURL(screen(`
            <h2 style="margin:22px 0 8px">Update failed</h2>
            <p style="color:#c9cdd8;line-height:1.5">${String(err.message).replace(/[<>&]/g, '')}<br>An update is required to keep using the app.</p>
            <a href="mfupdate://retry" style="${BUTTON};background:#e50914">Try again</a>
            <a href="mfupdate://manual" style="${BUTTON};background:#2a2f3d">Download manually</a>`));
        mainWindow.retryVersion = version;
    }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 720,
        minHeight: 560,
        backgroundColor: '#0d0f14',
        autoHideMenuBar: true,
        title: 'Dipa Cable Network FTP',
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.loadURL(screen(''));

    // Buttons on the update and error screens.
    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith('mfupdate://')) return;
        event.preventDefault();
        if (url.startsWith('mfupdate://retry')) runUpdate({ version: mainWindow.retryVersion });
        else if (url.startsWith('mfupdate://reload')) {
            if (appUrl) {
                mainWindow.loadURL(appUrl);
            } else {
                app.relaunch();
                app.exit(0);
            }
        }
        else shell.openExternal(updater.RELEASES_URL);
    });

    // A crashed or failed page gets a visible message instead of a blank window.
    mainWindow.webContents.on('render-process-gone', (event, details) => {
        log('Page crashed: ' + details.reason);
        if (details.reason !== 'clean-exit') showError('The app window stopped unexpectedly.');
    });
    mainWindow.webContents.on('did-fail-load', (event, code, description, url, isMainFrame) => {
        if (!isMainFrame || url.startsWith('data:')) return;
        log(`Load failed: ${code} ${description} ${url}`);
        showError(`The app page could not load (${description}).`);
    });

    // Downloads, folders and YouTube links open in the normal browser / download manager.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}
