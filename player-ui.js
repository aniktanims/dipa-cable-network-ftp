// Built-in video player UI. Two engines sit behind the same controls:
//  - 'server': the desktop app's FFmpeg stream (/api/play) - plays everything, burns in image subtitles
//  - 'mse':    the in-browser MKV engine (mkv.js) - used on iPhone, where there is no FFmpeg
(function (root) {
    'use strict';

    const LANGS = {
        en: 'English', eng: 'English', hi: 'Hindi', hin: 'Hindi', bn: 'Bengali', ben: 'Bengali', ta: 'Tamil', tam: 'Tamil',
        te: 'Telugu', tel: 'Telugu', ml: 'Malayalam', mal: 'Malayalam', kn: 'Kannada', kan: 'Kannada', ur: 'Urdu', urd: 'Urdu',
        ko: 'Korean', kor: 'Korean', ja: 'Japanese', jpn: 'Japanese', zh: 'Chinese', chi: 'Chinese', zho: 'Chinese',
        es: 'Spanish', spa: 'Spanish', fr: 'French', fre: 'French', fra: 'French', de: 'German', ger: 'German', deu: 'German',
        it: 'Italian', ita: 'Italian', pt: 'Portuguese', por: 'Portuguese', ru: 'Russian', rus: 'Russian', ar: 'Arabic',
        ara: 'Arabic', tr: 'Turkish', tur: 'Turkish', id: 'Indonesian', ind: 'Indonesian', th: 'Thai', tha: 'Thai',
        nl: 'Dutch', dut: 'Dutch', nld: 'Dutch', da: 'Danish', dan: 'Danish', no: 'Norwegian', nor: 'Norwegian',
        fa: 'Persian', per: 'Persian', fas: 'Persian', und: 'Unknown'
    };
    const langName = code => LANGS[(code || 'und').toLowerCase()] || LANGS[(code || '').slice(0, 2).toLowerCase()] || code.toUpperCase();
    const langKey = code => langName(code).toLowerCase();
    // Release-group tags like "mkvCinemas" or "MoviesMod.build" aren't useful track names.
    const usefulTitle = t => t && !/mkv|movies|\.(com|build|in|org|net)|^[\w.-]+$/i.test(t) ? t : '';
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function fmtTime(s) {
        if (!isFinite(s) || s < 0) s = 0;
        s = Math.floor(s);
        const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
        return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
    }

    // SRT / WebVTT / ASS text -> [{ start, end, text }]
    function parseSubtitleFile(text) {
        text = text.replace(/^﻿/, '').replace(/\r/g, '');
        const cues = [];
        const toSec = t => {
            const p = t.trim().replace(',', '.').split(':').map(parseFloat);
            return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
        };
        if (/^\[Script Info\]/m.test(text)) {
            let format = null;
            for (const line of text.split('\n')) {
                if (/^Format:/i.test(line) && !format) format = line.slice(7).split(',').map(s => s.trim().toLowerCase());
                if (!/^Dialogue:/i.test(line) || !format) continue;
                const parts = line.slice(9).split(',');
                const get = k => parts[format.indexOf(k)];
                const body = parts.slice(format.length - 1).join(',');
                cues.push({ start: toSec(get('start')), end: toSec(get('end')), text: cleanText(body) });
            }
        } else {
            for (const block of text.split(/\n\s*\n/)) {
                const lines = block.split('\n');
                const i = lines.findIndex(l => l.includes('-->'));
                if (i < 0) continue;
                const [a, b] = lines[i].split('-->');
                const body = cleanText(lines.slice(i + 1).join('\n'));
                if (body) cues.push({ start: toSec(a), end: toSec(b.trim().split(/\s/)[0]), text: body });
            }
        }
        return cues.sort((x, y) => x.start - y.start);
    }

    function cleanText(t) {
        return t.replace(/\{\\[^}]*\}/g, '').replace(/\\N/gi, '\n').replace(/<(?!\/?[ib]>)[^>]+>/g, '').replace(/\r/g, '').trim();
    }

    // ---------------- Engines ----------------

    // Desktop: FFmpeg on the app's own server streams fragmented MP4 from any point in the movie.
    // The stream is fed into Media Source Extensions with timestampOffset set to where it really
    // starts, so the video element's clock is the movie time and loaded parts can be revisited instantly.
    class ServerEngine {
        constructor(video, file) {
            this.video = video;
            this.file = file;
            this.audio = 0;
            this.burn = -1;
            this.gen = 0;
        }
        async open() {
            const res = await fetch('/api/probe?url=' + encodeURIComponent(this.file.url));
            const info = await res.json();
            if (!res.ok) throw new Error(info.error || 'Could not open the file');
            this.info = info;
            const v = info.video || {};
            const ok = c => root.MediaSource && MediaSource.isTypeSupported(`video/mp4; codecs="${c}"`);
            this.copyCodec = v.codec === 'hevc' ? (v.tenBit ? 'hvc1.2.4.L120.90' : 'hvc1.1.6.L120.90')
                : v.codec === 'h264' ? 'avc1.640029'
                    : v.codec === 'av1' ? 'av01.0.08M.08'
                        : v.codec === 'vp9' ? 'vp09.00.40.08' : null;
            this.transcode = !this.copyCodec || !ok(this.copyCodec) || (v.codec === 'h264' && /High 10/.test(v.profile || ''));
            return {
                duration: info.duration,
                audio: info.audio.map(a => ({ ...a, supported: true })),
                subs: info.subs.map(s => ({ ...s, canBurn: !s.text }))
            };
        }
        mime() {
            const video = this.burn >= 0 || this.transcode ? 'avc1.640028' : this.copyCodec;
            return `video/mp4; codecs="${video}, mp4a.40.2"`;
        }
        setupSource() {
            if (this.ms) return Promise.resolve();
            return new Promise((resolve, reject) => {
                const ms = this.ms = new MediaSource();
                ms.addEventListener('sourceopen', () => {
                    try {
                        ms.duration = this.info.duration || Infinity;
                        this.sbMime = this.mime();
                        this.sb = ms.addSourceBuffer(this.sbMime);
                        this.sb.mode = 'segments';
                        resolve();
                    } catch (e) { reject(e); }
                }, { once: true });
                this.video.src = URL.createObjectURL(ms);
            });
        }
        idle() {
            const sb = this.sb;
            return sb && sb.updating ? new Promise(r => sb.addEventListener('updateend', r, { once: true })) : Promise.resolve();
        }
        async append(data, gen) {
            for (;;) {
                await this.idle();
                if (gen !== this.gen) return;
                try {
                    this.sb.appendBuffer(data);
                    return;
                } catch (e) {
                    if (e.name !== 'QuotaExceededError') throw e;
                    this.trim(true);
                    await new Promise(r => setTimeout(r, 1000));
                }
            }
        }
        // Drop what's well behind the playhead so memory doesn't run out.
        trim(force) {
            const sb = this.sb, now = this.video.currentTime;
            if (!sb || sb.updating || !sb.buffered.length) return;
            if (now - sb.buffered.start(0) > (force ? 20 : 90)) {
                try { sb.remove(0, now - 20); } catch (e) { /* ignore */ }
            }
        }
        bufferedAhead() {
            const v = this.video, b = v.buffered;
            for (let i = 0; i < b.length; i++) if (b.start(i) <= v.currentTime + 0.5 && b.end(i) >= v.currentTime) return b.end(i) - v.currentTime;
            return 0;
        }

        // Stream from `time` (seconds into the movie) with audio track `audio`.
        async start(time, audio) {
            if (audio !== undefined) this.audio = audio;
            const gen = ++this.gen;
            if (this.abort) this.abort.abort();
            const ctrl = this.abort = new AbortController();
            const exact = this.burn >= 0 || this.transcode;
            const q = `url=${encodeURIComponent(this.file.url)}&start=${time.toFixed(2)}&audio=${this.audio}`
                + (this.burn >= 0 ? `&burn=${this.burn}` : '') + (this.transcode ? '&transcode=1' : '');
            // Copied video starts on the keyframe at or before `time`; find out which one.
            const keyframe = exact ? Promise.resolve(time)
                : fetch(`/api/keyframe?url=${encodeURIComponent(this.file.url)}&start=${time.toFixed(2)}`, { signal: ctrl.signal })
                    .then(r => r.json()).then(r => (isFinite(r.time) ? r.time : time)).catch(() => time);
            try {
                await this.setupSource();
                const [res, startAt] = await Promise.all([fetch('/api/play?' + q, { signal: ctrl.signal }), keyframe]);
                if (gen !== this.gen) return;
                if (!res.ok) throw new Error('The server could not stream this file');
                await this.idle();
                try { this.sb.abort(); } catch (e) { /* nothing to abort */ }
                const mime = this.mime();
                if (mime !== this.sbMime && this.sb.changeType) { this.sb.changeType(mime); this.sbMime = mime; }
                this.sb.timestampOffset = startAt;
                if (Math.abs(this.video.currentTime - time) > 0.25) this.video.currentTime = time;
                this.video.play().catch(() => {});
                const reader = res.body.getReader();
                for (;;) {
                    // Don't run too far ahead; the stream from the server simply waits meanwhile.
                    while (this.bufferedAhead() > 120 && gen === this.gen) {
                        this.trim(false);
                        await new Promise(r => setTimeout(r, 1000));
                    }
                    const { done, value } = await reader.read();
                    if (done || gen !== this.gen) break;
                    await this.append(value, gen);
                }
                if (gen === this.gen) {
                    await this.idle();
                    // Reached the end of the movie: let the video element finish.
                    const b = this.video.buffered;
                    if (b.length && this.info.duration && b.end(b.length - 1) >= this.info.duration - 2 && this.ms.readyState === 'open') {
                        try { this.ms.endOfStream(); } catch (e) { /* ignore */ }
                    }
                }
            } catch (e) {
                if (gen === this.gen && e.name !== 'AbortError' && this.onError) this.onError(e);
            }
        }
        time() { return this.video.currentTime || 0; }
        bufferedEnd() { return this.video.currentTime + this.bufferedAhead(); }
        seek(t) {
            const b = this.video.buffered;
            for (let i = 0; i < b.length; i++) {
                if (t >= b.start(i) && t < b.end(i) - 1) { this.video.currentTime = t; return; }
            }
            this.start(t);
        }
        setAudio(i) {
            this.audio = i;
            this.restartFresh();
        }
        setBurn(i) {
            if (this.burn === i) return;
            this.burn = i;
            this.restartFresh();
        }
        // Audio / subtitle changes: throw away what's loaded and stream again from here.
        async restartFresh() {
            const t = this.time();
            this.gen++;
            if (this.abort) this.abort.abort();
            if (this.sb) {
                await this.idle();
                try { this.sb.abort(); this.sb.remove(0, Infinity); } catch (e) { /* ignore */ }
                await this.idle();
            }
            this.start(t);
        }
        // Text subtitles come from a background FFmpeg run; `onCues` is called as more arrive.
        loadSubs(sel, onCues) {
            const url = sel.type === 'external' ? sel.url : this.file.url;
            const track = sel.type === 'external' ? 0 : sel.index;
            let from = 0, stopped = false, all = [];
            const poll = async () => {
                if (stopped) return;
                try {
                    const r = await (await fetch(`/api/subs?url=${encodeURIComponent(url)}&track=${track}&from=${from}`)).json();
                    if (stopped) return;
                    if (r.error && !all.length) return onCues(null, r.error);
                    if (r.cues && r.cues.length) {
                        all = all.concat(r.cues);
                        from += r.cues.length;
                        onCues(all);
                    }
                    if (!r.done) setTimeout(poll, all.length ? 2000 : 700);
                } catch (e) { setTimeout(poll, 3000); }
            };
            poll();
            return () => { stopped = true; };
        }
        destroy() {
            this.gen++;
            if (this.abort) this.abort.abort();
            this.video.removeAttribute('src');
            this.video.load();
        }
    }

    // iPhone (and anywhere without the server): MKV repackaged in the page. The clock is the movie time.
    class MseEngine {
        constructor(video, file, fetchRange) {
            this.video = video;
            this.file = file;
            this.engine = new root.MFMse.Engine(video, fetchRange);
            this.listeners = [];
        }
        async open() {
            const info = await this.engine.open();
            this.engine.onSubtitles = idx => this.listeners.forEach(l => l(idx));
            return {
                duration: info.duration,
                audio: info.audio,
                subs: info.subs.map(s => ({ ...s, canBurn: false }))
            };
        }
        set onError(fn) { this.engine.onError = fn; }
        start(time, audio) {
            this.engine.start(time, audio);
            this.video.play().catch(() => {});
        }
        time() { return this.video.currentTime || 0; }
        bufferedEnd() {
            const v = this.video, b = v.buffered;
            for (let i = 0; i < b.length; i++) if (b.start(i) <= v.currentTime + 0.5 && b.end(i) >= v.currentTime) return b.end(i);
            return v.currentTime;
        }
        seek(t) { this.video.currentTime = t; }
        setAudio(i) { this.engine.setAudio(i); }
        setBurn() {}
        loadSubs(sel, onCues) {
            if (sel.type === 'embedded') {
                const fn = idx => { if (idx === sel.index) onCues(this.engine.cues(sel.index)); };
                this.listeners.push(fn);
                onCues(this.engine.cues(sel.index));
                return () => { this.listeners = this.listeners.filter(l => l !== fn); };
            }
            let stopped = false;
            fetch(sel.url).then(r => {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.text();
            }).then(text => { if (!stopped) onCues(parseSubtitleFile(text)); })
                .catch(err => { if (!stopped) onCues(null, err.message); });
            return () => { stopped = true; };
        }
        destroy() { this.engine.destroy(); }
    }

    // ---------------- UI ----------------
    const CSS = `
    .pl { position: fixed; inset: 0; z-index: 500; background: #000; color: #fff; display: none; user-select: none; -webkit-user-select: none;
          font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; }
    .pl.open { display: block; }
    .pl [hidden] { display: none !important; }
    .pl video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; background: #000; }
    .pl.hide-ui { cursor: none; }
    .pl-subs { position: absolute; left: 5%; right: 5%; bottom: 9%; text-align: center; pointer-events: none; transition: bottom .25s; z-index: 2; }
    .pl:not(.hide-ui) .pl-subs { bottom: calc(9% + 70px); }
    .pl-subs span { display: inline; background: rgba(0,0,0,.62); padding: .1em .35em; border-radius: 4px; line-height: 1.45;
          white-space: pre-line; box-decoration-break: clone; -webkit-box-decoration-break: clone;
          text-shadow: 0 1px 2px #000; font-weight: 500; }
    .pl[data-subsize="s"] .pl-subs { font-size: clamp(14px, 2.2vw, 26px); }
    .pl[data-subsize="m"] .pl-subs { font-size: clamp(16px, 2.9vw, 34px); }
    .pl[data-subsize="l"] .pl-subs { font-size: clamp(19px, 3.8vw, 46px); }
    .pl-top, .pl-bottom { position: absolute; left: 0; right: 0; z-index: 3; transition: opacity .25s; }
    .pl-top { top: 0; padding: calc(env(safe-area-inset-top) + 14px) 20px 40px; display: flex; align-items: center; gap: 14px;
          background: linear-gradient(rgba(0,0,0,.75), transparent); }
    .pl-bottom { bottom: 0; padding: 40px 20px calc(env(safe-area-inset-bottom) + 12px); background: linear-gradient(transparent, rgba(0,0,0,.85)); }
    .pl.hide-ui .pl-top, .pl.hide-ui .pl-bottom { opacity: 0; pointer-events: none; }
    .pl-title { min-width: 0; }
    .pl-title b { display: block; font-size: 1.1rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pl-title span { display: block; font-size: .78rem; opacity: .7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pl button { background: none; border: none; color: #fff; cursor: pointer; font: inherit; }
    .pl-ib { width: 42px; height: 42px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; flex: none; }
    .pl-ib:hover { background: rgba(255,255,255,.14); }
    .pl-ib svg { width: 24px; height: 24px; fill: currentColor; }
    .pl-ib.on { color: #e50914; }
    .pl-seek { position: relative; height: 22px; cursor: pointer; touch-action: none; }
    .pl-seek .bar { position: absolute; left: 0; right: 0; top: 9px; height: 4px; background: rgba(255,255,255,.25); border-radius: 4px; transition: height .15s, top .15s; }
    .pl-seek:hover .bar, .pl-seek.drag .bar { height: 6px; top: 8px; }
    .pl-seek .buf, .pl-seek .prog { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 4px; }
    .pl-seek .buf { background: rgba(255,255,255,.35); }
    .pl-seek .prog { background: #e50914; }
    .pl-seek .thumb { position: absolute; top: 4px; width: 14px; height: 14px; margin-left: -7px; border-radius: 50%; background: #e50914; transform: scale(0); transition: transform .15s; }
    .pl-seek:hover .thumb, .pl-seek.drag .thumb { transform: scale(1); }
    .pl-seek .tip { position: absolute; bottom: 24px; transform: translateX(-50%); background: rgba(20,20,20,.92); padding: 3px 8px; border-radius: 5px; font-size: .8rem; display: none; white-space: nowrap; }
    .pl-seek:hover .tip, .pl-seek.drag .tip { display: block; }
    .pl-row { display: flex; align-items: center; gap: 4px; margin-top: 4px; }
    .pl-time { font-size: .88rem; margin-left: 8px; font-variant-numeric: tabular-nums; white-space: nowrap; opacity: .9; }
    .pl-spacer { flex: 1; }
    .pl-vol { display: flex; align-items: center; }
    .pl-vol input { width: 0; opacity: 0; transition: width .2s, opacity .2s; accent-color: #e50914; }
    .pl-vol:hover input, .pl-vol input:focus { width: 80px; opacity: 1; }
    .pl-center { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; z-index: 2; }
    .pl-spin { width: 54px; height: 54px; border: 4px solid rgba(255,255,255,.2); border-top-color: #e50914; border-radius: 50%; animation: plspin 1s linear infinite; display: none; }
    .pl.loading .pl-spin { display: block; }
    @keyframes plspin { to { transform: rotate(360deg); } }
    .pl-flash { position: absolute; width: 74px; height: 74px; border-radius: 50%; background: rgba(0,0,0,.5); display: flex; align-items: center; justify-content: center; font-size: 1.05rem; font-weight: 700; opacity: 0; transition: opacity .3s; }
    .pl-flash.show { opacity: 1; transition: none; }
    .pl-menu { position: absolute; right: 16px; bottom: calc(env(safe-area-inset-bottom) + 84px); z-index: 4; min-width: 260px; max-width: calc(100vw - 32px);
          max-height: 60vh; overflow-y: auto; background: rgba(22,24,32,.97); border: 1px solid rgba(255,255,255,.12); border-radius: 12px; padding: 6px; display: none;
          box-shadow: 0 12px 40px rgba(0,0,0,.6); }
    .pl-menu.open { display: block; }
    .pl-menu h4 { font-size: .72rem; text-transform: uppercase; letter-spacing: 1px; opacity: .55; padding: 10px 12px 4px; }
    .pl-menu button.item { display: flex; width: 100%; text-align: left; gap: 10px; padding: 10px 12px; border-radius: 8px; font-size: .9rem; align-items: baseline; }
    .pl-menu button.item:hover { background: rgba(255,255,255,.08); }
    .pl-menu button.item[disabled] { opacity: .4; cursor: default; }
    .pl-menu .check { width: 16px; flex: none; color: #e50914; }
    .pl-menu small { opacity: .55; margin-left: auto; padding-left: 10px; white-space: nowrap; }
    .pl-menu .seg { display: flex; gap: 6px; padding: 6px 12px 10px; flex-wrap: wrap; }
    .pl-menu .seg button { padding: 6px 12px; border-radius: 999px; border: 1px solid rgba(255,255,255,.2); font-size: .82rem; }
    .pl-menu .seg button.on { background: #e50914; border-color: #e50914; }
    .pl-msg { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 5; background: rgba(20,22,30,.96);
          border: 1px solid rgba(255,255,255,.12); border-radius: 14px; padding: 22px 24px; max-width: min(460px, 90vw); text-align: center; display: none; }
    .pl-msg.open { display: block; }
    .pl-msg p { opacity: .8; margin: 8px 0 16px; line-height: 1.5; font-size: .92rem; }
    .pl-msg .btns { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }
    .pl-msg .btns button { padding: 9px 16px; border-radius: 8px; background: rgba(255,255,255,.12); font-weight: 600; }
    .pl-msg .btns button.primary { background: #e50914; }
    .pl-note { position: absolute; left: 50%; top: calc(env(safe-area-inset-top) + 76px); transform: translateX(-50%); z-index: 4; background: rgba(20,22,30,.94);
          padding: 9px 16px; border-radius: 999px; font-size: .88rem; display: none; align-items: center; gap: 12px; white-space: nowrap; }
    .pl-note.open { display: flex; }
    .pl-note button { color: #e50914; font-weight: 700; }
    @media (max-width: 640px) {
        .pl-hide-sm { display: none !important; }
        .pl-bottom { padding-left: 10px; padding-right: 10px; }
        .pl-ib { width: 38px; height: 38px; }
        .pl-time { font-size: .78rem; margin-left: 2px; }
    }`;

    const ICONS = {
        play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
        pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
        back: '<svg viewBox="0 0 24 24"><path d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z"/></svg>',
        rew: '<svg viewBox="0 0 24 24"><path d="M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/><text x="12" y="16.5" font-size="7" text-anchor="middle" font-family="sans-serif" font-weight="700">10</text></svg>',
        fwd: '<svg viewBox="0 0 24 24"><path d="M12 5V1l5 5-5 5V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z"/><text x="12" y="16.5" font-size="7" text-anchor="middle" font-family="sans-serif" font-weight="700">10</text></svg>',
        next: '<svg viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zm10-12v12h2V6h-2z"/></svg>',
        vol: '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>',
        mute: '<svg viewBox="0 0 24 24"><path d="M16.5 12A4.5 4.5 0 0 0 14 8v2.2l2.5 2.5V12zm2.5 0a7 7 0 0 1-.6 2.8l1.5 1.5A9 9 0 0 0 14 3.2v2.1a7 7 0 0 1 5 6.7zM4.3 3 3 4.3 7.7 9H3v6h4l5 5v-6.7l4.3 4.3a7 7 0 0 1-2.3 1.2v2.1a9 9 0 0 0 3.7-1.8l2 2 1.3-1.3L4.3 3zM12 4 9.9 6.1 12 8.2V4z"/></svg>',
        audio: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 0 0-9 9v7a2 2 0 0 0 2 2h3v-8H5v-1a7 7 0 0 1 14 0v1h-3v8h3a2 2 0 0 0 2-2v-7a9 9 0 0 0-9-9z"/></svg>',
        cc: '<svg viewBox="0 0 24 24"><path d="M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1z"/></svg>',
        gear: '<svg viewBox="0 0 24 24"><path d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3.3h-4l-.4 2.6a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.7 1.7 1l.4 2.6h4l.4-2.6c.6-.3 1.2-.6 1.7-1l2.5 1 2-3.5L19.4 13zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" transform="translate(-1 0)"/></svg>',
        full: '<svg viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>',
        unfull: '<svg viewBox="0 0 24 24"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>'
    };

    class Player {
        constructor(opts) {
            this.opts = opts;
            this.store = opts.store;
            this.prefs = Object.assign({ audioLang: '', subLang: '', subSize: 'm', volume: 1, muted: false }, this.store.get('mf:player', {}));
            this.build();
        }

        build() {
            if (!document.getElementById('pl-style')) {
                const st = document.createElement('style');
                st.id = 'pl-style';
                st.textContent = CSS;
                document.head.appendChild(st);
            }
            const el = this.el = document.createElement('div');
            el.className = 'pl';
            el.dataset.subsize = this.prefs.subSize;
            el.innerHTML = `
                <video playsinline webkit-playsinline preload="auto"></video>
                <div class="pl-subs"></div>
                <div class="pl-center"><div class="pl-spin"></div><div class="pl-flash"></div></div>
                <div class="pl-top">
                    <button class="pl-ib" data-a="close" title="Close (Esc)">${ICONS.back}</button>
                    <div class="pl-title"><b></b><span></span></div>
                </div>
                <div class="pl-bottom">
                    <div class="pl-seek"><div class="bar"><div class="buf"></div><div class="prog"></div></div><div class="thumb"></div><div class="tip"></div></div>
                    <div class="pl-row">
                        <button class="pl-ib" data-a="play" title="Play / pause (Space)">${ICONS.play}</button>
                        <button class="pl-ib" data-a="rew" title="Back 10 s (←)">${ICONS.rew}</button>
                        <button class="pl-ib" data-a="fwd" title="Forward 10 s (→)">${ICONS.fwd}</button>
                        <button class="pl-ib" data-a="next" title="Next episode (N)" hidden>${ICONS.next}</button>
                        <div class="pl-vol pl-hide-sm">
                            <button class="pl-ib" data-a="mute" title="Mute (M)">${ICONS.vol}</button>
                            <input type="range" min="0" max="1" step="0.05" aria-label="Volume">
                        </div>
                        <span class="pl-time">0:00 / 0:00</span>
                        <span class="pl-spacer"></span>
                        <button class="pl-ib" data-a="audio" title="Audio language (A)">${ICONS.audio}</button>
                        <button class="pl-ib" data-a="subs" title="Subtitles (C)">${ICONS.cc}</button>
                        <button class="pl-ib" data-a="settings" title="Settings">${ICONS.gear}</button>
                        <button class="pl-ib" data-a="full" title="Full screen (F)">${ICONS.full}</button>
                    </div>
                </div>
                <div class="pl-menu"></div>
                <div class="pl-note"></div>
                <div class="pl-msg"></div>`;
            document.body.appendChild(el);
            const $ = s => el.querySelector(s);
            this.video = $('video');
            this.subsEl = $('.pl-subs');
            this.menuEl = $('.pl-menu');
            this.msgEl = $('.pl-msg');
            this.noteEl = $('.pl-note');
            this.seekEl = $('.pl-seek');
            this.timeEl = $('.pl-time');
            this.volEl = $('.pl-vol input');
            this.flashEl = $('.pl-flash');

            el.addEventListener('click', e => this.onClick(e));
            el.addEventListener('pointermove', e => { if (e.pointerType === 'mouse') this.poke(); });
            el.addEventListener('touchstart', e => this.onTouch(e), { passive: true });
            this.keyHandler = e => this.onKey(e);
            this.volEl.addEventListener('input', () => this.setVolume(+this.volEl.value));
            this.bindSeek();

            const v = this.video;
            v.addEventListener('waiting', () => el.classList.add('loading'));
            v.addEventListener('playing', () => { el.classList.remove('loading'); this.poke(); });
            v.addEventListener('canplay', () => el.classList.remove('loading'));
            v.addEventListener('play', () => this.updatePlay());
            v.addEventListener('pause', () => { this.updatePlay(); this.showUi(); });
            v.addEventListener('ended', () => this.onEnded());
            v.addEventListener('error', () => {
                if (!this.engine || !v.getAttribute('src')) return;
                this.fail(v.error && v.error.code === 4 ? 'This video format can\'t be played here.' : 'Playback stopped (network or format problem).');
            });
            document.addEventListener('fullscreenchange', () => this.updateFull());
            document.addEventListener('webkitfullscreenchange', () => this.updateFull());
        }

        // playlist: [{ name, url }], index: which one to start, subFiles: [{ name, url }] in the same folder
        async open({ title, playlist, index = 0, subFiles = [] }) {
            this.title = title;
            this.playlist = playlist;
            this.subFiles = subFiles;
            this.el.classList.add('open');
            document.addEventListener('keydown', this.keyHandler, true);
            document.documentElement.style.overflow = 'hidden';
            this.setVolume(this.prefs.muted ? 0 : this.prefs.volume, true);
            this.raf = requestAnimationFrame(() => this.tick());
            await this.load(index);
        }

        async load(index, startAt) {
            this.teardownEngine();
            this.index = index;
            const file = this.file = this.playlist[index];
            this.el.querySelector('.pl-title b').textContent = this.title;
            this.el.querySelector('.pl-title span').textContent = this.playlist.length > 1 || file.name !== this.title ? file.name : '';
            this.el.querySelector('[data-a="next"]').hidden = index + 1 >= this.playlist.length;
            this.el.classList.add('loading');
            this.closeMenu();
            this.msg(null);
            this.note(null);
            this.cues = [];
            this.subSel = null;
            this.subsEl.innerHTML = '';
            this.duration = 0;

            const engine = this.engine = this.opts.engine === 'mse'
                ? new MseEngine(this.video, file, this.opts.fetchRange(file.url))
                : new ServerEngine(this.video, file);
            engine.onError = err => this.fail(err.message);
            let info;
            try {
                info = await engine.open();
            } catch (err) {
                if (engine === this.engine) this.fail(err.message);
                return;
            }
            if (engine !== this.engine) return;
            this.info = info;
            this.duration = info.duration || 0;

            const playable = info.audio.filter(a => a.supported !== false);
            let audio = playable.find(a => this.prefs.audioLang && langKey(a.lang) === this.prefs.audioLang)
                || playable.find(a => a.default) || playable[0];
            this.audioIndex = audio ? audio.index : 0;
            if (info.audio.length && !playable.length) {
                this.note('This device can\'t play this file\'s audio (' + info.audio.map(a => a.codec).join(', ') + ')');
            }

            const resume = startAt !== undefined ? null : this.resumePoint(file.url);
            const start = startAt !== undefined ? startAt : resume || 0;
            engine.start(start, this.audioIndex);
            if (resume) this.note(`Resumed at ${fmtTime(resume)}`, 'Start over', () => this.seek(0));

            // Subtitles: the preferred language if one was chosen before, else forced/none.
            if (this.prefs.subLang && this.prefs.subLang !== 'off') {
                const embedded = info.subs.find(s => s.text && langKey(s.lang) === this.prefs.subLang && !s.forced)
                    || info.subs.find(s => s.text && langKey(s.lang) === this.prefs.subLang);
                if (embedded) this.selectSub({ type: 'embedded', index: embedded.index }, false);
                else if (this.subFiles.length) this.selectSub({ type: 'external', url: this.subFiles[0].url, name: this.subFiles[0].name }, false);
            }
        }

        resumePoint(url) {
            const r = this.store.get('mf:resume', {})[url];
            if (!r || !r.t) return 0;
            const d = r.d || this.duration;
            return r.t > 30 && (!d || r.t < d - 120) ? r.t : 0;
        }

        saveResume(final) {
            if (!this.file || !this.engine) return;
            const t = this.engine.time();
            if (!final && Date.now() - (this.lastSave || 0) < 5000) return;
            this.lastSave = Date.now();
            const all = this.store.get('mf:resume', {});
            if (t > 30) all[this.file.url] = { t: Math.round(t), d: Math.round(this.duration), at: Date.now() };
            const keys = Object.keys(all);
            if (keys.length > 300) keys.sort((a, b) => all[a].at - all[b].at).slice(0, keys.length - 300).forEach(k => delete all[k]);
            this.store.set('mf:resume', all);
        }

        savePrefs() { this.store.set('mf:player', this.prefs); }

        teardownEngine() {
            if (this.stopSubs) this.stopSubs();
            this.stopSubs = null;
            if (this.engine) {
                this.saveResume(true);
                this.engine.destroy();
            }
            this.engine = null;
        }

        close() {
            this.teardownEngine();
            cancelAnimationFrame(this.raf);
            this.el.classList.remove('open', 'hide-ui');
            document.removeEventListener('keydown', this.keyHandler, true);
            document.documentElement.style.overflow = '';
            if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
            if (this.opts.onClose) this.opts.onClose();
        }

        // ---------------- Playback ----------------
        toggle() {
            const v = this.video;
            if (v.paused) v.play().catch(() => {});
            else v.pause();
            this.flash(v.paused ? ICONS.pause : ICONS.play);
        }

        seek(t) {
            if (!this.engine) return;
            const d = this.duration || Infinity;
            t = Math.max(0, Math.min(d - 1, t));
            this.engine.seek(t);
            this.updateTime(t);
            this.renderSubs(t);
        }

        skip(sec) {
            if (!this.engine) return;
            this.seek(this.engine.time() + sec);
            this.flash(`${sec > 0 ? '+' : ''}${sec}s`);
        }

        setVolume(v, quiet) {
            v = Math.max(0, Math.min(1, v));
            this.video.volume = v;
            this.video.muted = v === 0;
            this.volEl.value = v;
            this.el.querySelector('[data-a="mute"]').innerHTML = v === 0 ? ICONS.mute : ICONS.vol;
            if (v > 0) this.prefs.volume = v;
            this.prefs.muted = v === 0;
            this.savePrefs();
            if (!quiet) this.flash(Math.round(v * 100) + '%');
        }

        next() {
            if (this.index + 1 < this.playlist.length) this.load(this.index + 1, 0);
        }

        onEnded() {
            if (!this.file) return;
            const all = this.store.get('mf:resume', {});
            delete all[this.file.url];
            this.store.set('mf:resume', all);
            if (this.index + 1 < this.playlist.length) {
                this.note('Playing next episode…');
                setTimeout(() => this.next(), 1500);
            } else {
                this.showUi();
            }
        }

        setAudio(i) {
            const a = this.info.audio[i];
            if (!a || a.supported === false) return;
            this.audioIndex = i;
            this.prefs.audioLang = langKey(a.lang);
            this.savePrefs();
            this.engine.setAudio(i);
            this.note('Audio: ' + langName(a.lang));
        }

        // sel: null (off) | { type: 'embedded', index } | { type: 'external', url, name } | { type: 'burn', index }
        selectSub(sel, remember = true) {
            if (this.stopSubs) this.stopSubs();
            this.stopSubs = null;
            this.cues = [];
            this.subsEl.innerHTML = '';
            this.subSel = sel;
            const burnIndex = sel && sel.type === 'burn' ? sel.index : -1;
            this.engine.setBurn(burnIndex);
            if (remember) {
                const lang = sel && sel.type !== 'external' ? this.info.subs[sel.index].lang : sel ? 'external' : 'off';
                this.prefs.subLang = sel ? (lang === 'external' ? this.prefs.subLang || 'english' : langKey(lang)) : 'off';
                this.savePrefs();
            }
            if (!sel || sel.type === 'burn') return;
            this.stopSubs = this.engine.loadSubs(sel, (cues, err) => {
                if (err) return this.note('Subtitles: ' + err);
                this.cues = cues || [];
                this.cueIdx = 0;
            });
        }

        // ---------------- Rendering ----------------
        tick() {
            if (this.engine) {
                const t = this.engine.time();
                if (!this.dragging) this.updateTime(t);
                this.renderSubs(t);
                this.saveResume(false);
            }
            this.raf = requestAnimationFrame(() => this.tick());
        }

        updateTime(t) {
            const d = this.duration;
            const pct = d ? Math.min(100, (t / d) * 100) : 0;
            const buf = d && this.engine ? Math.min(100, (this.engine.bufferedEnd() / d) * 100) : 0;
            this.seekEl.querySelector('.prog').style.width = pct + '%';
            this.seekEl.querySelector('.buf').style.width = buf + '%';
            this.seekEl.querySelector('.thumb').style.left = pct + '%';
            const text = `${fmtTime(t)} / ${fmtTime(d)}`;
            if (this.timeEl.textContent !== text) this.timeEl.textContent = text;
        }

        renderSubs(t) {
            t -= (this.prefs.subDelay || 0);
            const cues = this.cues;
            let html = '';
            if (cues && cues.length) {
                const on = [];
                // Cues are sorted by start; find the ones covering t.
                let lo = 0, hi = cues.length - 1, first = cues.length;
                while (lo <= hi) {
                    const mid = (lo + hi) >> 1;
                    if (cues[mid].start > t) { first = mid; hi = mid - 1; } else lo = mid + 1;
                }
                for (let i = first - 1; i >= 0 && i >= first - 8; i--) if (cues[i].end > t) on.unshift(cues[i]);
                html = on.map(c => '<span>' + esc(c.text).replace(/&lt;(\/?[ib])&gt;/g, '<$1>') + '</span>').join('<br>');
            }
            if (html !== this.subHtml) {
                this.subHtml = html;
                this.subsEl.innerHTML = html;
            }
        }

        updatePlay() {
            this.el.querySelector('[data-a="play"]').innerHTML = this.video.paused ? ICONS.play : ICONS.pause;
        }

        updateFull() {
            const fs = !!(document.fullscreenElement || document.webkitFullscreenElement);
            this.el.querySelector('[data-a="full"]').innerHTML = fs ? ICONS.unfull : ICONS.full;
        }

        flash(content) {
            const f = this.flashEl;
            f.innerHTML = content;
            f.classList.add('show');
            clearTimeout(this.flashTimer);
            this.flashTimer = setTimeout(() => f.classList.remove('show'), 450);
        }

        note(text, actionLabel, action) {
            const n = this.noteEl;
            clearTimeout(this.noteTimer);
            if (!text) { n.classList.remove('open'); return; }
            n.innerHTML = esc(text) + (actionLabel ? ` <button>${esc(actionLabel)}</button>` : '');
            if (action) n.querySelector('button').onclick = e => { e.stopPropagation(); n.classList.remove('open'); action(); };
            n.classList.add('open');
            this.noteTimer = setTimeout(() => n.classList.remove('open'), actionLabel ? 8000 : 2500);
        }

        msg(html) {
            this.msgEl.innerHTML = html || '';
            this.msgEl.classList.toggle('open', !!html);
        }

        fail(text) {
            this.el.classList.remove('loading');
            const fallback = this.opts.fallback ? '<button class="primary" data-a="fallback">Open in VLC</button>' : '';
            this.msg(`<b>Can't play this video</b><p>${esc(text)}</p><div class="btns">${fallback}<button data-a="retry">Try again</button><button data-a="close">Close</button></div>`);
        }

        showUi() {
            this.el.classList.remove('hide-ui');
            clearTimeout(this.hideTimer);
        }

        poke() {
            this.showUi();
            this.hideTimer = setTimeout(() => {
                if (!this.video.paused && !this.menuEl.classList.contains('open') && !this.dragging) this.el.classList.add('hide-ui');
            }, 3000);
        }

        // ---------------- Menus ----------------
        openMenu(kind) {
            if (this.menuKind === kind && this.menuEl.classList.contains('open')) return this.closeMenu();
            this.menuKind = kind;
            const info = this.info || { audio: [], subs: [] };
            const check = on => `<span class="check">${on ? '✓' : ''}</span>`;
            let html = '';
            if (kind === 'audio') {
                html = '<h4>Audio</h4>' + (info.audio.length ? info.audio.map(a => {
                    const title = usefulTitle(a.title);
                    const detail = [String(a.codec || '').toUpperCase(), a.channels].filter(Boolean).join(' ');
                    return `<button class="item" data-audio="${a.index}" ${a.supported === false ? 'disabled' : ''}>${check(a.index === this.audioIndex)}
                        <span>${esc(langName(a.lang))}${title ? ' – ' + esc(title) : ''}</span><small>${esc(a.supported === false ? (a.reason || 'not supported') : detail)}</small></button>`;
                }).join('') : '<button class="item" disabled><span class="check"></span>No audio tracks</button>');
            } else if (kind === 'subs') {
                const sel = this.subSel;
                html = '<h4>Subtitles</h4>' + `<button class="item" data-sub="off">${check(!sel)}<span>Off</span></button>`;
                html += info.subs.map(s => {
                    const title = usefulTitle(s.title);
                    const label = esc(langName(s.lang)) + (s.forced ? ' (forced)' : '') + (title ? ' – ' + esc(title) : '');
                    if (s.text) {
                        const on = sel && sel.type === 'embedded' && sel.index === s.index;
                        return `<button class="item" data-sub="e${s.index}">${check(on)}<span>${label}</span><small>${esc(String(s.codec).toUpperCase())}</small></button>`;
                    }
                    const on = sel && sel.type === 'burn' && sel.index === s.index;
                    return `<button class="item" data-sub="b${s.index}" ${s.canBurn ? '' : 'disabled'}>${check(on)}<span>${label}</span><small>${s.canBurn ? 'image · burned in' : 'image · not supported here'}</small></button>`;
                }).join('');
                if (this.subFiles.length) {
                    html += '<h4>Subtitle files</h4>' + this.subFiles.map((f, i) => {
                        const on = sel && sel.type === 'external' && sel.url === f.url;
                        return `<button class="item" data-sub="x${i}">${check(on)}<span>${esc(f.name)}</span></button>`;
                    }).join('');
                }
                const size = this.prefs.subSize;
                html += `<h4>Size</h4><div class="seg">${['s', 'm', 'l'].map(k => `<button data-subsize="${k}" class="${size === k ? 'on' : ''}">${{ s: 'Small', m: 'Medium', l: 'Large' }[k]}</button>`).join('')}</div>`;
                const delay = this.prefs.subDelay || 0;
                html += `<h4>Timing</h4><div class="seg"><button data-delay="-0.5">−0.5 s</button><button data-delay="0">${delay ? (delay > 0 ? '+' : '') + delay.toFixed(1) + ' s' : 'In sync'}</button><button data-delay="0.5">+0.5 s</button></div>`;
            } else if (kind === 'settings') {
                const rate = this.video.playbackRate;
                html = `<h4>Speed</h4><div class="seg">${[0.5, 0.75, 1, 1.25, 1.5, 2].map(r => `<button data-rate="${r}" class="${rate === r ? 'on' : ''}">${r === 1 ? 'Normal' : r + '×'}</button>`).join('')}</div>`;
                html += `<h4>Shortcuts</h4><div style="padding:4px 12px 10px;font-size:.82rem;opacity:.7;line-height:1.7">Space play/pause · ←/→ 10 s · ↑/↓ volume<br>F full screen · M mute · A audio · C subtitles · N next</div>`;
            }
            this.menuEl.innerHTML = html;
            this.menuEl.classList.add('open');
            this.showUi();
        }

        closeMenu() {
            this.menuEl.classList.remove('open');
            this.menuKind = null;
        }

        onMenuClick(t) {
            if (t.dataset.audio !== undefined) {
                this.setAudio(+t.dataset.audio);
                return this.closeMenu();
            }
            if (t.dataset.sub !== undefined) {
                const v = t.dataset.sub;
                if (v === 'off') this.selectSub(null);
                else if (v[0] === 'e') this.selectSub({ type: 'embedded', index: +v.slice(1) });
                else if (v[0] === 'b') this.selectSub({ type: 'burn', index: +v.slice(1) });
                else if (v[0] === 'x') {
                    const f = this.subFiles[+v.slice(1)];
                    this.selectSub({ type: 'external', url: f.url, name: f.name });
                }
                return this.closeMenu();
            }
            if (t.dataset.subsize) {
                this.prefs.subSize = this.el.dataset.subsize = t.dataset.subsize;
                this.savePrefs();
                this.menuKind = null;
                return this.openMenu('subs');
            }
            if (t.dataset.delay !== undefined) {
                const d = +t.dataset.delay;
                this.prefs.subDelay = d === 0 ? 0 : Math.round(((this.prefs.subDelay || 0) + d) * 10) / 10;
                this.savePrefs();
                this.menuKind = null;
                return this.openMenu('subs');
            }
            if (t.dataset.rate) {
                this.video.playbackRate = +t.dataset.rate;
                this.menuKind = null;
                return this.openMenu('settings');
            }
        }

        cycleAudio() {
            const list = (this.info ? this.info.audio : []).filter(a => a.supported !== false);
            if (list.length < 2) return this.note('Only one audio track');
            const i = list.findIndex(a => a.index === this.audioIndex);
            this.setAudio(list[(i + 1) % list.length].index);
        }

        cycleSubs() {
            const opts = [null];
            (this.info ? this.info.subs : []).forEach(s => {
                if (s.text) opts.push({ type: 'embedded', index: s.index });
                else if (s.canBurn) opts.push({ type: 'burn', index: s.index });
            });
            this.subFiles.forEach(f => opts.push({ type: 'external', url: f.url, name: f.name }));
            if (opts.length < 2) return this.note('No subtitles for this video');
            const same = (a, b) => (!a && !b) || (a && b && a.type === b.type && a.index === b.index && a.url === b.url);
            const i = opts.findIndex(o => same(o, this.subSel));
            const next = opts[(i + 1) % opts.length];
            this.selectSub(next);
            this.note('Subtitles: ' + (!next ? 'Off' : next.type === 'external' ? next.name : langName(this.info.subs[next.index].lang)));
        }

        // ---------------- Input ----------------
        onClick(e) {
            const t = e.target.closest('button, [data-a]');
            if (t && this.menuEl.contains(t)) return this.onMenuClick(t);
            const a = t && t.dataset.a;
            if (!a) {
                // Clicking the picture: close a menu, else play/pause (mouse only; touch toggles the controls).
                if (this.menuEl.classList.contains('open')) return this.closeMenu();
                if (e.target === this.video || e.target.closest('.pl-center') || e.target === this.subsEl) {
                    if (this.lastTouch && Date.now() - this.lastTouch < 600) return;
                    this.toggle();
                }
                return;
            }
            e.stopPropagation();
            switch (a) {
                case 'close': return this.close();
                case 'play': return this.toggle();
                case 'rew': return this.skip(-10);
                case 'fwd': return this.skip(10);
                case 'next': return this.next();
                case 'mute': return this.setVolume(this.video.volume > 0 && !this.video.muted ? 0 : this.prefs.volume || 1);
                case 'audio': case 'subs': case 'settings': return this.openMenu(a);
                case 'full': return this.toggleFull();
                case 'retry': return this.load(this.index, this.engine ? this.engine.time() : undefined);
                case 'fallback': return this.opts.fallback(this.file);
            }
        }

        onTouch(e) {
            if (e.target.closest('.pl-bottom, .pl-top, .pl-menu, .pl-msg')) return;
            this.lastTouch = Date.now();
            const x = e.touches[0].clientX, w = window.innerWidth;
            const now = Date.now();
            // Double tap on the left / right third skips 10 s.
            if (this.lastTap && now - this.lastTap.at < 300 && Math.abs(this.lastTap.x - x) < 60 && (x < w / 3 || x > w * 2 / 3)) {
                this.skip(x < w / 3 ? -10 : 10);
                this.lastTap = null;
                return;
            }
            this.lastTap = { at: now, x };
            if (this.menuEl.classList.contains('open')) return this.closeMenu();
            if (this.el.classList.contains('hide-ui')) this.poke();
            else if (!this.video.paused) this.el.classList.add('hide-ui');
        }

        onKey(e) {
            if (!this.el.classList.contains('open')) return;
            if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName) && e.target.type !== 'range') return;
            const k = e.key;
            const handled = () => { e.preventDefault(); e.stopImmediatePropagation(); this.poke(); };
            switch (k) {
                case ' ': case 'k': case 'K': handled(); return this.toggle();
                case 'ArrowLeft': case 'j': case 'J': handled(); return this.skip(-10);
                case 'ArrowRight': case 'l': case 'L': handled(); return this.skip(10);
                case 'ArrowUp': handled(); return this.setVolume((this.video.muted ? 0 : this.video.volume) + 0.05);
                case 'ArrowDown': handled(); return this.setVolume(this.video.volume - 0.05);
                case 'm': case 'M': handled(); return this.setVolume(this.video.volume > 0 && !this.video.muted ? 0 : this.prefs.volume || 1);
                case 'f': case 'F': handled(); return this.toggleFull();
                case 'a': case 'A': handled(); return this.cycleAudio();
                case 'c': case 'C': handled(); return this.cycleSubs();
                case 'n': case 'N': handled(); return this.next();
                case 'Escape':
                    handled();
                    if (this.menuEl.classList.contains('open')) return this.closeMenu();
                    if (document.fullscreenElement) return;   // the browser leaves full screen itself
                    return this.close();
            }
            if (/^[0-9]$/.test(k) && this.duration) { handled(); this.seek(this.duration * (+k / 10)); }
        }

        bindSeek() {
            const s = this.seekEl, tip = s.querySelector('.tip');
            const at = x => {
                const r = s.getBoundingClientRect();
                return Math.max(0, Math.min(1, (x - r.left) / r.width));
            };
            s.addEventListener('pointermove', e => {
                const p = at(e.clientX);
                tip.style.left = (p * 100) + '%';
                tip.textContent = fmtTime(p * this.duration);
                if (this.dragging) this.updateTime(p * this.duration);
            });
            s.addEventListener('pointerdown', e => {
                if (!this.duration) return;
                this.dragging = true;
                s.classList.add('drag');
                s.setPointerCapture(e.pointerId);
                this.updateTime(at(e.clientX) * this.duration);
            });
            const end = e => {
                if (!this.dragging) return;
                this.dragging = false;
                s.classList.remove('drag');
                this.seek(at(e.clientX) * this.duration);
            };
            s.addEventListener('pointerup', end);
            s.addEventListener('pointercancel', () => { this.dragging = false; s.classList.remove('drag'); });
        }

        toggleFull() {
            const el = this.el, v = this.video;
            if (document.fullscreenElement || document.webkitFullscreenElement) {
                (document.exitFullscreen || document.webkitExitFullscreen).call(document);
            } else if (el.requestFullscreen) {
                el.requestFullscreen().catch(() => {});
            } else if (el.webkitRequestFullscreen) {
                el.webkitRequestFullscreen();
            } else if (v.webkitEnterFullscreen) {
                // iPhone: only the video itself can go full screen (the app's subtitles stay outside it).
                v.webkitEnterFullscreen();
            }
        }
    }

    let instance = null;
    root.MFPlayer = {
        // opts: { engine: 'server' | 'mse', store, fetchRange?(url), fallback?(file), onClose? }
        open(opts, media) {
            if (!instance) instance = new Player(opts);
            instance.opts = opts;
            return instance.open(media);
        },
        get current() { return instance; },
        parseSubtitleFile
    };
})(typeof self !== 'undefined' ? self : this);
