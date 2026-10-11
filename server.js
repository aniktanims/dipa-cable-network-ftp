const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = 8000;

app.use(cors());
app.use(express.static(__dirname));
app.use(express.static(path.dirname(process.execPath)));

// Every browsable section on the DHAKA FLIX servers.
// nested: the section's direct sub-folders are "shelves" (years, languages, A-Z ranges)
// and the titles live one level deeper. Otherwise the titles are the direct sub-folders.
const SECTIONS = [
    { id: 'english', name: 'English', group: 'Movies', host: '172.16.50.7', path: '/DHAKA-FLIX-7/English Movies/', nested: true },
    { id: 'english1080', name: 'English 1080p', group: 'Movies', host: '172.16.50.14', path: '/DHAKA-FLIX-14/English Movies (1080p)/', nested: true },
    { id: 'hindi', name: 'Hindi', group: 'Movies', host: '172.16.50.14', path: '/DHAKA-FLIX-14/Hindi Movies/', nested: true },
    { id: 'south', name: 'South Indian', group: 'Movies', host: '172.16.50.14', path: '/DHAKA-FLIX-14/SOUTH INDIAN MOVIES/South Movies/', nested: true },
    { id: 'southdub', name: 'South Hindi Dubbed', group: 'Movies', host: '172.16.50.14', path: '/DHAKA-FLIX-14/SOUTH INDIAN MOVIES/Hindi Dubbed/', nested: true },
    { id: 'animation', name: 'Animation', group: 'Movies', host: '172.16.50.14', path: '/DHAKA-FLIX-14/Animation Movies/', nested: true },
    { id: 'animation1080', name: 'Animation 1080p', group: 'Movies', host: '172.16.50.14', path: '/DHAKA-FLIX-14/Animation Movies (1080p)/', nested: false },
    { id: 'kolkata', name: 'Kolkata Bangla', group: 'Movies', host: '172.16.50.7', path: '/DHAKA-FLIX-7/Kolkata Bangla Movies/', nested: true },
    { id: 'foreign', name: 'Foreign Language', group: 'Movies', host: '172.16.50.7', path: '/DHAKA-FLIX-7/Foreign Language Movies/', nested: true },
    { id: 'imdb250', name: 'IMDb Top 250', group: 'Movies', host: '172.16.50.14', path: '/DHAKA-FLIX-14/IMDb Top-250 Movies/', nested: false },
    { id: '3d', name: '3D Movies', group: 'Movies', host: '172.16.50.7', path: '/DHAKA-FLIX-7/3D Movies/', nested: false },
    { id: 'tv', name: 'TV & Web Series', group: 'Series', host: '172.16.50.12', path: '/DHAKA-FLIX-12/TV-WEB-Series/', nested: true, tv: true },
    { id: 'korean-tv', name: 'Korean Series', group: 'Series', host: '172.16.50.14', path: '/DHAKA-FLIX-14/KOREAN TV & WEB Series/', nested: false, tv: true },
    { id: 'anime', name: 'Anime & Cartoon', group: 'Series', host: '172.16.50.10', path: '/DHAKA-FLIX-10/Anime & Cartoon TV Series/', nested: true, tv: true },
    { id: 'documentary', name: 'Documentary', group: 'Series', host: '172.16.50.10', path: '/DHAKA-FLIX-10/Documentary/', nested: false },
];

const VIDEO_RE = /\.(mp4|mkv|avi|mov|m4v|webm|wmv|flv|ts)$/i;
const IMAGE_RE = /\.(jpe?g|png|webp|gif)$/i;
const SUB_RE = /\.(srt|ass|sub|vtt)$/i;
const ALLOWED_HOST_RE = /^172\.16\.50\.\d{1,3}$/;
const CACHE_TTL = 10 * 60 * 1000;

const cache = new Map();

function cached(key, ttl, fn) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.promise;
    const promise = fn().catch(err => {
        cache.delete(key);
        throw err;
    });
    cache.set(key, { at: Date.now(), promise });
    return promise;
}

// Normalise a path into the encoding h5ai uses for hrefs (it also escapes ' ( ) and friends).
function encodePath(p) {
    return p.split('/')
        .map(seg => encodeURIComponent(decodeURIComponent(seg))
            .replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()))
        .join('/');
}

function parseFolderUrl(raw) {
    const u = new URL(raw);
    if (!ALLOWED_HOST_RE.test(u.hostname)) throw new Error('Host not allowed');
    let href = encodePath(u.pathname);
    if (!href.endsWith('/')) href += '/';
    return { host: u.hostname, href };
}

// Ask h5ai for a folder listing. what=1 lists the folder, what=2 also lists each sub-folder.
async function h5aiList(host, href, what) {
    return cached(`${host}${href}#${what}`, CACHE_TTL, async () => {
        const res = await axios.post(`http://${host}${href}`, {
            action: 'get',
            items: { href, what }
        }, {
            timeout: 30000,
            headers: { 'Content-Type': 'application/json' }
        });
        if (!res.data || !Array.isArray(res.data.items)) throw new Error('Unexpected response from server');
        // h5ai also returns the parent chain; keep only entries below the requested folder.
        return res.data.items.filter(i => i.href.startsWith(href) && i.href !== href);
    });
}

const nameOf = href => decodeURIComponent(href.replace(/\/$/, '').split('/').pop());

// Group a what=2 listing into one entry per direct sub-folder (poster, videos, size)
// plus one entry per loose video file.
function groupItems(host, href, items) {
    const folders = new Map();
    const loose = [];
    for (const item of items) {
        const rest = item.href.slice(href.length);
        const parts = rest.split('/').filter(Boolean);
        const isDir = item.href.endsWith('/');
        if (parts.length === 1) {
            if (isDir) {
                folders.set(parts[0], {
                    name: nameOf(item.href),
                    url: `http://${host}${item.href}`,
                    time: item.time || 0,
                    poster: null,
                    backdrop: null,
                    videos: [],
                    size: 0,
                    subfolders: 0
                });
            } else if (VIDEO_RE.test(item.href)) {
                loose.push({
                    name: nameOf(item.href),
                    url: `http://${host}${item.href}`,
                    time: item.time || 0,
                    poster: null,
                    videos: [{ name: nameOf(item.href), url: `http://${host}${item.href}`, size: item.size || 0 }],
                    size: item.size || 0,
                    subfolders: 0,
                    isFile: true
                });
            }
        }
    }
    for (const item of items) {
        const rest = item.href.slice(href.length);
        const parts = rest.split('/').filter(Boolean);
        if (parts.length !== 2) continue;
        const folder = folders.get(parts[0]);
        if (!folder) continue;
        const url = `http://${host}${item.href}`;
        if (item.href.endsWith('/')) {
            folder.subfolders++;
        } else if (VIDEO_RE.test(item.href)) {
            folder.videos.push({ name: nameOf(item.href), url, size: item.size || 0 });
            folder.size += item.size || 0;
        } else if (IMAGE_RE.test(item.href)) {
            // a_AL_.jpg is the portrait poster, a_VL_.jpg the wide backdrop.
            if (/_VL_\./i.test(item.href)) folder.backdrop = url;
            else if (!folder.poster || /_AL_\./i.test(item.href)) folder.poster = url;
        }
    }
    return [...folders.values(), ...loose];
}

function yearKey(name) {
    const m = name.match(/(19|20)\d{2}/g);
    return m ? parseInt(m[m.length - 1], 10) : -1;
}

function sendError(res, err) {
    console.error('Error:', err.message);
    res.status(err.message === 'Host not allowed' ? 400 : 502).json({ error: err.message });
}

app.get('/api/sections', (req, res) => {
    res.json(SECTIONS.map(({ id, name, group, nested, tv }) => ({ id, name, group, nested: !!nested, tv: !!tv })));
});

// Shelves of a nested section (years, languages, ...), newest year first.
app.get('/api/shelves', async (req, res) => {
    const section = SECTIONS.find(s => s.id === req.query.section);
    if (!section) return res.status(404).json({ error: 'Unknown section' });
    try {
        const href = encodePath(section.path);
        const items = await h5aiList(section.host, href, 1);
        const shelves = items
            .filter(i => i.href.endsWith('/'))
            .map(i => ({ name: nameOf(i.href), url: `http://${section.host}${i.href}`, time: i.time || 0, year: yearKey(nameOf(i.href)) }));
        const hasYears = shelves.filter(s => s.year > 0).length > shelves.length / 2;
        if (hasYears) {
            // Year folders newest first; collections like "DC Extended Universe (2008-2019)" go last.
            const isYearShelf = s => /^\(?\d{4}(-\d{4})?\)?( 1080p)?( & Before)?$/i.test(s.name);
            shelves.sort((a, b) => isYearShelf(b) - isYearShelf(a) || b.year - a.year || a.name.localeCompare(b.name));
        }
        res.json({ shelves, hasYears });
    } catch (err) {
        sendError(res, err);
    }
});

// All titles inside a folder (a shelf, or a whole flat section), with posters and video files.
app.get('/api/items', async (req, res) => {
    try {
        let host, href;
        if (req.query.section) {
            const section = SECTIONS.find(s => s.id === req.query.section);
            if (!section) return res.status(404).json({ error: 'Unknown section' });
            host = section.host;
            href = encodePath(section.path);
        } else {
            ({ host, href } = parseFolderUrl(req.query.url));
        }
        const items = await h5aiList(host, href, 2);
        const grouped = groupItems(host, href, items);
        console.log(`Listed ${grouped.length} titles in ${decodeURIComponent(href)}`);
        res.json(grouped);
    } catch (err) {
        sendError(res, err);
    }
});

// Raw contents of a single folder, for the file browser in the details view.
app.get('/api/folder', async (req, res) => {
    try {
        const { host, href } = parseFolderUrl(req.query.url);
        const items = await h5aiList(host, href, 1);
        const entries = items
            .filter(i => !i.href.slice(href.length, -1).includes('/'))
            .map(i => {
                const isDir = i.href.endsWith('/');
                const name = nameOf(i.href);
                return {
                    name,
                    url: `http://${host}${i.href}`,
                    size: i.size || 0,
                    time: i.time || 0,
                    type: isDir ? 'folder' : VIDEO_RE.test(name) ? 'video' : IMAGE_RE.test(name) ? 'image' : SUB_RE.test(name) ? 'subtitle' : 'file'
                };
            })
            .sort((a, b) => (b.type === 'folder') - (a.type === 'folder') || a.name.localeCompare(b.name, undefined, { numeric: true }));
        const images = entries.filter(e => e.type === 'image');
        const poster = images.find(e => /_AL_\./i.test(e.name)) || images.find(e => !/_VL_\./i.test(e.name));
        const backdrop = images.find(e => /_VL_\./i.test(e.name));
        res.json({ entries, poster: poster ? poster.url : null, backdrop: backdrop ? backdrop.url : null });
    } catch (err) {
        sendError(res, err);
    }
});

// Title index of a whole section (every year/shelf), used for "search everywhere".
async function sectionIndex(section) {
    return cached(`index:${section.id}`, 30 * 60 * 1000, async () => {
        const href = encodePath(section.path);
        const items = await h5aiList(section.host, href, 2);
        const depth = section.nested ? 2 : 1;
        return items
            .filter(i => i.href.endsWith('/') && i.href.slice(href.length).split('/').filter(Boolean).length === depth)
            .map(i => ({
                name: nameOf(i.href),
                url: `http://${section.host}${i.href}`,
                time: i.time || 0,
                section: section.id,
                shelf: section.nested ? decodeURIComponent(i.href.slice(href.length).split('/')[0]) : null
            }));
    });
}

const normalise = s => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();

app.get('/api/search', async (req, res) => {
    const q = normalise(String(req.query.q || ''));
    if (q.length < 2) return res.json({ results: [], failed: [] });
    const terms = q.split(' ');
    const targets = req.query.section && req.query.section !== 'all'
        ? SECTIONS.filter(s => s.id === req.query.section)
        : SECTIONS;
    const failed = [];
    const lists = await Promise.all(targets.map(s => sectionIndex(s).catch(err => {
        console.error(`Search index failed for ${s.name}:`, err.message);
        failed.push(s.name);
        return [];
    })));
    const results = lists.flat().filter(item => {
        const n = normalise(item.name);
        return terms.every(t => n.includes(t));
    });
    results.sort((a, b) => yearKey(b.name) - yearKey(a.name));
    res.json({ results: results.slice(0, 200), total: results.length, failed });
});

const server = app.listen(PORT, () => {
    console.log('\n🎬 Movie Fetcher Server running!');
    console.log(`📂 Open http://localhost:${PORT}/ in your browser`);
    console.log('\nPress Ctrl+C to stop the server\n');

    if (process.pkg) {
        const { exec } = require('child_process');
        setTimeout(() => exec(`start http://localhost:${PORT}/`), 1000);
    }
});

server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
        // Another copy is already serving the app on this port; reuse it.
        console.log(`Port ${PORT} already in use - using the running server.`);
    } else {
        console.error('Server error:', err.message);
    }
});

module.exports = server;
