/**
 * 小帷 · 背景轻管家 (st-bg-lite)
 * SillyTavern 第三方扩展：接管背景面板与背景显示层，解决背景一多就白屏的问题。
 *
 * 做法：
 *  1. 列表只渲染占位格子，缩略图进入视口才加载、离开视口就卸载；缩略图在本机生成一次后存 IndexedDB。
 *  2. 背景上屏前先按当前屏幕尺寸缩放裁切（默认长边 2048），显存占用只有原图的几分之一到几十分之一。
 *  3. 上传 / 删除 / 重命名走酒馆原生接口，列表增量更新，不整体重绘。
 *     列表接口 /api/backgrounds/all 在酒馆 1.13.1 从数组改成了 { images, config }，1.16 起 images 里还带 isAnimated；三种格式都认。
 *  4. 原生面板与原生背景层通过 CSS 关闭贴图加载；关掉扩展开关即可恢复原生。
 *
 * 依赖：SillyTavern 1.12+（使用 SillyTavern.getContext()）。
 */

const MODULE = 'bglite';
const TAG = '[小帷]';
const META_KEY = 'bglite';                 // chat_metadata 键：本聊天锁定的背景文件名
const NATIVE_META_KEY = 'custom_background'; // 原生按聊天锁定的键（只读导入 + 解锁时一并清掉）
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;
const NO_SCALE_EXT = /\.(gif|apng)$/i;      // 动图不缩放，直接用原文件
const THUMB_PASSTHROUGH_BYTES = 200 * 1024;  // 服务端缩略图小于此体积就直接用

const DEFAULTS = Object.freeze({
    enabled: true,          // 接管开关
    current: '',            // 全局当前背景文件名
    fit: 'cover',           // cover | contain | center
    maxEdge: 2048,          // 背景显示层长边上限，0 = 原图直出
    quality: 0.85,          // 缩放后 JPEG 质量
    fade: true,             // 切换淡入
    thumbWidth: 320,        // 缩略图宽度
    thumbSource: 'auto',    // auto = 服务端缩略图可用就用；original = 总是从原图生成
    cellMin: 120,           // 格子最小宽度 px
    compressUpload: true,   // 上传前压缩大图
    uploadMaxEdge: 2560,
    uploadQuality: 0.9,
    syncNative: false,      // 选择时同步调用原生 /bg（兼容用）
    sortDesc: false,
});

const state = {
    names: [],
    animated: new Set(),    // 服务端标记为动图的文件名（酒馆 1.16+ 列表接口给的 isAnimated）
    cells: new Map(),       // name -> cell element
    shown: '',              // 当前上屏文件名
    shownKey: '',
    batch: false,
    selected: new Set(),
    filter: '',
    layerA: null,
    layerB: null,
    active: null,
    objUrl: null,
    seq: 0,
    io: null,
    queue: null,
    ui: null,
};

/* ────────────────────────── 基础工具 ────────────────────────── */

const ctx = () => SillyTavern.getContext();

function settings() {
    const all = ctx().extensionSettings;
    if (!all[MODULE] || typeof all[MODULE] !== 'object') all[MODULE] = {};
    const s = all[MODULE];
    for (const [k, v] of Object.entries(DEFAULTS)) if (!(k in s)) s[k] = v;
    return s;
}
const saveSettings = () => ctx().saveSettingsDebounced();

const isVideo = (n) => VIDEO_EXT.test(n);
const bgUrl = (n) => `/backgrounds/${encodeURIComponent(n)}`;
const thumbUrl = (n) => `/thumbnail?type=bg&file=${encodeURIComponent(n)}`;
const displayName = (n) => n.replace(/\.[^.]+$/, '');
const naturalCompare = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isTouch = () => (navigator.maxTouchPoints || 0) > 0;
const isMobileLike = () => isTouch() && Math.min(window.innerWidth, window.innerHeight) < 900;

const toast = {
    ok: (m) => toastr.success(m, '小帷'),
    err: (m) => toastr.error(m, '小帷'),
    warn: (m, o) => toastr.warning(m, '小帷', o),
    info: (m, o) => toastr.info(m, '小帷', o),
};

class Queue {
    constructor(n) { this.n = n; this.q = []; this.running = 0; }
    add(fn) {
        return new Promise((resolve, reject) => {
            this.q.push({ fn, resolve, reject });
            this.pump();
        });
    }
    pump() {
        while (this.running < this.n && this.q.length) {
            const { fn, resolve, reject } = this.q.shift();
            this.running++;
            Promise.resolve().then(fn).then(resolve, reject).finally(() => { this.running--; this.pump(); });
        }
    }
}

async function fetchBlob(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    return await r.blob();
}

/* ────────────────────────── IndexedDB 缓存 ────────────────────────── */

const DB_NAME = 'st-bg-lite';
let dbPromise = null;

function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        try {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains('thumbs')) db.createObjectStore('thumbs');
                if (!db.objectStoreNames.contains('scaled')) db.createObjectStore('scaled');
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
            req.onblocked = () => reject(new Error('IndexedDB blocked'));
        } catch (e) { reject(e); }
    });
    dbPromise.catch(() => { dbPromise = null; });
    return dbPromise;
}

function idb(store, mode, fn) {
    return openDb()
        .then((db) => new Promise((resolve, reject) => {
            const tx = db.transaction(store, mode);
            const req = fn(tx.objectStore(store));
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        }))
        .catch((e) => { console.warn(TAG, 'IndexedDB 不可用：', e?.message || e); return undefined; });
}
const idbGet = (store, key) => idb(store, 'readonly', (os) => os.get(key));
const idbPut = (store, key, val) => idb(store, 'readwrite', (os) => os.put(val, key));
const idbDel = (store, key) => idb(store, 'readwrite', (os) => os.delete(key));
const idbClear = (store) => idb(store, 'readwrite', (os) => os.clear());
const idbKeys = (store) => idb(store, 'readonly', (os) => os.getAllKeys());

async function purgeCache(name) {
    await idbDel('thumbs', name);
    const keys = (await idbKeys('scaled')) || [];
    for (const k of keys) if (typeof k === 'string' && k.startsWith(name + '|')) await idbDel('scaled', k);
}

async function migrateCache(oldName, newName) {
    const t = await idbGet('thumbs', oldName);
    if (t !== undefined) { await idbPut('thumbs', newName, t); await idbDel('thumbs', oldName); }
    const keys = (await idbKeys('scaled')) || [];
    for (const k of keys) {
        if (typeof k !== 'string' || !k.startsWith(oldName + '|')) continue;
        const v = await idbGet('scaled', k);
        if (v !== undefined) await idbPut('scaled', newName + k.slice(oldName.length), v);
        await idbDel('scaled', k);
    }
}

/* ────────────────────────── 图片处理 ────────────────────────── */

/** 只读文件头拿尺寸，避免为了知道大小先整图解码一遍 */
async function sniffDims(blob) {
    const head = new Uint8Array(await blob.slice(0, 512 * 1024).arrayBuffer());
    const dv = new DataView(head.buffer);
    const n = head.length;
    if (n < 30) return null;
    // PNG（IDAT 之前出现 acTL 块就是 APNG）
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47) {
        let animated = false;
        let i = 8;
        while (i + 8 <= n) {
            const len = dv.getUint32(i);
            const type = String.fromCharCode(head[i + 4], head[i + 5], head[i + 6], head[i + 7]);
            if (type === 'acTL') { animated = true; break; }
            if (type === 'IDAT' || type === 'IEND') break;
            i += 12 + len;
        }
        return { w: dv.getUint32(16), h: dv.getUint32(20), animated };
    }
    // GIF
    if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) {
        return { w: dv.getUint16(6, true), h: dv.getUint16(8, true) };
    }
    // BMP
    if (head[0] === 0x42 && head[1] === 0x4D) {
        return { w: Math.abs(dv.getInt32(18, true)), h: Math.abs(dv.getInt32(22, true)) };
    }
    // WebP
    if (head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) {
        const chunk = String.fromCharCode(head[12], head[13], head[14], head[15]);
        if (chunk === 'VP8 ') return { w: dv.getUint16(26, true) & 0x3FFF, h: dv.getUint16(28, true) & 0x3FFF };
        if (chunk === 'VP8L') {
            const b0 = head[21], b1 = head[22], b2 = head[23], b3 = head[24];
            return { w: 1 + (((b1 & 0x3F) << 8) | b0), h: 1 + (((b3 & 0x0F) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6)) };
        }
        if (chunk === 'VP8X') {
            // 标志位 bit1 = Animation
            return { w: 1 + (head[24] | (head[25] << 8) | (head[26] << 16)), h: 1 + (head[27] | (head[28] << 8) | (head[29] << 16)), animated: !!(head[20] & 0x02) };
        }
        return null;
    }
    // JPEG：扫 SOF 段
    if (head[0] === 0xFF && head[1] === 0xD8) {
        let i = 2;
        while (i < n - 9) {
            if (head[i] !== 0xFF) { i++; continue; }
            const m = head[i + 1];
            if (m === 0xFF) { i++; continue; }
            if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
            if (m === 0xD9 || m === 0xDA) break;
            const len = dv.getUint16(i + 2);
            const isSOF = (m >= 0xC0 && m <= 0xCF) && m !== 0xC4 && m !== 0xC8 && m !== 0xCC;
            if (isSOF) return { h: dv.getUint16(i + 5), w: dv.getUint16(i + 7) };
            i += 2 + len;
        }
    }
    return null;
}

async function tryBitmap(blob, rw, rh) {
    if (typeof createImageBitmap !== 'function') return null;
    try {
        return rw && rh
            ? await createImageBitmap(blob, { resizeWidth: rw, resizeHeight: rh, resizeQuality: 'high' })
            : await createImageBitmap(blob);
    } catch { return null; }
}

function loadImg(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.decoding = 'async';
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('图片解码失败'));
        img.src = url;
    });
}

function preScale(w, h, opt) {
    return opt.mode === 'cover'
        ? Math.min(1, Math.max(opt.w / w, opt.h / h))
        : Math.min(1, opt.w / Math.max(w, h));
}

/**
 * 缩放并编码为 JPEG。
 * cover：缩到刚好铺满 opt.w×opt.h 后居中裁切；fit：长边不超过 opt.w，不裁切。两者都不放大。
 */
async function rescale(blob, opt) {
    const dims = await sniffDims(blob).catch(() => null);
    let src = null;
    let srcUrl = null;
    if (dims && dims.w > 0 && dims.h > 0) {
        const sc = preScale(dims.w, dims.h, opt);
        if (sc < 1) src = await tryBitmap(blob, Math.max(1, Math.round(dims.w * sc)), Math.max(1, Math.round(dims.h * sc)));
    }
    if (!src) src = await tryBitmap(blob);
    if (!src) { srcUrl = URL.createObjectURL(blob); src = await loadImg(srcUrl); }

    const bw = src.naturalWidth || src.width;
    const bh = src.naturalHeight || src.height;
    let sx = 0, sy = 0, sw = bw, sh = bh, ow, oh;
    if (opt.mode === 'cover') {
        const sc = Math.min(1, Math.max(opt.w / bw, opt.h / bh));
        sw = Math.min(bw, Math.round(opt.w / sc));
        sh = Math.min(bh, Math.round(opt.h / sc));
        sx = Math.floor((bw - sw) / 2);
        sy = Math.floor((bh - sh) / 2);
        ow = Math.max(1, Math.round(sw * sc));
        oh = Math.max(1, Math.round(sh * sc));
    } else {
        const sc = Math.min(1, opt.w / Math.max(bw, bh));
        ow = Math.max(1, Math.round(bw * sc));
        oh = Math.max(1, Math.round(bh * sc));
    }

    const canvas = document.createElement('canvas');
    canvas.width = ow;
    canvas.height = oh;
    const g = canvas.getContext('2d', { alpha: false });
    g.fillStyle = '#000';
    g.fillRect(0, 0, ow, oh);
    g.drawImage(src, sx, sy, sw, sh, 0, 0, ow, oh);
    if (typeof src.close === 'function') src.close();
    if (srcUrl) URL.revokeObjectURL(srcUrl);

    const out = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', opt.quality));
    canvas.width = canvas.height = 0;
    if (!out) throw new Error('图片编码失败');
    return out;
}

/* ────────────────────────── 背景显示层 ────────────────────────── */

function isLandscape() {
    const t = screen.orientation && screen.orientation.type;
    if (t) return t.startsWith('landscape');
    if (typeof window.orientation === 'number') return Math.abs(window.orientation) === 90;
    return window.innerWidth >= window.innerHeight;
}

/** 当前屏幕应该渲染的目标像素尺寸（物理像素，长边受 maxEdge 约束） */
function targetDims() {
    const s = settings();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const shortS = Math.min(screen.width, screen.height);
    const longS = Math.max(screen.width, screen.height);
    const land = isLandscape();
    let tw = Math.round((land ? longS : shortS) * dpr);
    let th = Math.round((land ? shortS : longS) * dpr);
    const cap = s.maxEdge > 0 ? s.maxEdge : Infinity;
    const m = Math.max(tw, th);
    if (m > cap) { const k = cap / m; tw = Math.round(tw * k); th = Math.round(th * k); }
    return { tw, th };
}

function layerKey(name) {
    const s = settings();
    const { tw, th } = targetDims();
    return `${name}|${tw}x${th}|${s.fit}|${s.maxEdge}|${s.quality}${state.animated.has(name) ? '|anim' : ''}`;
}

async function getScaledBlob(name) {
    const s = settings();
    const key = layerKey(name);
    const cached = await idbGet('scaled', key);
    if (cached instanceof Blob) return cached;
    const { tw, th } = targetDims();
    const src = await fetchBlob(bgUrl(name));
    const out = s.fit === 'cover'
        ? await rescale(src, { mode: 'cover', w: tw, h: th, quality: s.quality })
        : await rescale(src, { mode: 'fit', w: Math.max(tw, th), quality: s.quality });
    idbPut('scaled', key, out);
    return out;
}

function ensureLayer() {
    if (state.layerA && state.layerA.isConnected) return;
    let wrap = document.getElementById('bglite_layer');
    if (!wrap) {
        wrap = document.createElement('div');
        wrap.id = 'bglite_layer';
        document.body.appendChild(wrap);
    }
    wrap.replaceChildren();
    state.layerA = document.createElement('div');
    state.layerB = document.createElement('div');
    state.layerA.className = state.layerB.className = 'bglite-bg';
    wrap.append(state.layerA, state.layerB);
    state.active = state.layerA;
    state.shownKey = '';
    state.objUrl = null;
}

/** 把某个背景上屏。name 为空即清空。 */
async function applyBackground(name, { force = false } = {}) {
    ensureLayer();
    const s = settings();
    name = name || '';
    const key = name ? layerKey(name) : '';
    if (!force && key === state.shownKey) { refreshBadges(); return; }

    const seq = ++state.seq;
    const prev = state.active;
    const next = prev === state.layerA ? state.layerB : state.layerA;
    next.className = `bglite-bg fit-${s.fit}`;
    next.replaceChildren();
    next.style.backgroundImage = '';
    let url = null;

    try {
        if (name && isVideo(name)) {
            const v = document.createElement('video');
            v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true;
            v.setAttribute('playsinline', ''); v.setAttribute('muted', '');
            v.src = bgUrl(name);
            next.appendChild(v);
            await new Promise((resolve) => {
                const t = setTimeout(resolve, 4000);
                v.addEventListener('canplay', () => { clearTimeout(t); resolve(); }, { once: true });
                v.addEventListener('error', () => { clearTimeout(t); resolve(); }, { once: true });
            });
            if (seq !== state.seq) return;
            v.play().catch(() => {});
        } else if (name && (!s.maxEdge || NO_SCALE_EXT.test(name) || state.animated.has(name))) {
            const direct = bgUrl(name);
            await loadImg(direct);
            if (seq !== state.seq) return;
            next.style.backgroundImage = `url("${direct}")`;
        } else if (name) {
            const blob = await getScaledBlob(name);
            url = URL.createObjectURL(blob);
            await loadImg(url);
            if (seq !== state.seq) { URL.revokeObjectURL(url); return; }
            next.style.backgroundImage = `url("${url}")`;
        }

        state.active = next;
        state.shown = name;
        state.shownKey = key;
        if (name) next.classList.add('on');
        prev.classList.remove('on');

        const prevUrl = state.objUrl;
        state.objUrl = url;
        const release = () => {
            if (state.active !== prev) {
                prev.style.backgroundImage = '';
                for (const ov of prev.querySelectorAll('video')) { try { ov.pause(); ov.removeAttribute('src'); ov.load(); } catch { /* ignore */ } }
                prev.replaceChildren();
            }
            if (prevUrl) URL.revokeObjectURL(prevUrl);
        };
        if (s.fade) setTimeout(release, 420); else release();
        refreshBadges();
    } catch (e) {
        if (url) URL.revokeObjectURL(url);
        console.error(TAG, '背景应用失败：', name, e);
        toast.err(`背景加载失败：${name}`);
    }
}

/* ────────────────────────── 当前背景 / 锁定 ────────────────────────── */

const chatMeta = () => ctx().chatMetadata || {};
const hasChat = () => { try { return !!ctx().getCurrentChatId(); } catch { return false; } };

function getChatLock() {
    const m = chatMeta();
    if (typeof m[META_KEY] === 'string' && m[META_KEY]) return m[META_KEY];
    const nat = m[NATIVE_META_KEY];
    if (typeof nat === 'string') {
        const mm = nat.match(/backgrounds\/([^"')]+)/);
        if (mm) { try { return decodeURIComponent(mm[1]); } catch { return mm[1]; } }
    }
    return '';
}

async function setChatLock(name) {
    const m = chatMeta();
    if (name) m[META_KEY] = name;
    else { delete m[META_KEY]; delete m[NATIVE_META_KEY]; }
    try { await ctx().saveMetadata(); } catch (e) { console.warn(TAG, '保存聊天元数据失败', e); }
}

const resolveName = () => getChatLock() || settings().current || '';

async function selectBackground(name) {
    const s = settings();
    if (hasChat() && getChatLock()) await setChatLock(name);
    else { s.current = name; saveSettings(); }
    await applyBackground(name);
    if (s.syncNative && name) {
        try { await ctx().executeSlashCommandsWithOptions(`/bg ${name}`); }
        catch (e) { console.warn(TAG, '同步原生背景失败', e); }
    }
}

async function clearBackground() {
    const s = settings();
    if (hasChat() && getChatLock()) await setChatLock('');
    s.current = '';
    saveSettings();
    await applyBackground('');
}

async function lockChat(name) {
    if (!hasChat()) { toast.warn('先打开一个聊天再锁定'); return; }
    if (!name) { toast.warn('当前没有背景可锁定'); return; }
    await setChatLock(name);
    await applyBackground(name);
    refreshBadges();
    toast.ok('已锁定到本聊天');
}

async function unlockChat() {
    if (!hasChat()) return;
    await setChatLock('');
    await applyBackground(resolveName());
    refreshBadges();
    toast.ok('已解除锁定');
}

function onChatChanged() {
    if (!settings().enabled) return;
    applyBackground(resolveName());
    refreshBadges();
}

/* ────────────────────────── 缩略图加载 ────────────────────────── */

function videoThumb(url, revoke = false) {
    return new Promise((resolve) => {
        const v = document.createElement('video');
        v.muted = true; v.playsInline = true; v.preload = 'auto';
        v.setAttribute('playsinline', ''); v.setAttribute('muted', '');
        let finished = false;
        const done = (blob) => {
            if (finished) return;
            finished = true;
            try { v.removeAttribute('src'); v.load(); } catch { /* ignore */ }
            if (revoke) URL.revokeObjectURL(url);
            resolve(blob);
        };
        const timer = setTimeout(() => done(null), 8000);
        v.addEventListener('loadeddata', () => {
            try { v.currentTime = Math.min(0.5, (v.duration || 1) / 2); } catch { done(null); }
        }, { once: true });
        v.addEventListener('seeked', () => {
            try {
                const sc = Math.min(1, settings().thumbWidth / (v.videoWidth || 1));
                const c = document.createElement('canvas');
                c.width = Math.max(1, Math.round(v.videoWidth * sc));
                c.height = Math.max(1, Math.round(v.videoHeight * sc));
                c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
                c.toBlob((b) => { clearTimeout(timer); done(b); }, 'image/jpeg', 0.8);
            } catch { clearTimeout(timer); done(null); }
        }, { once: true });
        v.addEventListener('error', () => { clearTimeout(timer); done(null); }, { once: true });
        v.src = url;
    });
}

/** 生成缩略图 Blob；返回 null 表示没有可用缩略图（显示占位图标） */
async function makeThumb(name, fileBlob = null) {
    const s = settings();
    if (isVideo(name)) {
        return fileBlob ? await videoThumb(URL.createObjectURL(fileBlob), true) : await videoThumb(bgUrl(name));
    }
    let blob = fileBlob;
    if (!blob) {
        if (s.thumbSource !== 'original') {
            try {
                const r = await fetch(thumbUrl(name));
                if (r.ok) {
                    const b = await r.blob();
                    if (b.size > 0 && (b.type === '' || b.type.startsWith('image/'))) blob = b;
                }
            } catch { /* 走原图 */ }
        }
        if (!blob) blob = await fetchBlob(bgUrl(name));
    }
    // 服务端缩略图可能只是原图兜底：体积大就自己缩
    if (fileBlob || blob.size > THUMB_PASSTHROUGH_BYTES) {
        blob = await rescale(blob, { mode: 'fit', w: s.thumbWidth, quality: 0.8 });
    }
    return blob;
}

function showThumb(cell, blob) {
    const box = cell.querySelector('.bglite-thumb');
    box.replaceChildren();
    if (!(blob instanceof Blob)) {
        const ph = document.createElement('i');
        ph.className = 'ph fa-solid ' + (isVideo(cell.dataset.name) ? 'fa-film' : 'fa-image');
        box.appendChild(ph);
        cell._loaded = true;
        return;
    }
    const url = URL.createObjectURL(blob);
    const img = document.createElement('img');
    img.decoding = 'async';
    img.alt = '';
    img.draggable = false;
    img.src = url;
    cell._url = url;
    box.appendChild(img);
    cell._loaded = true;
}

function unloadThumb(cell) {
    if (!cell._loaded) return;
    cell.querySelector('.bglite-thumb').replaceChildren();
    if (cell._url) { URL.revokeObjectURL(cell._url); cell._url = null; }
    cell._loaded = false;
}

async function loadThumb(cell) {
    if (cell._loaded || cell._loading) return;
    if ((cell._fails || 0) >= 2) return;
    cell._loading = true;
    const name = cell.dataset.name;
    try {
        let blob = await idbGet('thumbs', name);
        if (blob === undefined) {
            blob = await state.queue.add(async () => {
                if (!cell.isConnected || cell.dataset.want !== '1') return undefined; // 已滚走，不白做
                return await makeThumb(name);
            });
            if (blob !== undefined) idbPut('thumbs', name, blob === null ? 'none' : blob);
        }
        if (blob === undefined) return;
        if (!cell.isConnected || cell.dataset.want !== '1') return;
        cell.classList.remove('is-error');
        showThumb(cell, blob);
    } catch (e) {
        cell._fails = (cell._fails || 0) + 1;
        cell.classList.add('is-error');
        console.warn(TAG, '缩略图失败：', name, e);
    } finally {
        cell._loading = false;
    }
}

function onIntersect(entries) {
    for (const en of entries) {
        const cell = en.target;
        if (en.isIntersecting) { cell.dataset.want = '1'; loadThumb(cell); }
        else { cell.dataset.want = '0'; unloadThumb(cell); }
    }
}

/* ────────────────────────── 列表 / 格子 ────────────────────────── */

function makeCell(name) {
    const cell = document.createElement('div');
    cell.className = 'bglite-cell';
    cell.dataset.name = name;
    cell.dataset.want = '0';
    cell.title = name;
    cell.innerHTML = '<div class="bglite-thumb"></div><div class="bglite-check"></div><div class="bglite-badges"></div><button type="button" class="bglite-more" title="更多">&#8943;</button><div class="bglite-name"></div>';
    cell.querySelector('.bglite-name').textContent = displayName(name);
    if (isVideo(name)) cell.classList.add('is-video');
    state.io.observe(cell);
    return cell;
}

function addCell(name) {
    if (state.cells.has(name)) return state.cells.get(name);
    const cell = makeCell(name);
    state.cells.set(name, cell);
    state.ui.grid.appendChild(cell);
    return cell;
}

function removeCell(name) {
    const cell = state.cells.get(name);
    if (!cell) return;
    state.io.unobserve(cell);
    unloadThumb(cell);
    cell.remove();
    state.cells.delete(name);
    state.selected.delete(name);
}

function sortedNames() {
    const arr = [...state.cells.keys()].sort(naturalCompare);
    return settings().sortDesc ? arr.reverse() : arr;
}

function resortGrid() {
    const grid = state.ui.grid;
    // 只挪位置不对的格子：整体重新 append 会让 IntersectionObserver 把所有缩略图卸了再装一遍，每传一张闪一下
    sortedNames().forEach((n, i) => {
        const cell = state.cells.get(n);
        if (grid.children[i] !== cell) grid.insertBefore(cell, grid.children[i] || null);
    });
}

function applyFilter() {
    const q = state.filter.trim().toLowerCase();
    let shown = 0;
    for (const [n, cell] of state.cells) {
        const hit = !q || n.toLowerCase().includes(q);
        cell.hidden = !hit;
        if (hit) shown++;
    }
    state.ui.empty.hidden = state.cells.size > 0;
    updateCount(shown);
}

function updateCount(shown) {
    const total = state.cells.size;
    if (shown === undefined) shown = [...state.cells.values()].filter((c) => !c.hidden).length;
    state.ui.count.textContent = shown === total ? `共 ${total} 张` : `${shown} / ${total} 张`;
}

function refreshBadges() {
    if (!state.ui) return;
    const lock = getChatLock();
    for (const [n, cell] of state.cells) {
        cell.classList.toggle('is-current', n === state.shown && !!n);
        const badges = cell.querySelector('.bglite-badges');
        badges.replaceChildren();
        if (n === lock) {
            const i = document.createElement('i');
            i.className = 'fa-solid fa-lock';
            i.title = '已锁定到本聊天';
            badges.appendChild(i);
        }
    }
    const btn = state.ui.lockBtn;
    const locked = !!lock;
    btn.classList.toggle('active', locked);
    btn.querySelector('i').className = locked ? 'fa-solid fa-lock' : 'fa-solid fa-lock-open';
    btn.querySelector('span').textContent = locked ? '已锁定本聊天' : '锁定到本聊天';
}

/**
 * 解析原生 /api/backgrounds/all 的返回，三种格式都认：
 *  - 1.13.0 及更早：["a.jpg", ...]
 *  - 1.13.1 起：{ images: ["a.jpg", ...], config }
 *  - 1.16 起：{ images: [{ filename, isAnimated }, ...], config }
 * 认不出来就抛错，宁可报错也不要把列表当成空的（否则上传完一刷新，格子全没了）。
 */
function parseListResponse(data) {
    const raw = Array.isArray(data) ? data : (Array.isArray(data?.images) ? data.images : null);
    if (!raw) throw new Error('背景列表格式无法识别，可能酒馆版本太新或太旧');
    const names = [];
    const animated = new Set();
    for (const it of raw) {
        const name = typeof it === 'string' ? it : String((it && (it.filename || it.name || it.file)) || '');
        if (!name || name.startsWith('__')) continue; // __transparent.png 是原生"无背景"的占位图
        names.push(name);
        if (it && typeof it === 'object' && it.isAnimated) animated.add(name);
    }
    return { names, animated };
}

async function fetchList() {
    const r = await fetch('/api/backgrounds/all', { method: 'POST', headers: ctx().getRequestHeaders(), body: '{}' });
    if (!r.ok) throw new Error(`获取背景列表失败 HTTP ${r.status}`);
    return parseListResponse(await r.json());
}

async function refreshList() {
    const { names, animated } = await fetchList();
    state.animated = animated;
    const set = new Set(names);
    for (const n of [...state.cells.keys()]) if (!set.has(n)) removeCell(n);
    for (const n of names) addCell(n);
    state.names = names;
    resortGrid();
    applyFilter();
    refreshBadges();
    updateBatchBar();
    return names;
}

/* ────────────────────────── 批量选择 ────────────────────────── */

function setBatch(on) {
    state.batch = on;
    state.ui.grid.classList.toggle('batch', on);
    state.ui.batchBtn.classList.toggle('active', on);
    if (!on) {
        state.selected.clear();
        for (const cell of state.cells.values()) cell.classList.remove('selected');
    }
    updateBatchBar();
}

function toggleSelect(cell, force) {
    const name = cell.dataset.name;
    const on = force === undefined ? !state.selected.has(name) : force;
    if (on) state.selected.add(name); else state.selected.delete(name);
    cell.classList.toggle('selected', on);
    updateBatchBar();
}

function updateBatchBar() {
    if (!state.ui) return;
    state.ui.batchBar.hidden = !state.batch;
    state.ui.selCount.textContent = String(state.selected.size);
}

/* ────────────────────────── 增 / 删 / 改 ────────────────────────── */

async function confirmPopup(html, okButton = '确定') {
    const c = ctx();
    if (c.callGenericPopup && c.POPUP_TYPE) {
        const r = await c.callGenericPopup(html, c.POPUP_TYPE.CONFIRM, '', { okButton, cancelButton: '取消' });
        return r === true || r === 1 || (c.POPUP_RESULT && r === c.POPUP_RESULT.AFFIRMATIVE);
    }
    return window.confirm(html.replace(/<[^>]+>/g, ''));
}

async function inputPopup(html, value) {
    const c = ctx();
    if (c.callGenericPopup && c.POPUP_TYPE) {
        const r = await c.callGenericPopup(html, c.POPUP_TYPE.INPUT, value, { okButton: '确定', cancelButton: '取消' });
        return typeof r === 'string' ? r : null;
    }
    return window.prompt(html.replace(/<[^>]+>/g, ''), value);
}

async function deleteBackgrounds(names) {
    names = [...new Set(names)].filter((n) => state.cells.has(n));
    if (!names.length) return;
    const msg = names.length === 1
        ? `删除背景「${escapeHtml(names[0])}」？`
        : `删除选中的 ${names.length} 张背景？`;
    if (!(await confirmPopup(`${msg}<br><small>文件会从服务器移除，不可恢复。</small>`, '删除'))) return;

    let ok = 0, fail = 0;
    for (const n of names) {
        try {
            const r = await fetch('/api/backgrounds/delete', {
                method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify({ bg: n }),
            });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            removeCell(n);
            state.animated.delete(n);
            await purgeCache(n);
            const s = settings();
            if (s.current === n) { s.current = ''; saveSettings(); }
            if (chatMeta()[META_KEY] === n) await setChatLock('');
            if (state.shown === n) await applyBackground(resolveName());
            ok++;
        } catch (e) {
            fail++;
            console.error(TAG, '删除失败：', n, e);
        }
    }
    state.names = state.names.filter((n) => state.cells.has(n));
    applyFilter();
    updateBatchBar();
    if (fail) toast.err(`删除完成：成功 ${ok}，失败 ${fail}`); else toast.ok(`已删除 ${ok} 张`);
}

async function renameBackground(oldName) {
    const ext = (oldName.match(/\.[^.]+$/) || [''])[0];
    let input = await inputPopup(`重命名「${escapeHtml(oldName)}」`, displayName(oldName));
    if (input == null) return;
    input = input.trim().replace(/[\\/:*?"<>|]/g, '_');
    if (!input) return;
    const newName = /\.[^.]+$/.test(input) ? input : input + ext;
    if (newName === oldName) return;
    if (state.cells.has(newName)) { toast.err('已有同名文件'); return; }

    const r = await fetch('/api/backgrounds/rename', {
        method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify({ old_bg: oldName, new_bg: newName }),
    });
    if (!r.ok) { toast.err(`重命名失败 HTTP ${r.status}`); return; }

    await migrateCache(oldName, newName);
    const cell = state.cells.get(oldName);
    if (cell) {
        state.cells.delete(oldName);
        cell.dataset.name = newName;
        cell.title = newName;
        cell.querySelector('.bglite-name').textContent = displayName(newName);
        cell.classList.toggle('is-video', isVideo(newName));
        state.cells.set(newName, cell);
    }
    if (state.selected.delete(oldName)) state.selected.add(newName);
    if (state.animated.delete(oldName)) state.animated.add(newName);
    state.names = state.names.map((n) => (n === oldName ? newName : n));
    const s = settings();
    if (s.current === oldName) { s.current = newName; saveSettings(); }
    if (chatMeta()[META_KEY] === oldName) await setChatLock(newName);
    if (state.shown === oldName) { state.shown = newName; state.shownKey = layerKey(newName); }
    resortGrid();
    applyFilter();
    refreshBadges();
    toast.ok('已重命名');
}

/**
 * 酒馆的背景列表只收录图片（服务端按 MIME 过滤），视频文件传上去也不会出现在列表里。
 * 跟原生上传一样：装了官方 Video Background Loader 扩展就转成动态 WebP，没装就提示并跳过。
 */
async function convertVideoForUpload(file) {
    const convert = globalThis.convertVideoToAnimatedWebp;
    if (typeof convert !== 'function') {
        toast.warn(`「${file.name}」是视频，酒馆的背景列表只收录图片。装上官方 Video Background Loader 扩展后，小帷会在上传时自动转成动态 WebP。`, { timeOut: 12000 });
        return null;
    }
    const buffer = await convert({ buffer: new Uint8Array(await file.arrayBuffer()), name: file.name });
    return {
        blob: new Blob([new Uint8Array(buffer)], { type: 'image/webp' }),
        filename: file.name.replace(/\.[^.]+$/, '') + '.webp',
    };
}

async function uploadFiles(files) {
    const list = Array.from(files || []).filter((f) => f && f.size > 0);
    if (!list.length) return;
    const s = settings();
    const total = list.length;
    let done = 0, fail = 0, skipped = 0;
    const uploaded = [];
    const $progress = toast.info(`上传中 0/${total}`, { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false });
    const setProgress = (t) => { try { $progress.find('.toast-message').text(t); } catch { /* ignore */ } };
    const q = new Queue(2);

    await Promise.all(list.map((file) => q.add(async () => {
        try {
            let blob = file;
            let filename = file.name;
            if (file.type.startsWith('video/') || VIDEO_EXT.test(file.name)) {
                const converted = await convertVideoForUpload(file);
                if (!converted) { skipped++; return; }
                blob = converted.blob;
                filename = converted.filename;
            } else if (s.compressUpload && file.type.startsWith('image/') && !NO_SCALE_EXT.test(file.name) && !/svg/i.test(file.type)) {
                const dims = await sniffDims(file).catch(() => null);
                const big = file.size > 1.5 * 1024 * 1024 || (dims && Math.max(dims.w, dims.h) > s.uploadMaxEdge);
                if (big && !dims?.animated) { // 动图压了就不动了，原样上传
                    blob = await rescale(file, { mode: 'fit', w: s.uploadMaxEdge, quality: s.uploadQuality });
                    filename = filename.replace(/\.[^.]+$/, '') + '.jpg';
                }
            }
            const fd = new FormData();
            fd.append('avatar', blob, filename);
            const headers = ctx().getRequestHeaders();
            delete headers['Content-Type'];
            const r = await fetch('/api/backgrounds/upload', { method: 'POST', headers, body: fd, cache: 'no-cache' });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            let saved = (await r.text()).trim();
            if (!saved || saved.length > 255 || /[\\/]/.test(saved) || saved === 'ok') saved = filename;
            // 手里就有文件，顺手把缩略图做了，省一次下载
            await purgeCache(saved);
            const thumb = await makeThumb(saved, blob).catch(() => null);
            await idbPut('thumbs', saved, thumb === null ? 'none' : thumb);
            const cell = addCell(saved);
            unloadThumb(cell);
            cell._fails = 0;
            cell.classList.remove('is-error');
            if (cell.dataset.want === '1') loadThumb(cell); // 同名覆盖且格子还在视口里：立刻换上新缩略图
            uploaded.push(saved);
            done++;
        } catch (e) {
            fail++;
            console.error(TAG, '上传失败：', file.name, e);
        } finally {
            setProgress(`上传中 ${done + fail + skipped}/${total}`);
        }
    })));

    try { toastr.clear($progress); } catch { /* ignore */ }
    let listed = null;
    try { listed = new Set(await refreshList()); } catch (e) { console.warn(TAG, e); resortGrid(); applyFilter(); }
    const missing = listed ? uploaded.filter((n) => !listed.has(n)) : [];
    if (state.shown && uploaded.includes(state.shown)) await applyBackground(state.shown, { force: true });
    if (missing.length) toast.warn(`已传到服务器，但酒馆的背景列表没有收录：${missing.join('、')}`, { timeOut: 12000 });
    const parts = [`成功 ${done}`];
    if (fail) parts.push(`失败 ${fail}`);
    if (skipped) parts.push(`跳过 ${skipped}`);
    if (fail) toast.err(`上传完成：${parts.join('，')}`);
    else if (skipped) toast.warn(`上传完成：${parts.join('，')}`);
    else toast.ok(`已上传 ${done} 张`);
}

/* ────────────────────────── 右键 / 更多菜单 ────────────────────────── */

let menuEl = null;
const onDocPointerDown = (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); };
function closeMenu() {
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    if (menuEl) { menuEl.remove(); menuEl = null; }
}

function openMenu(cell, x, y) {
    closeMenu();
    const name = cell.dataset.name;
    const locked = getChatLock() === name;
    const items = [
        ['fa-image', '设为背景', () => selectBackground(name)],
        [locked ? 'fa-lock-open' : 'fa-lock', locked ? '解除本聊天锁定' : '锁定到本聊天', () => (locked ? unlockChat() : lockChat(name))],
        ['fa-pen', '重命名', () => renameBackground(name)],
        ['fa-copy', '复制文件名', () => navigator.clipboard?.writeText(name).then(() => toast.ok('已复制文件名'), () => toast.err('复制失败'))],
        ['fa-trash', '删除', () => deleteBackgrounds([name]), 'danger'],
    ];
    menuEl = document.createElement('div');
    menuEl.className = 'bglite-menu';
    // 菜单挂在 body 上、不在抽屉里。酒馆会把抽屉外的 touchstart / mousedown 当成"点了外面"把抽屉收起来，
    // 手机上点一下「删除」抽屉就没了，确认完还得重新打开。拦住这两个事件，别让它冒泡到酒馆那里。
    for (const type of ['touchstart', 'mousedown']) menuEl.addEventListener(type, (e) => e.stopPropagation());
    for (const [icon, label, fn, cls] of items) {
        const it = document.createElement('div');
        it.className = cls || '';
        it.innerHTML = `<i class="fa-solid ${icon}"></i><span></span>`;
        it.querySelector('span').textContent = label;
        it.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); fn(); });
        menuEl.appendChild(it);
    }
    document.body.appendChild(menuEl);
    const w = menuEl.offsetWidth, h = menuEl.offsetHeight;
    menuEl.style.left = `${Math.max(6, Math.min(x, window.innerWidth - w - 6))}px`;
    menuEl.style.top = `${Math.max(6, Math.min(y, window.innerHeight - h - 6))}px`;
    setTimeout(() => { if (menuEl) document.addEventListener('pointerdown', onDocPointerDown, true); }, 0);
}

/* ────────────────────────── 面板 ────────────────────────── */

const PANEL_HTML = `
<div class="bglite-bar">
  <input type="search" class="text_pole bglite-filter" placeholder="搜索文件名…" autocomplete="off">
  <div class="menu_button bglite-btn" data-act="sort" title="排序"><i class="fa-solid fa-arrow-down-a-z"></i></div>
  <div class="menu_button bglite-btn" data-act="refresh" title="刷新列表"><i class="fa-solid fa-rotate"></i></div>
</div>
<div class="bglite-bar">
  <label class="menu_button bglite-btn" title="上传背景（可多选）"><i class="fa-solid fa-upload"></i><span>上传</span><input type="file" class="bglite-file" multiple accept="image/*,video/mp4,video/webm" hidden></label>
  <div class="menu_button bglite-btn" data-act="batch" title="批量选择（长按格子也可以）"><i class="fa-regular fa-square-check"></i><span>批量</span></div>
  <div class="menu_button bglite-btn bglite-lock" data-act="lock"><i class="fa-solid fa-lock-open"></i><span>锁定到本聊天</span></div>
  <div class="menu_button bglite-btn" data-act="clear" title="不使用背景"><i class="fa-solid fa-eraser"></i><span>无背景</span></div>
  <span class="bglite-count"></span>
</div>
<div class="bglite-batchbar" hidden>
  <div class="menu_button bglite-btn" data-act="selall">全选</div>
  <div class="menu_button bglite-btn" data-act="selinv">反选</div>
  <div class="menu_button bglite-btn bglite-danger" data-act="delsel"><i class="fa-solid fa-trash"></i><span>删除所选 (<b class="bglite-selcount">0</b>)</span></div>
  <div class="menu_button bglite-btn" data-act="batchoff">退出批量</div>
</div>
<div class="bglite-grid"></div>
<div class="bglite-empty" hidden>还没有背景，点「上传」添加。</div>
`;

function mountPanel() {
    const drawer = document.getElementById('Backgrounds')
        || document.getElementById('bg_menu_content')?.closest('.drawer-content');
    if (!drawer) throw new Error('找不到背景面板容器 #Backgrounds');

    const root = document.createElement('div');
    root.id = 'bglite_root';
    root.innerHTML = PANEL_HTML;
    drawer.prepend(root);

    const ui = state.ui = {
        root,
        grid: root.querySelector('.bglite-grid'),
        filter: root.querySelector('.bglite-filter'),
        count: root.querySelector('.bglite-count'),
        empty: root.querySelector('.bglite-empty'),
        batchBar: root.querySelector('.bglite-batchbar'),
        batchBtn: root.querySelector('[data-act="batch"]'),
        lockBtn: root.querySelector('.bglite-lock'),
        selCount: root.querySelector('.bglite-selcount'),
        file: root.querySelector('.bglite-file'),
    };
    root.style.setProperty('--bglite-cell', `${settings().cellMin}px`);
    if (isTouch()) ui.grid.classList.add('touch');

    state.io = new IntersectionObserver(onIntersect, { root: null, rootMargin: '300px 0px', threshold: 0 });
    state.queue = new Queue(isMobileLike() ? 2 : 4);

    // 工具栏
    let filterTimer = null;
    ui.filter.addEventListener('input', () => {
        clearTimeout(filterTimer);
        filterTimer = setTimeout(() => { state.filter = ui.filter.value; applyFilter(); }, 120);
    });
    root.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn || !root.contains(btn)) return;
        const act = btn.dataset.act;
        try {
            switch (act) {
                case 'sort': {
                    const s = settings();
                    s.sortDesc = !s.sortDesc; saveSettings();
                    btn.querySelector('i').className = s.sortDesc ? 'fa-solid fa-arrow-up-z-a' : 'fa-solid fa-arrow-down-a-z';
                    resortGrid();
                    break;
                }
                case 'refresh':
                    btn.classList.add('spinning');
                    await refreshList().catch((err) => toast.err(err.message));
                    btn.classList.remove('spinning');
                    break;
                case 'batch': setBatch(!state.batch); break;
                case 'batchoff': setBatch(false); break;
                case 'lock': getChatLock() ? await unlockChat() : await lockChat(state.shown); break;
                case 'clear': await clearBackground(); break;
                case 'selall':
                    for (const cell of state.cells.values()) if (!cell.hidden) toggleSelect(cell, true);
                    break;
                case 'selinv':
                    for (const cell of state.cells.values()) if (!cell.hidden) toggleSelect(cell);
                    break;
                case 'delsel':
                    await deleteBackgrounds([...state.selected]);
                    break;
                default: break;
            }
        } catch (err) {
            console.error(TAG, err);
            toast.err(err?.message || String(err));
        }
    });
    ui.file.addEventListener('change', async () => {
        const files = Array.from(ui.file.files || []); // 先拷出来，重置 value 会清空 FileList
        ui.file.value = '';
        await uploadFiles(files);
    });
    root.querySelector('[data-act="sort"] i').className = settings().sortDesc ? 'fa-solid fa-arrow-up-z-a' : 'fa-solid fa-arrow-down-a-z';

    // 格子：点击 / 更多 / 右键 / 长按
    let suppressClick = false;
    let lp = null;
    ui.grid.addEventListener('click', (e) => {
        if (suppressClick) { suppressClick = false; e.preventDefault(); e.stopPropagation(); return; }
        const cell = e.target.closest('.bglite-cell');
        if (!cell) return;
        if (e.target.closest('.bglite-more')) {
            e.stopPropagation();
            const r = e.target.closest('.bglite-more').getBoundingClientRect();
            openMenu(cell, r.left, r.bottom + 4);
            return;
        }
        if (state.batch) { toggleSelect(cell); return; }
        selectBackground(cell.dataset.name);
    });
    ui.grid.addEventListener('contextmenu', (e) => {
        const cell = e.target.closest('.bglite-cell');
        if (!cell) return;
        e.preventDefault();
        openMenu(cell, e.clientX, e.clientY);
    });
    ui.grid.addEventListener('pointerdown', (e) => {
        const cell = e.target.closest('.bglite-cell');
        if (!cell || e.button !== 0 || e.target.closest('.bglite-more')) return;
        if (lp) clearTimeout(lp.timer);
        lp = {
            cell, sx: e.clientX, sy: e.clientY, fired: false,
            timer: setTimeout(() => {
                if (!lp) return;
                lp.fired = true;
                if (!state.batch) setBatch(true);
                toggleSelect(cell);
                try { navigator.vibrate && navigator.vibrate(15); } catch { /* ignore */ }
            }, 480),
        };
    });
    const cancelLp = (e) => {
        if (!lp) return;
        if (e.type === 'pointermove' && Math.hypot(e.clientX - lp.sx, e.clientY - lp.sy) < 8) return;
        clearTimeout(lp.timer);
        lp = null;
    };
    ui.grid.addEventListener('pointermove', cancelLp);
    ui.grid.addEventListener('pointercancel', cancelLp);
    ui.grid.addEventListener('pointerleave', cancelLp);
    ui.grid.addEventListener('pointerup', () => {
        if (!lp) return;
        clearTimeout(lp.timer);
        if (lp.fired) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 400); }
        lp = null;
    });
}

/* ────────────────────────── 设置面板 ────────────────────────── */

const SETTINGS_HTML = `
<div class="inline-drawer">
  <div class="inline-drawer-toggle inline-drawer-header">
    <b>小帷 · 背景轻管家</b>
    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
  </div>
  <div class="inline-drawer-content">
    <label class="checkbox_label"><input type="checkbox" data-key="enabled"><span>接管背景面板与背景层（关闭即恢复原生）</span></label>
    <label class="checkbox_label"><input type="checkbox" data-key="fade"><span>切换背景时淡入</span></label>
    <div class="bglite-row"><span>背景长边上限</span>
      <select data-key="maxEdge">
        <option value="1536">1536（最省）</option>
        <option value="2048">2048（推荐）</option>
        <option value="2560">2560</option>
        <option value="3072">3072</option>
        <option value="0">原图直出（不省显存）</option>
      </select></div>
    <div class="bglite-row"><span>适配方式</span>
      <select data-key="fit">
        <option value="cover">铺满裁切</option>
        <option value="contain">完整显示</option>
        <option value="center">原尺寸居中</option>
      </select></div>
    <div class="bglite-row"><span>缩放质量</span><input type="range" min="0.6" max="0.95" step="0.05" data-key="quality"><span class="bglite-val"></span></div>
    <div class="bglite-row"><span>缩略图宽度</span>
      <select data-key="thumbWidth">
        <option value="240">240</option>
        <option value="320">320</option>
        <option value="480">480</option>
      </select></div>
    <div class="bglite-row"><span>缩略图来源</span>
      <select data-key="thumbSource">
        <option value="auto">服务端缩略图可用就用</option>
        <option value="original">总是从原图生成（更清晰）</option>
      </select></div>
    <div class="bglite-row"><span>格子最小宽度</span><input type="number" class="text_pole" min="80" max="320" step="10" data-key="cellMin"></div>
    <hr>
    <label class="checkbox_label"><input type="checkbox" data-key="compressUpload"><span>上传前压缩大图（长边超限或大于 1.5MB 时转 JPEG；动图与视频不处理）</span></label>
    <div class="bglite-row"><span>上传长边上限</span>
      <select data-key="uploadMaxEdge">
        <option value="2048">2048</option>
        <option value="2560">2560</option>
        <option value="3072">3072</option>
        <option value="4096">4096</option>
      </select></div>
    <div class="bglite-row"><span>上传质量</span><input type="range" min="0.7" max="1" step="0.02" data-key="uploadQuality"><span class="bglite-val"></span></div>
    <label class="checkbox_label"><input type="checkbox" data-key="syncNative"><span>选择时同步到原生背景设置（兼容用，会多下载一次原图）</span></label>
    <hr>
    <div class="bglite-row">
      <div class="menu_button" data-act="clear-thumbs">清空缩略图缓存</div>
      <div class="menu_button" data-act="clear-scaled">清空背景缓存</div>
      <span class="bglite-usage"></span>
    </div>
    <small>缓存存在本机浏览器的 IndexedDB 里，按设备各自生成；换设备或清浏览器数据后会重建一次。斜杠命令：<code>/bglite 文件名</code>、<code>/bglite-lock</code>、<code>/bglite-unlock</code>。</small>
  </div>
</div>`;

const NUMERIC_KEYS = new Set(['maxEdge', 'quality', 'thumbWidth', 'cellMin', 'uploadMaxEdge', 'uploadQuality']);

function mountSettings() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) return;
    const wrap = document.createElement('div');
    wrap.id = 'bglite_settings';
    wrap.innerHTML = SETTINGS_HTML;
    host.appendChild(wrap);

    const s = settings();
    const syncVal = (el) => {
        const out = el.parentElement?.querySelector('.bglite-val');
        if (out && el.type === 'range') out.textContent = Number(el.value).toFixed(2);
    };
    wrap.querySelectorAll('[data-key]').forEach((el) => {
        const k = el.dataset.key;
        if (el.type === 'checkbox') el.checked = !!s[k];
        else el.value = String(s[k]);
        syncVal(el);
        if (el.type === 'range') el.addEventListener('input', () => syncVal(el));
        el.addEventListener('change', () => {
            let v = el.type === 'checkbox' ? el.checked : el.value;
            if (NUMERIC_KEYS.has(k)) v = Number(v);
            s[k] = v;
            saveSettings();
            syncVal(el);
            onSettingChanged(k);
        });
    });
    wrap.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        if (btn.dataset.act === 'clear-thumbs') {
            await idbClear('thumbs');
            for (const cell of state.cells.values()) { unloadThumb(cell); cell._fails = 0; cell.classList.remove('is-error'); if (cell.dataset.want === '1') loadThumb(cell); }
            toast.ok('缩略图缓存已清空');
        } else if (btn.dataset.act === 'clear-scaled') {
            await idbClear('scaled');
            if (state.shown) await applyBackground(state.shown, { force: true });
            toast.ok('背景缓存已清空');
        }
        updateUsage();
    });
    updateUsage();
}

async function updateUsage() {
    const el = document.querySelector('#bglite_settings .bglite-usage');
    if (!el) return;
    try {
        const est = await navigator.storage?.estimate?.();
        if (est && est.usage != null) el.textContent = `站点存储约 ${(est.usage / 1024 / 1024).toFixed(1)} MB`;
    } catch { /* ignore */ }
}

function onSettingChanged(key) {
    switch (key) {
        case 'enabled': applyTakeover(); break;
        case 'fade': document.body.classList.toggle('bglite-nofade', !settings().fade); break;
        case 'maxEdge':
        case 'fit':
        case 'quality':
            if (state.shown) applyBackground(state.shown, { force: true });
            break;
        case 'cellMin':
            state.ui?.root.style.setProperty('--bglite-cell', `${Math.max(60, settings().cellMin || 120)}px`);
            break;
        default: break;
    }
}

function applyTakeover() {
    const s = settings();
    document.body.classList.toggle('bglite-on', !!s.enabled);
    document.body.classList.toggle('bglite-nofade', !s.fade);
    if (s.enabled) {
        ensureLayer();
        applyBackground(resolveName());
    } else {
        applyBackground('');
    }
}

/* ────────────────────────── 斜杠命令 ────────────────────────── */

function findName(q) {
    const names = [...state.cells.keys()];
    const lq = q.toLowerCase();
    return names.find((n) => n === q)
        || names.find((n) => n.toLowerCase() === lq)
        || names.find((n) => displayName(n).toLowerCase() === lq)
        || names.find((n) => n.toLowerCase().startsWith(lq))
        || names.find((n) => n.toLowerCase().includes(lq))
        || '';
}

function registerSlash() {
    const c = ctx();
    try {
        const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = c;
        if (!SlashCommandParser?.addCommandObject || !SlashCommand?.fromProps) return;
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'bglite',
            callback: async (_args, value) => {
                const q = String(value || '').trim();
                if (!q) return state.shown;
                const hit = findName(q);
                if (!hit) { toast.err(`没找到背景：${q}`); return ''; }
                await selectBackground(hit);
                return hit;
            },
            unnamedArgumentList: [SlashCommandArgument.fromProps({
                description: '背景文件名（支持部分匹配）',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            })],
            helpString: '用小帷切换背景：<code>/bglite 文件名</code>。不带参数时返回当前背景文件名。',
        }));
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'bglite-lock',
            callback: async () => { await lockChat(state.shown); return ''; },
            helpString: '把当前背景锁定到本聊天。',
        }));
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'bglite-unlock',
            callback: async () => { await unlockChat(); return ''; },
            helpString: '解除本聊天的背景锁定。',
        }));
    } catch (e) {
        console.warn(TAG, '注册斜杠命令失败：', e);
    }
}

/* ────────────────────────── 启动 ────────────────────────── */

let resizeTimer = null;
function onViewportChanged() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        if (settings().enabled && state.shown && !isVideo(state.shown)) applyBackground(state.shown);
    }, 350);
}

jQuery(async () => {
    try {
        settings();
        ensureLayer();
        mountPanel();
        mountSettings();
        registerSlash();

        const c = ctx();
        c.eventSource.on(c.eventTypes.CHAT_CHANGED, onChatChanged);
        if (c.eventTypes.APP_READY) c.eventSource.on(c.eventTypes.APP_READY, () => applyTakeover());
        window.addEventListener('resize', onViewportChanged);
        if (screen.orientation?.addEventListener) screen.orientation.addEventListener('change', onViewportChanged);

        applyTakeover();
        await refreshList();
        applyBackground(resolveName()); // 列表带回了动图标记，当前背景若是动图就改走直出
        console.log(TAG, '就绪，背景', state.cells.size, '张');
    } catch (e) {
        console.error(TAG, '初始化失败：', e);
        try { toast.err(`小帷初始化失败：${e?.message || e}`); } catch { /* ignore */ }
    }
});
