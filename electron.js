const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_URL = 'http://localhost:8000/';

// The app was called "DHAKA FLIX Movie Fetcher" before; keep using that data folder so
// My List, resume positions and settings carry over.
app.setPath('userData', path.join(app.getPath('appData'), 'DHAKA FLIX Movie Fetcher'));

let mainWindow;

// Only one copy of the app at a time; a second launch just focuses the first.
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    });

    app.whenReady().then(() => {
        // The Express server runs inside this process, so Node.js doesn't need to be installed.
        const server = require(path.join(__dirname, 'server.js'));
        createWindow();
        if (server.listening) {
            mainWindow.loadURL(APP_URL);
        } else {
            server.once('listening', () => mainWindow.loadURL(APP_URL));
            // Port already taken means another copy of the server is running; use it.
            server.once('error', () => mainWindow.loadURL(APP_URL));
        }
    });

    app.on('window-all-closed', () => app.quit());
}

// The splash screen is a data: page, so the logo goes in as a data URL.
function logoDataUrl() {
    try {
        return 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, 'assets', 'logo.png')).toString('base64');
    } catch (e) {
        return '';
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

    mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
        <body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
                     background:#0d0f14;color:#eef0f5;font-family:'Segoe UI',sans-serif">
            <div style="text-align:center">
                <img src="${logoDataUrl()}" style="width:320px;filter:drop-shadow(0 0 1px #fff)">
                <div style="margin-top:14px;font-size:.85rem;color:#8d93a5">by Mostofa Tanim Anik · Senior Software Engineer</div>
            </div>
        </body>`));

    // Downloads, folders and YouTube links open in the normal browser / download manager.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}
