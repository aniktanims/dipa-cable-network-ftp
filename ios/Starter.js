// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: red; icon-glyph: film;

// Movie Fetcher starter: downloads the latest app from your Gist each time and runs it.
// Put your Gist's "Raw" link between the quotes below.
const APP_URL = 'PASTE_YOUR_GIST_RAW_LINK_HERE';

const fm = FileManager.local();
const saved = fm.joinPath(fm.documentsDirectory(), 'movie-fetcher-app.js');

if (!/^https:\/\//.test(APP_URL)) {
    const a = new Alert();
    a.title = 'Movie Fetcher';
    a.message = 'Edit this script and paste your Gist\'s Raw link into APP_URL.';
    a.addAction('OK');
    await a.present();
    Script.complete();
} else {
    // A Raw link copied from GitHub is pinned to one version (…/raw/<long id>/file.js);
    // without that id it always gives the newest version.
    const latest = APP_URL.replace(/\/raw\/[0-9a-f]{40}\//, '/raw/');
    let code = null;
    try {
        const req = new Request(latest + '?t=' + Date.now());
        req.timeoutInterval = 15;
        const text = await req.loadString();
        if (text.includes('Movie Fetcher for iPhone')) {
            code = text;
            fm.writeString(saved, text);
        }
    } catch (e) { /* offline: use the copy from last time */ }
    if (!code && fm.fileExists(saved)) code = fm.readString(saved);
    if (!code) throw new Error('Could not download Movie Fetcher. Check the Gist link and your internet connection.');
    const run = new (Object.getPrototypeOf(async function () {}).constructor)(code);
    await run();
}
