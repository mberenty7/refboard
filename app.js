/* RefBoard — an infinite reference canvas for touch devices.
 * Plain JS, no dependencies. Data lives in IndexedDB on the device. */
(() => {
  'use strict';

  // ---------- Constants ----------
  const MAX_IMPORT_SIDE = 2048;      // downscale big photos on import to save tablet memory
  const Z_MIN = 0.01, Z_MAX = 40;
  const TAP_SLOP = 10;               // px a finger can drift and still count as a tap
  const DOUBLE_TAP_MS = 320;
  const HANDLE_RADIUS = 30;          // touch radius of the resize handle (screen px)
  const ROT_DEADZONE = 8 * Math.PI / 180;
  const ROT_SNAP = 4 * Math.PI / 180;
  const BACKGROUNDS = ['#1e1e1e', '#5c5c5c', '#dcdad4'];
  const MODES = ['color', 'gray', 'v3', 'v5'];
  const MODE_LABELS = { color: 'Color', gray: 'Gray', v3: '3 values', v5: '5 values' };
  const GRIDS = [0, 3, 4, 6];
  const SHARE_CACHE = 'refboard-share';

  // ---------- DOM ----------
  const $ = (s) => document.querySelector(s);
  const canvas = $('#board');
  const ctx = canvas.getContext('2d');
  const toolbar = $('#toolbar');
  const selbar = $('#selbar');
  const menu = $('#menu');
  const loupe = $('#loupe');
  const palette = $('#palette');
  const toastEl = $('#toast');

  // ---------- Utils ----------
  const uid = () => (crypto.randomUUID ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const angle = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);

  let toastTimer = 0;
  function toast(msg, ms = 2200) {
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add('hidden'), ms);
  }

  // In-app replacement for prompt()/confirm(). Resolves to the text (or true) on OK, null on cancel.
  function ask(title, { value = null, okLabel = 'OK', danger = false } = {}) {
    const dlg = $('#dialog'), input = $('#dialog-input'), ok = $('#dialog-ok');
    $('#dialog-title').textContent = title;
    input.classList.toggle('hidden', value === null);
    input.value = value || '';
    ok.textContent = okLabel;
    ok.classList.toggle('danger', danger);
    dlg.classList.remove('hidden');
    if (value !== null) setTimeout(() => { input.focus(); input.select(); }, 30);
    return new Promise((resolve) => {
      const done = (result) => {
        dlg.classList.add('hidden');
        $('#dialog-form').onsubmit = $('#dialog-cancel').onclick = dlg.onclick = null;
        resolve(result);
      };
      $('#dialog-form').onsubmit = (e) => { e.preventDefault(); done(value === null ? true : input.value); };
      $('#dialog-cancel').onclick = () => done(null);
      dlg.onclick = (e) => { if (e.target === dlg) done(null); };
    });
  }

  // ---------- IndexedDB ----------
  let dbp = null;
  function db() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open('refboard', 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          d.createObjectStore('boards', { keyPath: 'id' });
          d.createObjectStore('images', { keyPath: 'id' });
          d.createObjectStore('meta');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbp;
  }
  async function tx(store, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const r = fn(t.objectStore(store));
      t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  const idbGet = (store, key) => tx(store, 'readonly', (s) => s.get(key));
  const idbGetAll = (store) => tx(store, 'readonly', (s) => s.getAll());
  const idbGetAllKeys = (store) => tx(store, 'readonly', (s) => s.getAllKeys());
  const idbPut = (store, val, key) => tx(store, 'readwrite', (s) => s.put(val, key));
  const idbDel = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));

  // ---------- State ----------
  let W = 0, H = 0, dpr = 1;
  let board = null;                 // { id, name, items, view, bg, palette, updated }
  let selectedId = null;
  const ui = { gray: false, squint: false, pick: false, lockall: false, wake: false };
  const images = new Map();         // imgId -> { bmp, w, h } | { loading: Promise }
  const variants = new Map();       // `${imgId}|${mode}` -> { levels: [{src,w,h}], ready }
  const samplers = new Map();       // imgId -> ImageData (≤1024px) for the color picker
  let undoStack = [], redoStack = [];

  const view = () => board.view;
  const selected = () => board && board.items.find((i) => i.id === selectedId) || null;
  const movable = (item) => item && !item.locked && !ui.lockall;

  // ---------- Coordinates ----------
  const toWorld = (p) => ({ x: (p.x - view().x) / view().z, y: (p.y - view().y) / view().z });
  const toScreen = (w) => ({ x: w.x * view().z + view().x, y: w.y * view().z + view().y });

  function toLocal(item, wx, wy) {
    const dx = wx - item.x, dy = wy - item.y;
    const c = Math.cos(item.r), s = Math.sin(item.r);
    let lx = (dx * c + dy * s) / item.s;
    const ly = (-dx * s + dy * c) / item.s;
    if (item.flip) lx = -lx;
    return { x: lx, y: ly };
  }
  function corners(item) {
    const c = Math.cos(item.r), s = Math.sin(item.r);
    const hw = item.w * item.s / 2, hh = item.h * item.s / 2;
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => ({
      x: item.x + x * c - y * s,
      y: item.y + x * s + y * c,
    }));
  }
  function hitTest(w) {
    for (let i = board.items.length - 1; i >= 0; i--) {
      const it = board.items[i];
      const l = toLocal(it, w.x, w.y);
      if (Math.abs(l.x) <= it.w / 2 && Math.abs(l.y) <= it.h / 2) return it;
    }
    return null;
  }
  function handlePos(item) { return toScreen(corners(item)[2]); }

  // ---------- Image loading & processing ----------
  function ensureImage(imgId) {
    const cur = images.get(imgId);
    if (cur) return cur.loading || Promise.resolve(cur);
    const loading = (async () => {
      const rec = await idbGet('images', imgId);
      if (!rec) { images.set(imgId, { missing: true }); return null; }
      const bmp = await createImageBitmap(rec.blob);
      const entry = { bmp, w: bmp.width, h: bmp.height };
      images.set(imgId, entry);
      requestRender();
      return entry;
    })().catch((err) => { console.error(err); images.set(imgId, { missing: true }); return null; });
    images.set(imgId, { loading });
    return loading;
  }

  // sRGB <-> linear helpers for value (lightness) calculations
  const LIN = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  const encodeSRGB = (y) => 255 * (y <= 0.0031308 ? 12.92 * y : 1.055 * Math.pow(y, 1 / 2.4) - 0.055);
  const lstar = (y) => (y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y);
  const yFromL = (l) => (l > 8 ? Math.pow((l + 16) / 116, 3) : l / 903.3);
  const luminance = (r, g, b) => 0.2126 * LIN[r] + 0.7152 * LIN[g] + 0.0722 * LIN[b];

  function buildLUT(mode) {
    const lut = new Uint8ClampedArray(4096);
    const n = mode === 'v3' ? 3 : mode === 'v5' ? 5 : 0;
    for (let i = 0; i < 4096; i++) {
      const y = i / 4095;
      if (!n) { lut[i] = encodeSRGB(y); continue; }
      const band = Math.min(n - 1, Math.floor(lstar(y) / 100 * n));
      lut[i] = encodeSRGB(yFromL((band + 0.5) * 100 / n));
    }
    return lut;
  }

  async function processImage(bmp, mode) {
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    const img = g.getImageData(0, 0, c.width, c.height);
    const d = img.data, lut = buildLUT(mode);
    for (let i = 0; i < d.length; i += 4) {
      const v = lut[(luminance(d[i], d[i + 1], d[i + 2]) * 4095) | 0];
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    g.putImageData(img, 0, 0);
    return createImageBitmap(c);
  }

  // Each variant keeps a mip pyramid so zoomed-out drawing stays fast and smooth.
  function getVariant(imgId, mode) {
    const key = imgId + '|' + mode;
    let v = variants.get(key);
    if (v) return v;
    v = { levels: [], ready: false };
    variants.set(key, v);
    (async () => {
      const base = await ensureImage(imgId);
      if (!base) return;
      const src = mode === 'color' ? base.bmp : await processImage(base.bmp, mode);
      const levels = [{ src, w: src.width, h: src.height }];
      let w = src.width, h = src.height;
      while (Math.max(w, h) > 48) {
        w = Math.max(1, Math.round(w / 2)); h = Math.max(1, Math.round(h / 2));
        const prev = levels[levels.length - 1].src;
        levels.push({ src: await createImageBitmap(prev, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' }), w, h });
      }
      v.levels = levels;
      v.ready = true;
      requestRender();
    })().catch((err) => console.error('variant', err));
    return v;
  }

  function pickLevel(v, screenLongest) {
    if (ui.squint) return v.levels[v.levels.length - 1];
    let best = v.levels[0];
    for (const l of v.levels) {
      if (Math.max(l.w, l.h) >= screenLongest) best = l; else break;
    }
    return best;
  }

  function effectiveMode(item) {
    return item.mode === 'color' && ui.gray ? 'gray' : item.mode;
  }

  // ---------- Rendering ----------
  let renderQueued = false;
  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(render);
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    requestRender();
  }

  function render() {
    renderQueued = false;
    if (!board) return;
    const v = view();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = board.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    ctx.save();
    ctx.translate(v.x, v.y);
    ctx.scale(v.z, v.z);
    for (const item of board.items) drawItem(item, v.z);
    ctx.restore();

    const sel = selected();
    if (sel) drawSelection(sel);
    $('#empty-hint').classList.toggle('hidden', board.items.length > 0);
  }

  function drawItem(item, z) {
    // Skip items entirely off-screen
    const cs = corners(item).map(toScreen);
    const minX = Math.min(...cs.map((p) => p.x)), maxX = Math.max(...cs.map((p) => p.x));
    const minY = Math.min(...cs.map((p) => p.y)), maxY = Math.max(...cs.map((p) => p.y));
    if (maxX < 0 || maxY < 0 || minX > W || minY > H) return;

    let v = getVariant(item.imgId, effectiveMode(item));
    if (!v.ready) v = getVariant(item.imgId, 'color');

    ctx.save();
    ctx.translate(item.x, item.y);
    ctx.rotate(item.r);
    ctx.scale(item.flip ? -item.s : item.s, item.s);
    if (v.ready) {
      const lvl = pickLevel(v, Math.max(item.w, item.h) * item.s * z * dpr);
      ctx.drawImage(lvl.src, -item.w / 2, -item.h / 2, item.w, item.h);
    } else {
      ctx.fillStyle = 'rgba(128,128,128,0.25)';
      ctx.fillRect(-item.w / 2, -item.h / 2, item.w, item.h);
    }
    if (item.grid) drawGrid(item, z);
    ctx.restore();
  }

  function drawGrid(item, z) {
    const n = item.grid, hw = item.w / 2, hh = item.h / 2;
    const px = 1 / (z * item.s);
    ctx.beginPath();
    for (let i = 1; i < n; i++) {
      const x = -hw + item.w * i / n, y = -hh + item.h * i / n;
      ctx.moveTo(x, -hh); ctx.lineTo(x, hh);
      ctx.moveTo(-hw, y); ctx.lineTo(hw, y);
    }
    ctx.rect(-hw, -hh, item.w, item.h);
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 3 * px;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.2 * px;
    ctx.stroke();
  }

  function drawSelection(item) {
    const cs = corners(item).map(toScreen);
    ctx.beginPath();
    cs.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.lineWidth = 2;
    ctx.strokeStyle = item.locked || ui.lockall ? '#d9a54a' : '#4a90d9';
    ctx.stroke();
    if (movable(item)) {
      const h = cs[2];
      ctx.beginPath();
      ctx.arc(h.x, h.y, 11, 0, Math.PI * 2);
      ctx.fillStyle = '#4a90d9';
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    }
  }

  // ---------- View animation & fitting ----------
  let anim = null;                  // token of the running animation; set to null to cancel
  function animateView(target, ms = 280) {
    const from = { ...view() };
    const t0 = performance.now();
    const token = {};
    anim = token;
    const step = (now) => {
      if (anim !== token) return;
      const t = Math.min(1, (now - t0) / ms);
      const e = 1 - Math.pow(1 - t, 3);
      // Interpolate zoom geometrically so it feels even
      const z = from.z * Math.pow(target.z / from.z, e);
      // Keep the interpolation consistent: lerp the world point at screen center
      const cFrom = { x: (W / 2 - from.x) / from.z, y: (H / 2 - from.y) / from.z };
      const cTo = { x: (W / 2 - target.x) / target.z, y: (H / 2 - target.y) / target.z };
      const cx = cFrom.x + (cTo.x - cFrom.x) * e, cy = cFrom.y + (cTo.y - cFrom.y) * e;
      board.view = { x: W / 2 - cx * z, y: H / 2 - cy * z, z };
      requestRender();
      if (t < 1) requestAnimationFrame(step);
      else { anim = null; board.view = { ...target }; requestRender(); scheduleSave(); }
    };
    requestAnimationFrame(step);
  }

  function boundsOf(items) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const it of items) for (const p of corners(it)) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    return { x0, y0, x1, y1 };
  }

  function fitTo(items, animate = true) {
    if (!items.length) return;
    const b = boundsOf(items);
    const top = 72, bottom = 72, pad = 24;
    const aw = W - pad * 2, ah = H - top - bottom - pad * 2;
    const z = clamp(Math.min(aw / (b.x1 - b.x0 || 1), ah / (b.y1 - b.y0 || 1)), Z_MIN, Z_MAX);
    const target = {
      z,
      x: W / 2 - (b.x0 + b.x1) / 2 * z,
      y: top + (H - top - bottom) / 2 - (b.y0 + b.y1) / 2 * z,
    };
    if (animate) animateView(target); else { board.view = target; requestRender(); }
  }

  // ---------- History ----------
  const snapshot = () => JSON.stringify(board.items);
  function commit(before) {
    if (before === snapshot()) return;
    undoStack.push(before);
    if (undoStack.length > 100) undoStack.shift();
    redoStack = [];
    updateUI();
    scheduleSave();
  }
  function mutate(fn) {
    const before = snapshot();
    fn();
    commit(before);
    requestRender();
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    board.items = JSON.parse(undoStack.pop());
    if (!selected()) selectedId = null;
    afterHistory();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    board.items = JSON.parse(redoStack.pop());
    if (!selected()) selectedId = null;
    afterHistory();
  }
  function afterHistory() {
    board.items.forEach((i) => ensureImage(i.imgId));
    updateUI(); scheduleSave(); requestRender();
  }

  // ---------- Persistence ----------
  let saveTimer = 0;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 400);
  }
  async function saveNow() {
    clearTimeout(saveTimer);
    if (!board) return;
    board.updated = Date.now();
    try { await idbPut('boards', board); } catch (err) { console.error(err); toast('Could not save — storage may be full'); }
  }

  function newBoard(name) {
    return { id: uid(), name, items: [], view: { x: 0, y: 0, z: 1 }, bg: BACKGROUNDS[0], palette: [], updated: Date.now() };
  }

  async function openBoard(b) {
    if (board) await saveNow();
    board = b;
    board.palette = board.palette || [];
    selectedId = null;
    undoStack = []; redoStack = [];
    // Free decoded images that the new board doesn't use
    const used = new Set(board.items.map((i) => i.imgId));
    for (const [key, v] of variants) {
      const imgId = key.slice(0, key.indexOf('|'));
      if (used.has(imgId)) continue;
      const base = images.get(imgId)?.bmp;
      v.levels.forEach((l) => { if (l.src !== base) l.src.close(); });
      variants.delete(key);
    }
    for (const [id, img] of images) {
      if (!used.has(id)) { img.bmp && img.bmp.close(); images.delete(id); samplers.delete(id); }
    }
    board.items.forEach((i) => ensureImage(i.imgId));
    await idbPut('meta', board.id, 'current');
    $('#board-name').textContent = board.name;
    renderPalette();
    updateUI();
    requestRender();
  }

  async function gcImages() {
    const boards = await idbGetAll('boards');
    const used = new Set();
    boards.forEach((b) => b.items.forEach((i) => used.add(i.imgId)));
    const keys = await idbGetAllKeys('images');
    for (const k of keys) if (!used.has(k)) await idbDel('images', k);
  }

  // ---------- Importing images ----------
  async function decodeAndStore(blob) {
    let bmp = await createImageBitmap(blob);
    let out = blob;
    const longest = Math.max(bmp.width, bmp.height);
    if (longest > MAX_IMPORT_SIDE) {
      const k = MAX_IMPORT_SIDE / longest;
      const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
      const small = await createImageBitmap(bmp, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
      bmp.close();
      bmp = small;
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(bmp, 0, 0);
      out = await new Promise((r) => c.toBlob(r, 'image/webp', 0.92)) || blob;
    }
    const id = uid();
    await idbPut('images', { id, blob: out, w: bmp.width, h: bmp.height });
    images.set(id, { bmp, w: bmp.width, h: bmp.height });
    return { id, w: bmp.width, h: bmp.height };
  }

  async function addImages(blobs) {
    blobs = blobs.filter((b) => b && (!b.type || b.type.startsWith('image/')));
    if (!blobs.length) return;
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    toast(blobs.length > 1 ? `Adding ${blobs.length} images…` : 'Adding image…', 10000);
    const added = [];
    for (const b of blobs) {
      try { added.push(await decodeAndStore(b)); }
      catch (err) { console.error(err); toast('One image could not be read (unsupported format?)'); }
    }
    if (!added.length) return;

    // Lay them out in a row centred on the current view
    const z = view().z;
    const target = Math.min(W, H) * (added.length > 1 ? 0.35 : 0.55) / z;
    const gap = 16 / z;
    const sized = added.map((a) => {
      const s = target / Math.max(a.w, a.h);
      return { ...a, s, dw: a.w * s, dh: a.h * s };
    });
    const total = sized.reduce((t, a) => t + a.dw, 0) + gap * (sized.length - 1);
    const center = toWorld({ x: W / 2, y: H / 2 });
    let x = center.x - total / 2;
    const newItems = sized.map((a) => {
      const it = { id: uid(), imgId: a.id, x: x + a.dw / 2, y: center.y, w: a.w, h: a.h, s: a.s, r: 0, flip: false, mode: 'color', grid: 0, locked: false };
      x += a.dw + gap;
      return it;
    });
    mutate(() => board.items.push(...newItems));
    selectedId = newItems[newItems.length - 1].id;
    updateUI();
    await saveNow();
    toast(added.length > 1 ? `Added ${added.length} images` : 'Image added');
    // If the new images are bigger than the screen, frame them
    const b = boundsOf(newItems);
    const tl = toScreen({ x: b.x0, y: b.y0 }), br = toScreen({ x: b.x1, y: b.y1 });
    if (tl.x < 0 || tl.y < 60 || br.x > W || br.y > H - 60) fitTo(newItems);
  }

  async function pasteFromClipboard() {
    if (!navigator.clipboard || !navigator.clipboard.read) {
      toast('Paste needs HTTPS — use + or share images to the app instead');
      return;
    }
    try {
      const items = await navigator.clipboard.read();
      const blobs = [];
      for (const it of items) {
        const type = it.types.find((t) => t.startsWith('image/'));
        if (type) blobs.push(await it.getType(type));
      }
      if (blobs.length) addImages(blobs); else toast('No image on the clipboard');
    } catch (err) {
      console.error(err);
      toast('Clipboard access was blocked');
    }
  }

  // Images shared into the installed app via the Android share sheet (see sw.js)
  async function importShared() {
    if (!('caches' in window)) return;
    const cache = await caches.open(SHARE_CACHE);
    const keys = await cache.keys();
    if (!keys.length) return;
    const blobs = [];
    for (const req of keys) {
      const res = await cache.match(req);
      if (res) blobs.push(await res.blob());
      await cache.delete(req);
    }
    history.replaceState(null, '', location.pathname);
    await addImages(blobs);
  }

  // ---------- Color picker ----------
  function getSampler(imgId) {
    let s = samplers.get(imgId);
    if (s) return s;
    const img = images.get(imgId);
    if (!img || !img.bmp) return null;
    const k = Math.min(1, 1024 / Math.max(img.w, img.h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.w * k)); c.height = Math.max(1, Math.round(img.h * k));
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img.bmp, 0, 0, c.width, c.height);
    s = g.getImageData(0, 0, c.width, c.height);
    samplers.set(imgId, s);
    return s;
  }

  let lastPick = null;
  function pickAt(p) {
    const w = toWorld(p);
    const item = hitTest(w);
    const s = item && getSampler(item.imgId);
    if (!s) { loupe.classList.add('hidden'); lastPick = null; return; }
    const l = toLocal(item, w.x, w.y);
    const cx = Math.floor((l.x / item.w + 0.5) * s.width);
    const cy = Math.floor((l.y / item.h + 0.5) * s.height);
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = cy - 2; y <= cy + 2; y++) for (let x = cx - 2; x <= cx + 2; x++) {
      if (x < 0 || y < 0 || x >= s.width || y >= s.height) continue;
      const i = (y * s.width + x) * 4;
      r += s.data[i]; g += s.data[i + 1]; b += s.data[i + 2]; n++;
    }
    if (!n) return;
    r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
    const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
    const val = Math.round(lstar(luminance(r, g, b)));
    lastPick = { hex, val };
    $('#loupe-swatch').style.background = hex;
    $('#loupe-hex').textContent = hex.toUpperCase();
    $('#loupe-val').textContent = `Value ${val}%`;
    loupe.style.left = clamp(p.x, 100, W - 100) + 'px';
    loupe.style.top = Math.max(100, p.y - 70) + 'px';
    loupe.classList.remove('hidden');
  }

  function renderPalette() {
    const wrap = $('#swatches');
    wrap.innerHTML = '';
    for (const c of board.palette) {
      const el = document.createElement('div');
      el.className = 'swatch';
      el.style.background = c.hex;
      el.innerHTML = `<span>${c.val}</span>`;
      el.onclick = () => toast(`${c.hex.toUpperCase()} · value ${c.val}%`);
      wrap.appendChild(el);
    }
    palette.classList.toggle('hidden', !board.palette.length && !ui.pick);
  }

  // ---------- Gestures ----------
  const pointers = new Map();   // pointerId -> {x, y}
  let gesture = null;
  let tapInfo = null;           // tracks a potential tap
  let lastTap = null;

  function pt(e) { return { x: e.clientX, y: e.clientY }; }

  function startSingle(p, opts = {}) {
    if (ui.pick && !opts.noPick) { gesture = { type: 'pick' }; pickAt(p); return; }
    const sel = selected();
    if (sel && movable(sel) && dist(p, handlePos(sel)) < HANDLE_RADIUS) {
      const c = toScreen(sel);
      gesture = { type: 'handle', item: sel, d0: Math.max(10, dist(c, p)), s0: sel.s };
      return;
    }
    const w = toWorld(p);
    const hit = hitTest(w);
    if (hit && !opts.keepSelection) { selectedId = hit.id; updateUI(); requestRender(); }
    if (hit && movable(hit) && !(ui.pick && opts.noPick)) {
      gesture = { type: 'item', item: hit, ox: hit.x - w.x, oy: hit.y - w.y };
    } else {
      gesture = { type: 'pan', p0: p, v0: { ...view() }, hit };
    }
  }

  function startPinch() {
    const [a, b] = [...pointers.values()];
    const sel = selected();
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    // Only a photo that was already selected gets resized/rotated; otherwise pinch zooms the board,
    // so a board full of photos can still be navigated.
    const wasSelected = sel && tapInfo && tapInfo.selBefore === sel.id;
    const onSel = wasSelected && movable(sel) && !ui.pick &&
      (hitTest(toWorld(a)) === sel || hitTest(toWorld(b)) === sel || hitTest(toWorld(mid)) === sel);
    const base = { d0: Math.max(10, dist(a, b)), a0: angle(a, b), m0: mid };
    if (onSel) {
      gesture = { type: 'pinch-item', item: sel, ...base, wm0: toWorld(mid),
        x0: sel.x, y0: sel.y, s0: sel.s, r0: sel.r, rotOn: false };
    } else {
      gesture = { type: 'pinch-view', ...base, v0: { ...view() } };
    }
    loupe.classList.add('hidden');
  }

  function snapAngle(r) {
    const q = Math.PI / 2;
    const n = Math.round(r / q);
    return Math.abs(r - n * q) < ROT_SNAP ? n * q : r;
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (pointers.size >= 2) return;
    anim = null;
    canvas.setPointerCapture(e.pointerId);
    const p = pt(e);
    pointers.set(e.pointerId, p);
    if (pointers.size === 1) {
      gesture = null;
      tapInfo = { p0: p, t0: performance.now(), moved: false, before: snapshot(), selBefore: selectedId };
      startSingle(p);
    } else {
      if (tapInfo) tapInfo.moved = true;   // a second finger means this isn't a tap
      startPinch();
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) {
      // Mouse hover in pick mode
      if (ui.pick && e.pointerType === 'mouse') pickAt(pt(e));
      return;
    }
    const p = pt(e);
    pointers.set(e.pointerId, p);
    if (tapInfo && !tapInfo.moved && dist(p, tapInfo.p0) > TAP_SLOP) tapInfo.moved = true;
    if (!gesture) return;
    const g = gesture;

    switch (g.type) {
      case 'pick':
        pickAt(p);
        break;
      case 'pan':
        if (!tapInfo || tapInfo.moved) {
          board.view = { ...g.v0, x: g.v0.x + p.x - g.p0.x, y: g.v0.y + p.y - g.p0.y };
        }
        break;
      case 'item': {
        if (tapInfo && !tapInfo.moved) break;
        const w = toWorld(p);
        g.item.x = w.x + g.ox; g.item.y = w.y + g.oy;
        break;
      }
      case 'handle': {
        const c = toScreen(g.item);
        g.item.s = clamp(g.s0 * dist(c, p) / g.d0, 0.005, 200);
        break;
      }
      case 'pinch-view': {
        const [a, b] = [...pointers.values()];
        const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const z = clamp(g.v0.z * dist(a, b) / g.d0, Z_MIN, Z_MAX);
        const wx = (g.m0.x - g.v0.x) / g.v0.z, wy = (g.m0.y - g.v0.y) / g.v0.z;
        board.view = { z, x: m.x - wx * z, y: m.y - wy * z };
        break;
      }
      case 'pinch-item': {
        const [a, b] = [...pointers.values()];
        const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const k = dist(a, b) / g.d0;
        let rot = angle(a, b) - g.a0;
        rot = Math.atan2(Math.sin(rot), Math.cos(rot));
        if (!g.rotOn && Math.abs(rot) > ROT_DEADZONE) g.rotOn = true;
        if (!g.rotOn) rot = 0;
        const it = g.item;
        it.s = clamp(g.s0 * k, 0.005, 200);
        it.r = snapAngle(g.r0 + rot);
        const realRot = it.r - g.r0, realK = it.s / g.s0;
        const wm = toWorld(m);
        const vx = (g.x0 - g.wm0.x) * realK, vy = (g.y0 - g.wm0.y) * realK;
        const c = Math.cos(realRot), s = Math.sin(realRot);
        it.x = wm.x + vx * c - vy * s;
        it.y = wm.y + vx * s + vy * c;
        break;
      }
    }
    requestRender();
  });

  function endPointer(e, cancelled) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pointers.size === 1) {
      // Pinch -> one finger: continue smoothly with the remaining finger
      const p = [...pointers.values()][0];
      startSingle(p, { noPick: true, keepSelection: true });
      if (gesture && gesture.type === 'pan') gesture.p0 = p;
      return;
    }
    if (pointers.size > 0) return;

    const g = gesture;
    gesture = null;
    if (g && g.type === 'pick') {
      loupe.classList.add('hidden');
      if (lastPick && !cancelled) {
        board.palette.unshift(lastPick);
        board.palette = board.palette.slice(0, 16);
        renderPalette();
        scheduleSave();
      }
      lastPick = null;
    }
    const ti = tapInfo;
    tapInfo = null;
    if (ti) commit(ti.before);
    if (g && (g.type === 'pan' || g.type === 'pinch-view')) scheduleSave();

    if (ti && !ti.moved && !cancelled && !ui.pick && performance.now() - ti.t0 < 350) {
      handleTap(ti.p0);
    }
    requestRender();
  }
  canvas.addEventListener('pointerup', (e) => endPointer(e, false));
  canvas.addEventListener('pointercancel', (e) => endPointer(e, true));
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  function handleTap(p) {
    const hit = hitTest(toWorld(p));
    const now = performance.now();
    const isDouble = lastTap && now - lastTap.t < DOUBLE_TAP_MS && dist(p, lastTap.p) < 40;
    lastTap = isDouble ? null : { t: now, p };
    if (isDouble) {
      if (hit) fitTo([hit]); else fitTo(board.items);
      return;
    }
    if (!hit) { selectedId = null; updateUI(); }
  }

  // Mouse wheel / trackpad zoom (desktop)
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    anim = null;
    const v = view();
    // Pinch on a trackpad (ctrlKey) or a plain mouse wheel zooms; two-finger trackpad scroll pans
    if (e.ctrlKey || (!e.shiftKey && Math.abs(e.deltaX) < 1)) {
      const z = clamp(v.z * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), Z_MIN, Z_MAX);
      const wx = (e.clientX - v.x) / v.z, wy = (e.clientY - v.y) / v.z;
      board.view = { z, x: e.clientX - wx * z, y: e.clientY - wy * z };
    } else {
      board.view = { ...v, x: v.x - e.deltaX, y: v.y - e.deltaY };
    }
    requestRender();
    scheduleSave();
  }, { passive: false });

  // Drag & drop / paste (desktop and keyboards)
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    addImages([...(e.dataTransfer.files || [])]);
  });
  window.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addImages(files); }
  });
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selected()) selAction('delete');
    else if (e.key === 'f' && !mod) fitTo(board.items);
  });

  // ---------- Toolbar actions ----------
  let wakeLock = null;
  async function setWake(on) {
    ui.wake = on;
    try {
      if (on) {
        if (!('wakeLock' in navigator)) { toast('Keep-awake needs HTTPS / a newer browser'); ui.wake = false; }
        else { wakeLock = await navigator.wakeLock.request('screen'); toast('Screen will stay on'); }
      } else if (wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (err) { ui.wake = false; toast('Could not keep the screen on'); }
    updateUI();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && ui.wake) navigator.wakeLock?.request('screen').then((l) => (wakeLock = l)).catch(() => {});
    if (document.visibilityState === 'hidden') saveNow();
  });

  toolbar.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    switch (btn.dataset.act) {
      case 'add': $('#file-input').click(); break;
      case 'paste': pasteFromClipboard(); break;
      case 'undo': undo(); break;
      case 'redo': redo(); break;
      case 'fit': fitTo(board.items); break;
      case 'gray': ui.gray = !ui.gray; break;
      case 'squint': ui.squint = !ui.squint; break;
      case 'pick':
        ui.pick = !ui.pick;
        if (ui.pick) toast('Touch a photo to read its color and value');
        renderPalette();
        break;
      case 'lockall':
        ui.lockall = !ui.lockall;
        toast(ui.lockall ? 'Painting mode: photos locked' : 'Photos unlocked');
        break;
      case 'bg': {
        const i = BACKGROUNDS.indexOf(board.bg);
        board.bg = BACKGROUNDS[(i + 1) % BACKGROUNDS.length];
        scheduleSave();
        break;
      }
      case 'wake': setWake(!ui.wake); return;
      case 'fullscreen':
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen?.().catch(() => toast('Fullscreen not available'));
        break;
      case 'menu': openMenu(); break;
    }
    updateUI();
    requestRender();
  });

  selbar.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn) selAction(btn.dataset.sel);
  });

  function selAction(act) {
    const it = selected();
    if (!it) return;
    switch (act) {
      case 'mode': mutate(() => { it.mode = MODES[(MODES.indexOf(it.mode) + 1) % MODES.length]; }); break;
      case 'grid': mutate(() => { it.grid = GRIDS[(GRIDS.indexOf(it.grid) + 1) % GRIDS.length]; }); break;
      case 'flip': mutate(() => { it.flip = !it.flip; }); break;
      case 'unrotate': mutate(() => { it.r = 0; }); break;
      case 'front': mutate(() => { board.items = board.items.filter((i) => i !== it).concat(it); }); break;
      case 'back': mutate(() => { board.items = [it, ...board.items.filter((i) => i !== it)]; }); break;
      case 'focus': fitTo([it]); break;
      case 'duplicate': {
        const copy = { ...it, id: uid(), x: it.x + 24 / view().z, y: it.y + 24 / view().z, locked: false };
        mutate(() => board.items.push(copy));
        selectedId = copy.id;
        break;
      }
      case 'lock': mutate(() => { it.locked = !it.locked; }); break;
      case 'delete':
        mutate(() => { board.items = board.items.filter((i) => i !== it); });
        selectedId = null;
        toast('Deleted — tap undo to bring it back');
        break;
    }
    updateUI();
    requestRender();
  }

  $('#file-input').addEventListener('change', (e) => {
    addImages([...e.target.files]);
    e.target.value = '';
  });

  $('#palette-clear').addEventListener('click', () => {
    board.palette = [];
    renderPalette();
    scheduleSave();
  });

  function updateUI() {
    if (!board) return;
    for (const btn of toolbar.querySelectorAll('[data-toggle]')) btn.classList.toggle('on', !!ui[btn.dataset.act]);
    toolbar.querySelector('[data-act=undo]').disabled = !undoStack.length;
    toolbar.querySelector('[data-act=redo]').disabled = !redoStack.length;
    const it = selected();
    selbar.classList.toggle('hidden', !it);
    if (it) {
      $('#mode-label').textContent = MODE_LABELS[it.mode];
      $('#grid-label').textContent = it.grid ? `Grid ${it.grid}×${it.grid}` : 'Grid';
      selbar.querySelector('[data-sel=lock]').classList.toggle('on', !!it.locked);
      selbar.querySelector('[data-sel=mode]').classList.toggle('on', it.mode !== 'color');
      selbar.querySelector('[data-sel=grid]').classList.toggle('on', !!it.grid);
    }
  }

  // ---------- Menu ----------
  async function openMenu() {
    await saveNow();
    const boards = (await idbGetAll('boards')).sort((a, b) => b.updated - a.updated);
    const list = $('#board-list');
    list.innerHTML = '';
    for (const b of boards) {
      const el = document.createElement('button');
      el.className = 'board-item' + (b.id === board.id ? ' current' : '');
      el.innerHTML = `<span></span><small>${b.items.length} photo${b.items.length === 1 ? '' : 's'}</small>`;
      el.firstChild.textContent = b.name;
      el.onclick = async () => { closeMenu(); if (b.id !== board.id) { await openBoard(b); } };
      list.appendChild(el);
    }
    const info = $('#storage-info');
    info.textContent = '';
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      info.textContent = `Using ${(est.usage / 1048576).toFixed(1)} MB on this device` +
        (persisted ? ' · protected from automatic cleanup' : '');
    }
    menu.classList.remove('hidden');
  }
  function closeMenu() { menu.classList.add('hidden'); }
  $('#menu-close').onclick = closeMenu;
  menu.addEventListener('click', (e) => { if (e.target === menu) closeMenu(); });

  menu.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-menu]');
    if (!btn) return;
    switch (btn.dataset.menu) {
      case 'new': {
        const name = await ask('Name the new board', { value: 'New board', okLabel: 'Create' });
        if (name === null) return;
        const b = newBoard(name.trim() || 'Untitled');
        await idbPut('boards', b);
        closeMenu();
        await openBoard(b);
        break;
      }
      case 'rename': {
        const name = await ask('Rename board', { value: board.name, okLabel: 'Rename' });
        if (!name || !name.trim()) return;
        board.name = name.trim();
        $('#board-name').textContent = board.name;
        await saveNow();
        openMenu();
        break;
      }
      case 'delete': {
        if (!await ask(`Delete "${board.name}" and its photos? This cannot be undone.`, { okLabel: 'Delete', danger: true })) return;
        await idbDel('boards', board.id);
        const rest = (await idbGetAll('boards')).sort((a, b) => b.updated - a.updated);
        const next = rest[0] || newBoard('My board');
        if (!rest.length) await idbPut('boards', next);
        board = null;
        closeMenu();
        await openBoard(next);
        await gcImages();
        break;
      }
      case 'export': await exportBoard(); break;
      case 'import': $('#import-input').click(); break;
    }
  });

  const blobToDataURL = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

  async function exportBoard() {
    toast('Preparing export…', 10000);
    await saveNow();
    const out = { format: 'refboard', version: 1, board: { ...board }, images: {} };
    for (const id of new Set(board.items.map((i) => i.imgId))) {
      const rec = await idbGet('images', id);
      if (rec) out.images[id] = await blobToDataURL(rec.blob);
    }
    const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
    const name = board.name.replace(/[^\w\- ]+/g, '').trim() || 'board';
    const file = new File([blob], `${name}.refboard.json`, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: board.name }); toast('Exported'); return; }
      catch (err) { if (err.name === 'AbortError') { toast('Export cancelled'); return; } }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Saved to Downloads');
  }

  $('#import-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.format !== 'refboard') throw new Error('Not a RefBoard file');
      toast('Importing…', 10000);
      const idMap = {};
      for (const [oldId, url] of Object.entries(data.images)) {
        const blob = await (await fetch(url)).blob();
        const bmp = await createImageBitmap(blob);
        const id = uid();
        await idbPut('images', { id, blob, w: bmp.width, h: bmp.height });
        bmp.close();
        idMap[oldId] = id;
      }
      const b = { ...newBoard(data.board.name || 'Imported'), ...data.board, id: uid(), updated: Date.now() };
      b.items = (b.items || []).filter((i) => idMap[i.imgId]).map((i) => ({ ...i, id: uid(), imgId: idMap[i.imgId] }));
      await idbPut('boards', b);
      closeMenu();
      await openBoard(b);
      toast(`Imported "${b.name}"`);
    } catch (err) {
      console.error(err);
      toast('Could not import that file');
    }
  });

  // ---------- Sample photos ----------
  // Painted procedurally so the app can be tried without picking files.
  function paintSample(kind) {
    const c = document.createElement('canvas');
    const g = c.getContext('2d');
    const rnd = (() => { let s = kind.length * 9973; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
    if (kind === 'sunset') {
      c.width = 1600; c.height = 1000;
      const sky = g.createLinearGradient(0, 0, 0, 640);
      sky.addColorStop(0, '#2b3a67'); sky.addColorStop(0.45, '#c86b6b'); sky.addColorStop(0.8, '#f2b766'); sky.addColorStop(1, '#f7dc9c');
      g.fillStyle = sky; g.fillRect(0, 0, 1600, 1000);
      g.fillStyle = '#fff1c9'; g.beginPath(); g.arc(1080, 560, 70, 0, 7); g.fill();
      const ridges = [['#6b5a7a', 560, 90], ['#4a4366', 640, 70], ['#2e2c45', 740, 60]];
      for (const [col, base, amp] of ridges) {
        g.fillStyle = col; g.beginPath(); g.moveTo(0, 1000);
        for (let x = 0; x <= 1600; x += 40) g.lineTo(x, base - Math.sin(x / 210 + base) * amp - rnd() * 25);
        g.lineTo(1600, 1000); g.fill();
      }
      const lake = g.createLinearGradient(0, 820, 0, 1000);
      lake.addColorStop(0, '#d79a6a'); lake.addColorStop(1, '#3b3a5c');
      g.fillStyle = lake; g.fillRect(0, 840, 1600, 160);
    } else if (kind === 'pears') {
      c.width = 1100; c.height = 1300;
      g.fillStyle = '#e9e1d2'; g.fillRect(0, 0, 1100, 1300);
      g.fillStyle = '#8c7a62'; g.fillRect(0, 860, 1100, 440);
      const pear = (x, y, k, col, shade) => {
        g.save(); g.translate(x, y); g.scale(k, k);
        g.fillStyle = 'rgba(40,30,20,0.25)'; g.beginPath(); g.ellipse(40, 250, 210, 40, 0, 0, 7); g.fill();
        const gr = g.createRadialGradient(-60, 40, 20, 0, 80, 260);
        gr.addColorStop(0, '#f6e9a0'); gr.addColorStop(0.4, col); gr.addColorStop(1, shade);
        g.fillStyle = gr; g.beginPath();
        g.ellipse(0, 120, 170, 160, 0, 0, 7); g.ellipse(0, -60, 100, 120, 0, 0, 7); g.fill();
        g.strokeStyle = '#5a3d22'; g.lineWidth = 14; g.lineCap = 'round';
        g.beginPath(); g.moveTo(0, -175); g.quadraticCurveTo(10, -230, 40, -250); g.stroke();
        g.restore();
      };
      pear(380, 660, 1, '#b9c35a', '#5c6a2a');
      pear(720, 720, 0.85, '#d6a84a', '#7a4a22');
    } else {
      c.width = 1400; c.height = 1050;
      const sky = g.createLinearGradient(0, 0, 0, 560);
      sky.addColorStop(0, '#6f9ec4'); sky.addColorStop(1, '#d9e6ec');
      g.fillStyle = sky; g.fillRect(0, 0, 1400, 1050);
      for (let i = 0; i < 6; i++) {
        g.fillStyle = 'rgba(255,255,255,0.8)'; g.beginPath();
        const cx = rnd() * 1400, cy = 80 + rnd() * 250;
        for (let j = 0; j < 5; j++) {
          g.moveTo(cx + j * 45 + 70, cy + Math.sin(j) * 15);
          g.ellipse(cx + j * 45, cy + Math.sin(j) * 15, 70, 35, 0, 0, Math.PI * 2);
        }
        g.fill('nonzero');
      }
      const sea = g.createLinearGradient(0, 560, 0, 820);
      sea.addColorStop(0, '#2f6f8a'); sea.addColorStop(1, '#5fa3a6');
      g.fillStyle = sea; g.fillRect(0, 560, 1400, 260);
      g.fillStyle = '#e3d3ae'; g.beginPath(); g.moveTo(0, 820);
      for (let x = 0; x <= 1400; x += 50) g.lineTo(x, 800 + Math.sin(x / 160) * 18);
      g.lineTo(1400, 1050); g.lineTo(0, 1050); g.fill();
      g.fillStyle = '#3d3a36'; g.beginPath(); g.moveTo(820, 560); g.lineTo(900, 470); g.lineTo(1010, 430); g.lineTo(1150, 500); g.lineTo(1220, 560); g.fill();
      g.fillStyle = '#fff'; g.beginPath(); g.moveTo(400, 600); g.lineTo(430, 470); g.lineTo(450, 600); g.fill();
    }
    return new Promise((r) => c.toBlob(r, 'image/png'));
  }
  async function loadSamples() {
    const blobs = await Promise.all(['sunset', 'pears', 'coast'].map(paintSample));
    await addImages(blobs);
    selectedId = null;
    updateUI();
    fitTo(board.items);
  }
  $('#load-samples').addEventListener('click', loadSamples);

  // ---------- Startup ----------
  window.addEventListener('resize', resize);
  document.addEventListener('fullscreenchange', resize);
  resize();

  (async () => {
    try {
      let boards = await idbGetAll('boards');
      const currentId = await idbGet('meta', 'current');
      let b = boards.find((x) => x.id === currentId) || boards.sort((a, c) => c.updated - a.updated)[0];
      const firstRun = !b;
      if (!b) { b = newBoard('My board'); await idbPut('boards', b); }
      await openBoard(b);
      if (firstRun) board.view = { x: W / 2, y: H / 2, z: 1 };
      requestRender();
      await gcImages().catch(() => {});
      await importShared();
      if (firstRun && window.REFBOARD_DEMO) await loadSamples();
    } catch (err) {
      console.error(err);
      toast('Storage is unavailable — is this a private window?', 6000);
      board = newBoard('Temporary');
      board.view = { x: W / 2, y: H / 2, z: 1 };
      updateUI();
      requestRender();
    }
  })();

  if (!window.REFBOARD_DEMO && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW registration failed', err));
  }
})();
