const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const { createCore } = require('./core');
const player = require('./player');

const app = express();
const PORT = 8000;

app.use(cors());
app.use(express.static(__dirname));
app.use(express.static(path.dirname(process.execPath)));

const core = createCore(async (url, body) => {
    const res = await axios.post(url, body, {
        timeout: 30000,
        headers: { 'Content-Type': 'application/json' }
    });
    return res.data;
}, msg => console.log(msg));

function handle(fn) {
    return async (req, res) => {
        try {
            res.json(await fn(req));
        } catch (err) {
            console.error('Error:', err.message);
            const status = err.message === 'Unknown section' ? 404 : err.message === 'Host not allowed' ? 400 : 502;
            res.status(status).json({ error: err.message });
        }
    };
}

app.get('/api/sections', handle(() => core.sections()));
app.get('/api/shelves', handle(req => core.shelves(req.query.section)));
app.get('/api/items', handle(req => core.items({ section: req.query.section, url: req.query.url })));
app.get('/api/folder', handle(req => core.folder(req.query.url)));
player.register(app);
app.get('/api/search', handle(req => core.search(req.query.q, req.query.section)));

// Is one of our own servers already answering on this port (e.g. started with start.bat)?
function isOurServer(port) {
    return new Promise(resolve => {
        const req = require('http').get({ host: '127.0.0.1', port, path: '/api/sections', timeout: 1500 }, res => {
            let body = '';
            res.on('data', d => { body += d; });
            res.on('end', () => resolve(body.includes('"english"')));
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

// Listen on 8000, or the next free port if another program already uses it.
// Resolves to the port the app is reachable on.
const ready = new Promise((resolve, reject) => {
    const tryPort = port => {
        const server = app.listen(port, '127.0.0.1');
        server.once('listening', () => {
            console.log('Dipa Cable Network FTP server running');
            console.log(`Open http://localhost:${port}/ in your browser (Ctrl+C to stop)`);
            resolve(port);
        });
        server.once('error', async err => {
            if (err.code !== 'EADDRINUSE' || port >= PORT + 20) return reject(err);
            if (await isOurServer(port)) {
                console.log(`Port ${port} already has Movie Fetcher running - using it.`);
                return resolve(port);
            }
            tryPort(port + 1);
        });
    };
    tryPort(PORT);
});
ready.catch(err => console.error('Server error:', err.message));

module.exports = { ready };
