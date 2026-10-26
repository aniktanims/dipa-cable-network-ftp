// In-browser MKV player engine (used on iPhone, where there is no FFmpeg).
// Reads the MKV over HTTP range requests, repackages the video and the chosen audio track as
// fragmented MP4 and feeds them to the browser through Media Source Extensions. Nothing is
// re-encoded, so the device must be able to decode the codecs itself (iPhone: H.264/HEVC,
// AAC/AC3/EAC3). Text subtitles are read straight from the file.
(function (root) {
    'use strict';

    // ---------------- EBML ----------------
    const ID = {
        EBML: 0x1A45DFA3, Segment: 0x18538067, SeekHead: 0x114D9B74, Seek: 0x4DBB, SeekID: 0x53AB, SeekPosition: 0x53AC,
        Info: 0x1549A966, TimecodeScale: 0x2AD7B1, Duration: 0x4489,
        Tracks: 0x1654AE6B, TrackEntry: 0xAE, TrackNumber: 0xD7, TrackType: 0x83, CodecID: 0x86, CodecPrivate: 0x63A2,
        Language: 0x22B59C, LanguageIETF: 0x22B59D, Name: 0x536E, FlagDefault: 0x88, FlagForced: 0x55AA, FlagEnabled: 0xB9,
        DefaultDuration: 0x23E383, Video: 0xE0, PixelWidth: 0xB0, PixelHeight: 0xBA,
        Audio: 0xE1, SamplingFrequency: 0xB5, OutputSamplingFrequency: 0x78B5, Channels: 0x9F,
        ContentEncodings: 0x6D80, ContentEncoding: 0x6240, ContentCompression: 0x5034, ContentCompAlgo: 0x4254, ContentCompSettings: 0x4255,
        Cues: 0x1C53BB6B, CuePoint: 0xBB, CueTime: 0xB3, CueTrackPositions: 0xB7, CueTrack: 0xF7, CueClusterPosition: 0xF1,
        Cluster: 0x1F43B675, Timecode: 0xE7, SimpleBlock: 0xA3, BlockGroup: 0xA0, Block: 0xA1, BlockDuration: 0x9B, ReferenceBlock: 0xFB
    };
    const MASTER = new Set([ID.Segment, ID.SeekHead, ID.Seek, ID.Info, ID.Tracks, ID.TrackEntry, ID.Video, ID.Audio,
        ID.ContentEncodings, ID.ContentEncoding, ID.ContentCompression, ID.Cues, ID.CuePoint, ID.CueTrackPositions,
        ID.Cluster, ID.BlockGroup]);

    // Element ID: the length marker stays part of the value. Returns null if the bytes aren't there yet.
    function readId(b, p) {
        if (p >= b.length) return null;
        const first = b[p];
        const len = first >= 0x80 ? 1 : first >= 0x40 ? 2 : first >= 0x20 ? 3 : first >= 0x10 ? 4 : 0;
        if (!len) throw new Error('Bad element id');
        if (p + len > b.length) return null;
        let v = 0;
        for (let i = 0; i < len; i++) v = v * 256 + b[p + i];
        return { value: v, length: len };
    }

    // Size / number: the marker bit is removed; all ones means "unknown size" (-1).
    function readVint(b, p) {
        if (p >= b.length) return null;
        const first = b[p];
        let len = 1, mask = 0x80;
        while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
        if (len > 8) throw new Error('Bad size');
        if (p + len > b.length) return null;
        let v = first & (mask - 1), allOnes = v === mask - 1;
        for (let i = 1; i < len; i++) {
            v = v * 256 + b[p + i];
            if (b[p + i] !== 0xFF) allOnes = false;
        }
        return { value: allOnes ? -1 : v, length: len };
    }

    function readHeader(b, p) {
        const id = readId(b, p);
        if (!id) return null;
        const size = readVint(b, p + id.length);
        if (!size) return null;
        return { id: id.value, size: size.value, headerLength: id.length + size.length, dataStart: p + id.length + size.length };
    }

    function readUint(b, p, n) { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + b[p + i]; return v; }
    function readFloat(b, p, n) {
        const dv = new DataView(b.buffer, b.byteOffset + p, n);
        return n === 4 ? dv.getFloat32(0) : n === 8 ? dv.getFloat64(0) : 0;
    }
    const utf8 = new TextDecoder('utf-8');
    function readString(b, p, n) { return utf8.decode(b.subarray(p, p + n)).replace(/\0+$/, ''); }

    // Walk the children of a fully loaded master element.
    function children(b, start, end, fn) {
        let p = start;
        while (p < end) {
            const h = readHeader(b, p);
            if (!h) break;
            const dataEnd = h.size < 0 ? end : Math.min(end, h.dataStart + h.size);
            fn(h.id, h.dataStart, dataEnd - h.dataStart);
            p = dataEnd;
        }
    }

    function concat(a, b) {
        if (!a || !a.length) return b;
        const out = new Uint8Array(a.length + b.length);
        out.set(a, 0);
        out.set(b, a.length);
        return out;
    }

    // ---------------- Bit reader (codec headers) ----------------
    class Bits {
        constructor(b, p = 0) { this.b = b; this.bit = p * 8; }
        read(n) {
            let v = 0;
            for (let i = 0; i < n; i++) {
                const byte = this.b[this.bit >> 3] || 0;
                v = v * 2 + ((byte >> (7 - (this.bit & 7))) & 1);
                this.bit++;
            }
            return v;
        }
    }
    class BitWriter {
        constructor() { this.bits = []; }
        write(v, n) { for (let i = n - 1; i >= 0; i--) this.bits.push((v >> i) & 1); }
        bytes() {
            const out = new Uint8Array(Math.ceil(this.bits.length / 8));
            this.bits.forEach((bit, i) => { if (bit) out[i >> 3] |= 0x80 >> (i & 7); });
            return out;
        }
    }

    // ---------------- MP4 boxes ----------------
    function u8(v) { return [v & 255]; }
    function u16(v) { return [(v >> 8) & 255, v & 255]; }
    function u32(v) { return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]; }
    function u64(v) { const hi = Math.floor(v / 4294967296); return [...u32(hi), ...u32(v - hi * 4294967296)]; }
    function str(s) { return [...s].map(c => c.charCodeAt(0)); }

    function box(type, ...parts) {
        let size = 8;
        const arrays = parts.map(p => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
        arrays.forEach(a => { size += a.length; });
        const out = new Uint8Array(size);
        out.set(u32(size), 0);
        out.set(str(type), 4);
        let o = 8;
        for (const a of arrays) { out.set(a, o); o += a.length; }
        return out;
    }
    const full = (type, version, flags, ...parts) => box(type, [version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255], ...parts);
    const MATRIX = [...u32(0x00010000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x00010000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000)];

    function initSegment(track) {
        const isVideo = track.kind === 'video';
        const handler = isVideo
            ? [box('hdlr', [0, 0, 0, 0], u32(0), str('vide'), new Uint8Array(12), str('VideoHandler\0'))]
            : [box('hdlr', [0, 0, 0, 0], u32(0), str('soun'), new Uint8Array(12), str('SoundHandler\0'))];
        const mediaHeader = isVideo ? full('vmhd', 0, 1, new Uint8Array(8)) : full('smhd', 0, 0, new Uint8Array(4));
        const stbl = box('stbl',
            full('stsd', 0, 0, u32(1), track.sampleEntry),
            full('stts', 0, 0, u32(0)),
            full('stsc', 0, 0, u32(0)),
            full('stsz', 0, 0, u32(0), u32(0)),
            full('stco', 0, 0, u32(0)));
        const trak = box('trak',
            full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(0), new Uint8Array(8), u16(0), u16(0),
                u16(isVideo ? 0 : 0x0100), u16(0), MATRIX, u32((track.width || 0) * 65536), u32((track.height || 0) * 65536)),
            box('mdia',
                full('mdhd', 0, 0, u32(0), u32(0), u32(track.timescale), u32(0), u16(0x55C4), u16(0)),
                ...handler,
                box('minf', mediaHeader, box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))), stbl)));
        return concat(
            box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso6'), str('mp41')),
            box('moov',
                full('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(0), u32(0x00010000), u16(0x0100), new Uint8Array(10), MATRIX, new Uint8Array(24), u32(2)),
                trak,
                box('mvex', full('trex', 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0)))));
    }

    let fragmentSeq = 1;
    // samples: [{ dts, cto, duration, data, key }] in track timescale units.
    function mediaSegment(samples) {
        const count = samples.length;
        const trunSize = 12 + 8 + count * 16;
        const moofSize = 8 + 16 + (8 + 16 + 20 + trunSize);
        const entries = new Uint8Array(count * 16);
        const dv = new DataView(entries.buffer);
        let dataLen = 0;
        samples.forEach((s, i) => {
            dv.setUint32(i * 16, s.duration);
            dv.setUint32(i * 16 + 4, s.data.length);
            dv.setUint32(i * 16 + 8, s.key ? 0x02000000 : 0x01010000);
            dv.setInt32(i * 16 + 12, s.cto || 0);
            dataLen += s.data.length;
        });
        const moof = box('moof',
            full('mfhd', 0, 0, u32(fragmentSeq++)),
            box('traf',
                full('tfhd', 0, 0x020000, u32(1)),
                full('tfdt', 1, 0, u64(samples[0].dts)),
                full('trun', 1, 0x000F01, u32(count), u32(moofSize + 8), entries)));
        const mdat = new Uint8Array(8 + dataLen);
        mdat.set(u32(8 + dataLen), 0);
        mdat.set(str('mdat'), 4);
        let o = 8;
        for (const s of samples) { mdat.set(s.data, o); o += s.data.length; }
        return concat(moof, mdat);
    }

    function esdsBox(objectType, dsi) {
        const desc = (tag, bytes) => [tag, bytes.length, ...bytes];
        const dsiPart = dsi ? desc(0x05, [...dsi]) : [];
        const dcd = desc(0x04, [objectType, 0x15, 0, 0, 0, ...u32(0), ...u32(0), ...dsiPart]);
        return full('esds', 0, 0, desc(0x03, [...u16(1), 0, ...dcd, ...desc(0x06, [0x02])]));
    }

    function audioEntry(type, channels, rate, ...extra) {
        return box(type, new Uint8Array(6), u16(1), new Uint8Array(8), u16(channels), u16(16), u16(0), u16(0),
            u32(Math.min(rate, 65535) * 65536), ...extra);
    }

    function videoEntry(type, w, h, config) {
        const name = new Uint8Array(32);
        return box(type, new Uint8Array(6), u16(1), new Uint8Array(16), u16(w), u16(h), u32(0x00480000), u32(0x00480000),
            u32(0), u16(1), name, u16(0x18), u16(0xFFFF), config);
    }

    // ---------------- Codec setup ----------------
    const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    const hex = (v, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');

    function hevcCodecString(c) {
        const space = c[1] >> 6, tier = (c[1] >> 5) & 1, profile = c[1] & 0x1F;
        let compat = ((c[2] << 24) | (c[3] << 16) | (c[4] << 8) | c[5]) >>> 0, rev = 0;
        for (let i = 0; i < 32; i++) { rev = (rev << 1) | (compat & 1); compat >>>= 1; }
        const constraints = [c[6], c[7], c[8], c[9], c[10], c[11]];
        while (constraints.length && !constraints[constraints.length - 1]) constraints.pop();
        return `hvc1.${['', 'A', 'B', 'C'][space]}${profile}.${(rev >>> 0).toString(16).toUpperCase()}.${tier ? 'H' : 'L'}${c[12]}`
            + constraints.map(x => '.' + x.toString(16).toUpperCase()).join('');
    }

    function setupVideo(t) {
        if (t.codecId === 'V_MPEG4/ISO/AVC' && t.codecPrivate) {
            const c = t.codecPrivate;
            t.mime = `video/mp4; codecs="avc1.${hex(c[1])}${hex(c[2])}${hex(c[3])}"`;
            t.sampleEntry = videoEntry('avc1', t.width, t.height, box('avcC', c));
        } else if (t.codecId === 'V_MPEGH/ISO/HEVC' && t.codecPrivate) {
            t.mime = `video/mp4; codecs="${hevcCodecString(t.codecPrivate)}"`;
            t.sampleEntry = videoEntry('hvc1', t.width, t.height, box('hvcC', t.codecPrivate));
        } else {
            t.unsupportedReason = `video format ${t.codecId}`;
            return;
        }
        t.kind = 'video';
        t.timescale = 1000;
    }

    // Audio needs a look at its first frame for AC3/EAC3, so this runs once that frame arrives.
    function setupAudio(t, firstFrame) {
        const ch = t.channels || 2;
        const id = t.codecId;
        t.kind = 'audio';
        if (id.startsWith('A_AAC')) {
            let asc = t.codecPrivate;
            if (!asc || asc.length < 2) {
                const fi = Math.max(0, AAC_RATES.indexOf(t.sampleRate));
                asc = Uint8Array.from([(2 << 3) | (fi >> 1), ((fi & 1) << 7) | (ch << 3)]);
            }
            const bits = new Bits(asc);
            let ot = bits.read(5);
            if (ot === 31) ot = 32 + bits.read(6);
            const fi = bits.read(4);
            const rate = fi === 15 ? bits.read(24) : AAC_RATES[fi] || t.sampleRate;
            t.timescale = rate;
            t.frameSamples = () => 1024;
            t.mime = `audio/mp4; codecs="mp4a.40.${ot}"`;
            t.sampleEntry = audioEntry('mp4a', ch, rate, esdsBox(0x40, asc));
        } else if (id === 'A_AC3') {
            if (!firstFrame) return false;
            const b = new Bits(firstFrame, 4);
            const fscod = b.read(2), frmsizecod = b.read(6), bsid = b.read(5), bsmod = b.read(3), acmod = b.read(3);
            if ((acmod & 1) && acmod !== 1) b.read(2);
            if (acmod & 4) b.read(2);
            if (acmod === 2) b.read(2);
            const lfeon = b.read(1);
            const w = new BitWriter();
            w.write(fscod, 2); w.write(bsid, 5); w.write(bsmod, 3); w.write(acmod, 3); w.write(lfeon, 1); w.write(frmsizecod >> 1, 5); w.write(0, 5);
            t.timescale = [48000, 44100, 32000][fscod] || t.sampleRate;
            t.frameSamples = () => 1536;
            t.mime = 'audio/mp4; codecs="ac-3"';
            t.sampleEntry = audioEntry('ac-3', ch, t.timescale, box('dac3', w.bytes()));
        } else if (id === 'A_EAC3') {
            if (!firstFrame) return false;
            const b = new Bits(firstFrame, 2);
            b.read(2); b.read(3);
            const frmsiz = b.read(11), fscod = b.read(2);
            let numblkscod = 3, rate;
            if (fscod === 3) rate = [24000, 22050, 16000][b.read(2)];
            else { numblkscod = b.read(2); rate = [48000, 44100, 32000][fscod]; }
            const acmod = b.read(3), lfeon = b.read(1), bsid = b.read(5);
            const blocks = [1, 2, 3, 6][numblkscod];
            const kbps = Math.round(((frmsiz + 1) * 2 * 8) * (rate / (blocks * 256)) / 1000);
            const w = new BitWriter();
            w.write(kbps, 13); w.write(0, 3);
            w.write(fscod === 3 ? 3 : fscod, 2); w.write(bsid, 5); w.write(0, 1); w.write(0, 1); w.write(0, 3);
            w.write(acmod, 3); w.write(lfeon, 1); w.write(0, 3); w.write(0, 4); w.write(0, 1);
            t.timescale = rate;
            t.frameSamples = () => blocks * 256;
            t.mime = 'audio/mp4; codecs="ec-3"';
            t.sampleEntry = audioEntry('ec-3', ch, rate, box('dec3', w.bytes()));
        } else if (id === 'A_OPUS' && t.codecPrivate && t.codecPrivate.length >= 19) {
            const h = t.codecPrivate, dv = new DataView(h.buffer, h.byteOffset);
            const family = h[18];
            const dops = [0, h[9], ...u16(dv.getUint16(10, true)), ...u32(dv.getUint32(12, true)), ...u16(dv.getInt16(16, true) & 0xFFFF), family];
            if (family !== 0) dops.push(...h.subarray(19, 21 + h[9]));
            t.timescale = 48000;
            t.frameSamples = opusSamples;
            t.mime = 'audio/mp4; codecs="opus"';
            t.sampleEntry = audioEntry('Opus', h[9], 48000, box('dOps', dops));
        } else if (id === 'A_MPEG/L3') {
            t.timescale = t.sampleRate;
            t.frameSamples = () => 1152;
            t.mime = 'audio/mp4; codecs="mp4a.6B"';
            t.sampleEntry = audioEntry('mp4a', ch, t.sampleRate, esdsBox(0x6B, null));
        } else {
            t.unsupportedReason = id.replace(/^A_/, '');
        }
        return true;
    }

    function opusSamples(data) {
        const toc = data[0], config = toc >> 3, c = toc & 3;
        const ms = config < 12 ? [10, 20, 40, 60][config & 3] : config < 16 ? [10, 20][config & 1] : [2.5, 5, 10, 20][config & 3];
        const frames = c === 0 ? 1 : c === 3 ? (data[1] & 0x3F) : 2;
        return Math.round(ms * 48 * frames);
    }

    function cleanSubText(t, codecId) {
        let text = t;
        if (/S_TEXT\/(ASS|SSA)/.test(codecId)) {
            const parts = text.split(',');
            text = parts.slice(8).join(',');
        }
        return text
            .replace(/\{\\[^}]*\}/g, '')
            .replace(/\\N/gi, '\n')
            .replace(/<(?!\/?[ib]>)[^>]+>/g, '')
            .replace(/\r/g, '')
            .trim();
    }

    // ---------------- Streaming cluster parser ----------------
    class ClusterReader {
        constructor(file) {
            this.file = file;
            this.reset();
        }
        reset() {
            this.buf = new Uint8Array(0);
            this.skip = 0;
            this.clusterTime = 0;
            this.resync = false;
        }
        // Feed bytes; calls onFrame(track, ptsMs, key, data, durationMs) for each frame found.
        push(chunk, onFrame) {
            if (this.skip) {
                const n = Math.min(this.skip, chunk.length);
                this.skip -= n;
                chunk = chunk.subarray(n);
            }
            this.buf = concat(this.buf, chunk);
            let p = 0;
            const b = this.buf;
            if (this.resync) {
                const at = findCluster(b, 0);
                if (at < 0) { this.buf = b.subarray(Math.max(0, b.length - 3)); return; }
                p = at;
                this.resync = false;
            }
            while (p < b.length) {
                let h;
                try { h = readHeader(b, p); } catch (e) { this.resync = true; this.buf = b.subarray(p + 1); return this.push(new Uint8Array(0), onFrame); }
                if (!h) break;
                if (h.id === ID.Cluster || h.id === ID.Segment) { p = h.dataStart; continue; }
                if (h.size < 0) { p = h.dataStart; continue; }
                const end = h.dataStart + h.size;
                if (h.id === ID.Timecode || h.id === ID.SimpleBlock || h.id === ID.BlockGroup) {
                    if (end > b.length) break;
                    if (h.id === ID.Timecode) this.clusterTime = readUint(b, h.dataStart, h.size);
                    else if (h.id === ID.SimpleBlock) this.block(b.subarray(h.dataStart, end), null, null, onFrame);
                    else this.group(b, h.dataStart, end, onFrame);
                    p = end;
                } else {
                    // Anything else (Void, CRC, Cues, Tags...) is skipped, even if it isn't fully loaded.
                    if (end > b.length) { this.skip = end - b.length; p = b.length; break; }
                    p = end;
                }
            }
            this.buf = b.subarray(p);
        }
        group(b, start, end, onFrame) {
            let block = null, duration = null, key = true;
            children(b, start, end, (id, p, n) => {
                if (id === ID.Block) block = b.subarray(p, p + n);
                else if (id === ID.BlockDuration) duration = readUint(b, p, n);
                else if (id === ID.ReferenceBlock) key = false;
            });
            if (block) this.block(block, key, duration, onFrame);
        }
        block(d, keyOverride, duration, onFrame) {
            const tn = readVint(d, 0);
            if (!tn) return;
            const track = this.file.trackByNumber.get(tn.value);
            if (!track || !track.wanted) return;
            let p = tn.length;
            const rel = (d[p] << 24 >> 16) | d[p + 1];
            const flags = d[p + 2];
            p += 3;
            const scale = this.file.timecodeScale / 1e6;
            const pts = (this.clusterTime + rel) * scale;
            const key = keyOverride === null ? !!(flags & 0x80) : keyOverride;
            const durMs = duration !== null ? duration * scale : null;
            const lacing = (flags >> 1) & 3;
            let frames;
            if (!lacing) {
                frames = [d.subarray(p)];
            } else {
                const count = d[p++] + 1;
                const sizes = [];
                if (lacing === 1) {
                    for (let i = 0; i < count - 1; i++) {
                        let s = 0, v;
                        do { v = d[p++]; s += v; } while (v === 255);
                        sizes.push(s);
                    }
                } else if (lacing === 3) {
                    let v = readVint(d, p);
                    let s = v.value;
                    p += v.length;
                    sizes.push(s);
                    for (let i = 1; i < count - 1; i++) {
                        v = readVint(d, p);
                        p += v.length;
                        s += v.value - (Math.pow(2, 7 * v.length - 1) - 1);
                        sizes.push(s);
                    }
                } else {
                    const each = (d.length - p) / count;
                    for (let i = 0; i < count - 1; i++) sizes.push(each);
                }
                const used = sizes.reduce((a, c) => a + c, 0);
                sizes.push(d.length - p - used);
                frames = sizes.map(s => { const f = d.subarray(p, p + s); p += s; return f; });
            }
            frames.forEach((f, i) => {
                const data = track.strip ? concat(track.strip, f) : f;
                onFrame(track, pts, key, data, durMs, i);
            });
        }
    }

    function findCluster(b, from) {
        for (let i = from; i + 3 < b.length; i++) {
            if (b[i] === 0x1F && b[i + 1] === 0x43 && b[i + 2] === 0xB6 && b[i + 3] === 0x75) return i;
        }
        return -1;
    }

    // ---------------- File header / index ----------------
    async function openFile(fetchRange) {
        const first = await fetchRange(0, 1024 * 1024 - 1);
        const b = first.data;
        const file = { size: first.total, timecodeScale: 1e6, duration: 0, tracks: [], trackByNumber: new Map(), cues: [] };
        let p = 0;
        const ebml = readHeader(b, p);
        if (!ebml || ebml.id !== ID.EBML) throw new Error('Not an MKV file');
        p = ebml.dataStart + ebml.size;
        const seg = readHeader(b, p);
        if (!seg || seg.id !== ID.Segment) throw new Error('MKV segment not found');
        file.segmentStart = seg.dataStart;
        const seeks = {};
        let infoAt = null, tracksAt = null;
        p = seg.dataStart;
        while (p < b.length) {
            const h = readHeader(b, p);
            if (!h || h.size < 0) break;
            const end = h.dataStart + h.size;
            if (h.id === ID.Cluster) { file.firstCluster = p; break; }
            if (end <= b.length) {
                if (h.id === ID.SeekHead) {
                    children(b, h.dataStart, end, (id, sp, sn) => {
                        if (id !== ID.Seek) return;
                        let sid = 0, pos = 0;
                        children(b, sp, sp + sn, (cid, cp, cn) => {
                            if (cid === ID.SeekID) sid = readUint(b, cp, cn);
                            if (cid === ID.SeekPosition) pos = readUint(b, cp, cn);
                        });
                        if (!(sid in seeks)) seeks[sid] = file.segmentStart + pos;
                    });
                } else if (h.id === ID.Info) infoAt = [b, h.dataStart, end];
                else if (h.id === ID.Tracks) tracksAt = [b, h.dataStart, end];
            }
            p = end;
        }
        const loadElement = async pos => {
            const head = (await fetchRange(pos, pos + 15)).data;
            const h = readHeader(head, 0);
            const body = (await fetchRange(pos + h.headerLength, pos + h.headerLength + h.size - 1)).data;
            return [body, 0, body.length];
        };
        if (!infoAt && seeks[ID.Info]) infoAt = await loadElement(seeks[ID.Info]);
        if (!tracksAt && seeks[ID.Tracks]) tracksAt = await loadElement(seeks[ID.Tracks]);
        if (!tracksAt) throw new Error('No track list in this file');

        if (infoAt) {
            let rawDuration = 0;
            children(...infoAt, (id, ip, n) => {
                const ib = infoAt[0];
                if (id === ID.TimecodeScale) file.timecodeScale = readUint(ib, ip, n);
                if (id === ID.Duration) rawDuration = readFloat(ib, ip, n);
            });
            file.duration = rawDuration * file.timecodeScale / 1e9;
        }

        const tb = tracksAt[0];
        children(...tracksAt, (id, tp, tn) => {
            if (id !== ID.TrackEntry) return;
            const t = { language: 'eng', name: '', isDefault: true, forced: false, channels: 0, sampleRate: 8000 };
            children(tb, tp, tp + tn, (cid, cp, cn) => {
                switch (cid) {
                    case ID.TrackNumber: t.number = readUint(tb, cp, cn); break;
                    case ID.TrackType: t.type = readUint(tb, cp, cn); break;
                    case ID.CodecID: t.codecId = readString(tb, cp, cn); break;
                    case ID.CodecPrivate: t.codecPrivate = tb.slice(cp, cp + cn); break;
                    case ID.Language: t.language = readString(tb, cp, cn); break;
                    case ID.LanguageIETF: t.languageIETF = readString(tb, cp, cn); break;
                    case ID.Name: t.name = readString(tb, cp, cn); break;
                    case ID.FlagDefault: t.isDefault = !!readUint(tb, cp, cn); break;
                    case ID.FlagForced: t.forced = !!readUint(tb, cp, cn); break;
                    case ID.DefaultDuration: t.defaultDuration = readUint(tb, cp, cn) / 1e6; break;
                    case ID.Video:
                        children(tb, cp, cp + cn, (vid, vp, vn) => {
                            if (vid === ID.PixelWidth) t.width = readUint(tb, vp, vn);
                            if (vid === ID.PixelHeight) t.height = readUint(tb, vp, vn);
                        });
                        break;
                    case ID.Audio:
                        children(tb, cp, cp + cn, (aid, ap, an) => {
                            if (aid === ID.SamplingFrequency) t.sampleRate = Math.round(readFloat(tb, ap, an));
                            if (aid === ID.Channels) t.channels = readUint(tb, ap, an);
                        });
                        break;
                    case ID.ContentEncodings:
                        // Header stripping: the removed bytes have to be put back on every frame.
                        children(tb, cp, cp + cn, (eid, ep, en) => {
                            if (eid !== ID.ContentEncoding) return;
                            children(tb, ep, ep + en, (xid, xp, xn) => {
                                if (xid !== ID.ContentCompression) return;
                                let algo = 0, settings = null;
                                children(tb, xp, xp + xn, (yid, yp, yn) => {
                                    if (yid === ID.ContentCompAlgo) algo = readUint(tb, yp, yn);
                                    if (yid === ID.ContentCompSettings) settings = tb.slice(yp, yp + yn);
                                });
                                if (algo === 3 && settings) t.strip = settings;
                                else t.unsupportedReason = 'compressed track';
                            });
                        });
                        break;
                }
            });
            file.tracks.push(t);
            file.trackByNumber.set(t.number, t);
        });

        if (seeks[ID.Cues]) {
            try {
                const [cb, cs, ce] = await loadElement(seeks[ID.Cues]);
                const video = file.tracks.find(t => t.type === 1);
                children(cb, cs, ce, (id, p2, n2) => {
                    if (id !== ID.CuePoint) return;
                    let time = 0;
                    children(cb, p2, p2 + n2, (cid, cp, cn) => {
                        if (cid === ID.CueTime) time = readUint(cb, cp, cn);
                        if (cid === ID.CueTrackPositions) {
                            let track = 0, pos = -1;
                            children(cb, cp, cp + cn, (xid, xp, xn) => {
                                if (xid === ID.CueTrack) track = readUint(cb, xp, xn);
                                if (xid === ID.CueClusterPosition) pos = readUint(cb, xp, xn);
                            });
                            if (pos >= 0 && (!video || track === video.number)) {
                                file.cues.push({ time: time * file.timecodeScale / 1e9, pos: file.segmentStart + pos });
                            }
                        }
                    });
                });
                file.cues.sort((a, b2) => a.time - b2.time);
            } catch (e) { /* no seek index: seeking falls back to estimating by file position */ }
        }
        if (!file.firstCluster) file.firstCluster = file.cues.length ? file.cues[0].pos : null;
        return file;
    }

    // ---------------- Engine ----------------
    const CHUNK = 2 * 1024 * 1024;
    const AHEAD = 90;    // seconds to keep buffered ahead of playback
    const BEHIND = 30;   // seconds to keep behind it

    class Engine {
        constructor(video, fetchRange) {
            this.video = video;
            this.fetchRange = fetchRange;
            this.gen = 0;
            this.subCues = new Map();
            this.onSubtitles = null;
            this.onError = null;
        }

        static supported() {
            return !!(root.ManagedMediaSource || root.MediaSource);
        }

        async open() {
            const MS = root.ManagedMediaSource || root.MediaSource;
            if (!MS) throw new Error('This browser cannot stream MKV files (no Media Source support)');
            this.MS = MS;
            const file = this.file = await openFile(this.fetchRange);
            this.videoTrack = file.tracks.find(t => t.type === 1);
            if (this.videoTrack) {
                setupVideo(this.videoTrack);
                if (this.videoTrack.mime && !MS.isTypeSupported(this.videoTrack.mime)) {
                    this.videoTrack.unsupportedReason = 'this device can\'t decode ' + this.videoTrack.mime.split('"')[1];
                }
                if (this.videoTrack.unsupportedReason) throw new Error('Unsupported ' + this.videoTrack.unsupportedReason);
                this.videoTrack.wanted = true;
            }
            this.audioTracks = file.tracks.filter(t => t.type === 2);
            this.subTracks = file.tracks.filter(t => t.type === 17);
            for (const t of this.subTracks) {
                t.text = /^S_TEXT\//.test(t.codecId);
                t.wanted = t.text;
                this.subCues.set(t.number, new Map());
            }
            for (const t of this.audioTracks) {
                // AC3/EAC3 need a frame before their MP4 description can be written; assume OK until then.
                if (!/A_AC3|A_EAC3/.test(t.codecId)) {
                    setupAudio(t, null);
                    if (t.mime && !MS.isTypeSupported(t.mime)) t.unsupportedReason = 'not playable here';
                } else {
                    t.mime = t.codecId === 'A_AC3' ? 'audio/mp4; codecs="ac-3"' : 'audio/mp4; codecs="ec-3"';
                    if (!MS.isTypeSupported(t.mime)) t.unsupportedReason = 'Dolby audio not playable here';
                }
            }
            const firstOk = this.audioTracks.find(t => !t.unsupportedReason);
            this.audio = firstOk || null;
            return this.info();
        }

        info() {
            const lang = t => t.languageIETF || t.language || 'und';
            return {
                duration: this.file.duration,
                video: this.videoTrack ? { codec: this.videoTrack.codecId, width: this.videoTrack.width, height: this.videoTrack.height } : null,
                audio: this.audioTracks.map((t, i) => ({
                    index: i, lang: lang(t), title: t.name, codec: t.codecId.replace(/^A_/, ''), channels: t.channels,
                    default: t.isDefault, supported: !t.unsupportedReason, reason: t.unsupportedReason || ''
                })),
                subs: this.subTracks.map((t, i) => ({
                    index: i, lang: lang(t), title: t.name, codec: t.codecId.replace(/^S_/, ''), text: t.text,
                    default: t.isDefault, forced: t.forced
                }))
            };
        }

        // Start (or restart) playback from `time` seconds with audio track `audioIndex`.
        async start(time = 0, audioIndex) {
            if (audioIndex !== undefined) {
                const t = this.audioTracks[audioIndex];
                if (t && !t.unsupportedReason) this.audio = t;
            }
            for (const t of this.audioTracks) t.wanted = t === this.audio;
            const gen = ++this.gen;
            if (!this.ms) await this.createSource();
            else await this.resetBuffers();
            if (gen !== this.gen) return;
            this.audioInitDone = false;
            this.vq = [];
            this.aq = [];
            this.lastVideoDts = -Infinity;
            this.nextAudioDts = null;
            this.appendQueue(this.vsb, this.videoTrack && initSegment(this.videoTrack));
            this.feed(gen, this.positionFor(time));
            if (Math.abs(this.video.currentTime - time) > 0.5) this.video.currentTime = time;
        }

        positionFor(time) {
            const f = this.file;
            if (f.cues.length) {
                let pick = f.cues[0];
                for (const c of f.cues) { if (c.time <= time) pick = c; else break; }
                return { pos: pick.pos, resync: false };
            }
            if (!time || !f.duration) return { pos: f.firstCluster || f.segmentStart, resync: !f.firstCluster };
            const est = f.segmentStart + Math.floor((f.size - f.segmentStart) * Math.max(0, time - 5) / f.duration);
            return { pos: est, resync: true };
        }

        createSource() {
            return new Promise((resolve, reject) => {
                const ms = this.ms = new this.MS();
                if (root.ManagedMediaSource && ms instanceof root.ManagedMediaSource) this.video.disableRemotePlayback = true;
                ms.addEventListener('sourceopen', () => {
                    try {
                        if (this.file.duration) ms.duration = this.file.duration;
                        // Both buffers must exist before any data goes in; browsers refuse to add one later.
                        if (this.videoTrack) this.vsb = this.addBuffer(this.videoTrack.mime);
                        if (this.audio) this.asb = this.addBuffer(this.audio.mime);
                        resolve();
                    } catch (e) { reject(e); }
                }, { once: true });
                this.video.src = URL.createObjectURL(ms);
                this.watch();
            });
        }

        addBuffer(mime) {
            const sb = this.ms.addSourceBuffer(mime);
            sb.mode = 'segments';
            sb.queue = [];
            sb.mime = mime;
            sb.addEventListener('updateend', () => this.pump(sb));
            sb.addEventListener('error', () => this.fail(new Error('The browser rejected the video data')));
            return sb;
        }

        async resetBuffers() {
            for (const sb of [this.vsb, this.asb]) {
                if (!sb) continue;
                sb.queue = [];
                await this.waitIdle(sb);
                try { sb.abort(); } catch (e) { /* not updating */ }
            }
        }

        waitIdle(sb) {
            return sb.updating ? new Promise(r => sb.addEventListener('updateend', r, { once: true })) : Promise.resolve();
        }

        appendQueue(sb, data) {
            if (!sb || !data) return;
            sb.queue.push(data);
            this.pump(sb);
        }

        pump(sb) {
            if (sb.updating || !sb.queue.length || this.ms.readyState !== 'open') return;
            const data = sb.queue[0];
            try {
                sb.appendBuffer(data);
                sb.queue.shift();
            } catch (e) {
                if (e.name === 'QuotaExceededError') {
                    this.trim(true);
                    setTimeout(() => this.pump(sb), 1000);
                } else {
                    this.fail(e);
                }
            }
        }

        // Drop what's well behind the playhead so the browser doesn't run out of memory.
        trim(force) {
            const now = this.video.currentTime;
            for (const sb of [this.vsb, this.asb]) {
                if (!sb || sb.updating || !sb.buffered.length) continue;
                const start = sb.buffered.start(0);
                if (now - start > BEHIND + (force ? 0 : 30)) {
                    try { sb.remove(0, Math.max(0, now - BEHIND)); } catch (e) { /* ignore */ }
                }
            }
        }

        bufferedAhead() {
            const v = this.video, now = v.currentTime;
            let end = now;
            for (let i = 0; i < v.buffered.length; i++) {
                if (v.buffered.start(i) <= now + 0.5 && v.buffered.end(i) > end) end = v.buffered.end(i);
            }
            return end - now;
        }

        pendingBytes() {
            return [this.vsb, this.asb].reduce((n, sb) => n + (sb ? sb.queue.reduce((m, q) => m + q.length, 0) : 0), 0);
        }

        async feed(gen, { pos, resync }) {
            const reader = this.reader = new ClusterReader(this.file);
            reader.resync = resync;
            const onFrame = (track, pts, key, data, durMs, laceIndex) => this.frame(track, pts, key, data, durMs, laceIndex);
            while (gen === this.gen) {
                if (this.bufferedAhead() > AHEAD || this.pendingBytes() > 24 * 1024 * 1024) {
                    this.trim(false);
                    await new Promise(r => setTimeout(r, 1000));
                    continue;
                }
                if (pos >= this.file.size) break;
                let chunk;
                try {
                    chunk = await this.fetchRange(pos, Math.min(this.file.size, pos + CHUNK) - 1);
                } catch (e) {
                    if (gen !== this.gen) return;
                    await new Promise(r => setTimeout(r, 2000));
                    continue;
                }
                if (gen !== this.gen) return;
                pos += chunk.data.length;
                reader.push(chunk.data, onFrame);
                this.flushVideo(false);
                this.flushAudio(false);
            }
            if (gen !== this.gen) return;
            this.flushVideo(true);
            this.flushAudio(true);
            const done = () => {
                if (gen !== this.gen) return;
                const busy = [this.vsb, this.asb].some(sb => sb && (sb.updating || sb.queue.length));
                if (busy) return setTimeout(done, 500);
                try { if (this.ms.readyState === 'open') this.ms.endOfStream(); } catch (e) { /* ignore */ }
            };
            done();
        }

        frame(track, pts, key, data, durMs, laceIndex) {
            if (track.type === 17) {
                const text = cleanSubText(utf8.decode(data), track.codecId);
                if (!text) return;
                const cues = this.subCues.get(track.number);
                if (!cues.has(pts)) {
                    cues.set(pts, { start: pts / 1000, end: (pts + (durMs || 3000)) / 1000, text });
                    if (this.onSubtitles) this.onSubtitles(this.subTracks.indexOf(track));
                }
                return;
            }
            if (track === this.videoTrack) {
                if (key && this.vq.length) this.flushVideo(true);
                if (!this.vq.length && !key) return;   // wait for a keyframe after a seek
                this.vq.push({ pts, key, data });
                return;
            }
            if (track === this.audio) {
                if (!this.audioInitDone) {
                    if (!track.sampleEntry && !setupAudio(track, data)) return;
                    if (!track.sampleEntry || !this.asb) return;
                    if (this.asb.mime !== track.mime && this.asb.changeType) {
                        this.asb.changeType(track.mime);
                        this.asb.mime = track.mime;
                    }
                    this.appendQueue(this.asb, initSegment(track));
                    this.audioInitDone = true;
                }
                this.aq.push({ pts, data, lace: laceIndex });
            }
        }

        // Video goes out one keyframe-to-keyframe group at a time (force), except very long groups.
        flushVideo(force) {
            const q = this.vq;
            if (!q || !q.length) return;
            const span = q[q.length - 1].pts - q[0].pts;
            if (!force && span < 10000) return;
            // MKV only stores presentation times; decode times are the same values in sorted order.
            const sorted = q.map(f => f.pts).sort((a, b) => a - b);
            const frameDur = this.videoTrack.defaultDuration || (q.length > 1 ? span / (q.length - 1) : 41.7);
            const samples = q.map((f, i) => {
                let dts = Math.round(sorted[i]);
                if (dts <= this.lastVideoDts) dts = this.lastVideoDts + 1;
                this.lastVideoDts = dts;
                return { dts, cto: Math.round(f.pts) - dts, data: f.data, key: f.key };
            });
            samples.forEach((s, i) => {
                s.duration = i + 1 < samples.length ? samples[i + 1].dts - s.dts : Math.max(1, Math.round(frameDur));
            });
            this.vq = [];
            this.appendQueue(this.vsb, mediaSegment(samples));
        }

        flushAudio(force) {
            const q = this.aq, t = this.audio;
            if (!q || !q.length || !t || !t.sampleEntry || !this.audioInitDone) return;
            if (!force && q[q.length - 1].pts - q[0].pts < 2000) return;
            const samples = [];
            let dts = null;
            for (const f of q) {
                const n = t.frameSamples(f.data);
                if (f.lace === 0 || dts === null) {
                    const fromPts = Math.round(f.pts * t.timescale / 1000);
                    dts = this.nextAudioDts !== null && Math.abs(fromPts - this.nextAudioDts) < n ? this.nextAudioDts : fromPts;
                }
                samples.push({ dts, duration: n, data: f.data, key: true });
                dts += n;
                this.nextAudioDts = dts;
            }
            this.aq = [];
            this.appendQueue(this.asb, mediaSegment(samples));
        }

        watch() {
            const v = this.video;
            this.onSeeking = () => {
                const t = v.currentTime;
                for (let i = 0; i < v.buffered.length; i++) {
                    if (v.buffered.start(i) <= t && t < v.buffered.end(i) - 1) return;
                }
                clearTimeout(this.seekTimer);
                // Wait for the scrubbing to settle before refetching.
                this.seekTimer = setTimeout(() => this.start(v.currentTime), 150);
            };
            v.addEventListener('seeking', this.onSeeking);
        }

        // Switch audio language: the new track is fetched from the current position.
        async setAudio(index) {
            const t = this.audioTracks[index];
            if (!t || t.unsupportedReason || t === this.audio) return;
            const now = this.video.currentTime;
            if (this.asb) {
                this.asb.queue = [];
                await this.waitIdle(this.asb);
                try { this.asb.abort(); this.asb.remove(0, Infinity); } catch (e) { /* ignore */ }
                await this.waitIdle(this.asb);
            }
            await this.start(now, index);
        }

        cues(subIndex) {
            const t = this.subTracks[subIndex];
            if (!t) return [];
            return [...this.subCues.get(t.number).values()].sort((a, b) => a.start - b.start);
        }

        fail(err) {
            if (this.failed) return;
            this.failed = true;
            if (this.onError) this.onError(err);
        }

        destroy() {
            this.gen++;
            clearTimeout(this.seekTimer);
            if (this.onSeeking) this.video.removeEventListener('seeking', this.onSeeking);
            try { if (this.ms && this.ms.readyState === 'open') this.ms.endOfStream(); } catch (e) { /* ignore */ }
            this.video.removeAttribute('src');
            this.video.load();
        }
    }

    // Range fetcher for a URL the page may read directly (same origin, or a CORS-enabled proxy).
    function httpRange(url) {
        return async (start, end) => {
            const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
            if (res.status !== 206 && !(res.status === 200 && start === 0)) throw new Error('Server does not support seeking (HTTP ' + res.status + ')');
            const range = res.headers.get('Content-Range');
            const total = range ? parseInt(range.split('/')[1], 10) : parseInt(res.headers.get('Content-Length'), 10);
            let data = new Uint8Array(await res.arrayBuffer());
            if (res.status === 200 && data.length > end - start + 1) data = data.subarray(0, end - start + 1);
            return { data, total };
        };
    }

    root.MFMse = { Engine, httpRange, openFile, _internal: { readVint, readId, hevcCodecString, ClusterReader } };
})(typeof self !== 'undefined' ? self : this);
