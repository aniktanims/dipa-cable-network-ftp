// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: blue; icon-glyph: tv;

// Dipa Cable Network FTP for iPhone, by Mostofa Tanim Anik.
// Install this small script once in Scriptable. Every time it opens it downloads the latest
// version of the app from GitHub, so updates arrive automatically.
const APP_URL = 'https://github.com/aniktanims/dipa-cable-network-ftp/releases/latest/download/DipaCableNetworkFTP-iPhone.js';

const fm = FileManager.local();
const saved = fm.joinPath(fm.documentsDirectory(), 'dipa-cable-network-ftp-app.js');

let code = null;
try {
    const req = new Request(APP_URL + '?t=' + Date.now());
    req.timeoutInterval = 20;
    const text = await req.loadString();
    if (text.includes('Movie Fetcher for iPhone')) {
        code = text;
        fm.writeString(saved, text);
    }
} catch (e) { /* offline: use the copy from last time */ }
if (!code && fm.fileExists(saved)) code = fm.readString(saved);
if (!code) throw new Error('Could not download Dipa Cable Network FTP. Check your internet connection and try again.');
const run = new (Object.getPrototypeOf(async function () {}).constructor)(code);
await run();
