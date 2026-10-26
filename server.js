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

const server = app.listen(PORT, () => {
    console.log('\n🎬 Movie Fetcher Server running!');
    console.log(`📂 Open http://localhost:${PORT}/ in your browser`);
    console.log('\nPress Ctrl+C to stop the server\n');
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
