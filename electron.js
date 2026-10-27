const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

const APP_URL = 'http://localhost:8000/';

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

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 720,
        minHeight: 560,
        backgroundColor: '#0d0f14',
        autoHideMenuBar: true,
        title: 'DHAKA FLIX Movie Fetcher',
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
        <body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
                     background:#0d0f14;color:#eef0f5;font-family:'Segoe UI',sans-serif">
            <div style="text-align:center">
                <div style="font-size:2.4rem;font-weight:800;letter-spacing:.5px">DHAKA<span style="color:#e50914">FLIX</span></div>
                <div style="margin-top:10px;font-size:.85rem;color:#8d93a5">by Mostofa Tanim Anik · Senior Software Engineer</div>
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
