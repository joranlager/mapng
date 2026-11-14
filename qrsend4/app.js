import qrcode from './vendor/qrcode.mjs';
import {
  buildStreamBytes, parseStreamBytes, Encoder, Decoder, parseSymbol, OVERHEAD, bytesToBinaryString,
} from './protocol.js';
import { renderGrid, gridCapacity } from './grid.js';
import { frameDataCapacity, rsEncodeFrame } from './rs.js';

const $ = (id) => document.getElementById(id);
const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1048576).toFixed(2)} MB`);
const fmtTime = (s) => (s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`);
const fmtClock = (ms) => {
  const t = Math.max(0, ms) / 1000, m = Math.floor(t / 60), sec = t - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
};
const fmtMBs = (bps) => (bps / 1048576).toFixed(3);

// ---------------------------------------------------------------- faner
function showTab(name) {
  $('tab-send').setAttribute('aria-selected', name === 'send');
  $('tab-recv').setAttribute('aria-selected', name === 'recv');
  $('view-send').hidden = name !== 'send';
  $('view-recv').hidden = name !== 'recv';
  if (name !== 'recv') stopCamera();
  try { localStorage.setItem('qrsend4-tab', name); } catch {}
}
$('tab-send').onclick = () => showTab('send');
$('tab-recv').onclick = () => showTab('recv');

// ---------------------------------------------------------------- våkenskap
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (tx.playing || cameraOn)) keepAwake(true);
});

// =====================================================================
// SENDER
// =====================================================================
let sourceFile = null;
let payloadBytes = null, payloadType = '', payloadName = '', prepareToken = 0;

const opt = {
  format: $('opt-format'), maxSide: $('opt-maxside'), quality: $('opt-quality'),
  mode: $('opt-mode'), perPacket: $('opt-perpacket'), chunk: $('opt-chunk'), interval: $('opt-interval'), ecc: $('opt-ecc'),
  g: $('opt-g'), p: $('opt-p'), fps: $('opt-fps'), preset: $('opt-preset'),
};
const SETTINGS_KEY = 'qrsend4-opts2';

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    for (const k in opt) if (s[k] != null) opt[k].value = s[k];
  } catch {}
  $('out-quality').textContent = opt.quality.value;
  showModeOptions();
}
function saveSettings() {
  try {
    const s = {};
    for (const k in opt) s[k] = opt[k].value;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {}
}
// Forhåndsvalg for fargerutenettet: [celler per side, farger, bilder per sekund]
const PRESETS = { safe: [40, 4, 10], fast: [96, 8, 12], max: [120, 8, 15] };
// Rutenett mottakeren prøver av seg selv (i tillegg til det som står i feltene).
const GRID_CANDIDATES = [[96, 8], [40, 4], [120, 8], [64, 8], [64, 4], [40, 8], [96, 4]];
function applyPreset() {
  const pr = PRESETS[opt.preset.value];
  if (!pr) return;
  opt.g.value = pr[0]; opt.p.value = pr[1]; opt.fps.value = pr[2];
}
const gridParams = () => {
  const G = Math.max(24, Math.min(160, +opt.g.value || 96)), P = opt.p.value === '4' ? 4 : 8;
  const cap = gridCapacity(G, P);
  return { G, P, cap, B: frameDataCapacity(cap) - OVERHEAD };
};

function showModeOptions() {
  const grid = opt.mode.value === 'grid';
  $('qr-opts').hidden = grid;
  $('grid-opts').hidden = !grid;
}

$('file').addEventListener('change', (e) => {
  sourceFile = e.target.files[0] || null;
  if (sourceFile) $('file-label').textContent = sourceFile.name;
  prepare();
});
for (const k of ['format', 'maxSide', 'quality']) opt[k].addEventListener('input', () => { saveSettings(); prepare(); });
for (const k of ['perPacket', 'chunk', 'interval', 'ecc']) opt[k].addEventListener('input', () => { saveSettings(); updateEstimate(); });
for (const k of ['g', 'p', 'fps']) opt[k].addEventListener('input', () => { opt.preset.value = 'custom'; saveSettings(); updateEstimate(); });
opt.preset.addEventListener('change', () => { applyPreset(); saveSettings(); updateEstimate(); });
opt.mode.addEventListener('change', () => { saveSettings(); showModeOptions(); updateEstimate(); });
opt.quality.addEventListener('input', () => ($('out-quality').textContent = opt.quality.value));

async function decodeImage(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
}
const canvasToBlob = (c, type, q) => new Promise((res) => c.toBlob(res, type, q));

async function prepare() {
  const token = ++prepareToken;
  $('btn-start').disabled = true;
  if (!sourceFile) return;
  $('estimate').textContent = 'Forbereder bilde …';
  const format = opt.format.value;
  let bytes, type, name = sourceFile.name;
  if (format === 'original') {
    bytes = new Uint8Array(await sourceFile.arrayBuffer());
    type = sourceFile.type || 'application/octet-stream';
  } else {
    const img = await decodeImage(sourceFile);
    const maxSide = Math.max(16, +opt.maxSide.value || 1600);
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    let blob = await canvasToBlob(c, format, +opt.quality.value);
    if (!blob || blob.type !== format) blob = await canvasToBlob(c, 'image/jpeg', +opt.quality.value);
    bytes = new Uint8Array(await blob.arrayBuffer());
    type = blob.type;
    name = name.replace(/\.[^.]+$/, '') + (type === 'image/webp' ? '.webp' : '.jpg');
  }
  if (token !== prepareToken) return;
  payloadBytes = bytes; payloadType = type; payloadName = name;
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const prev = $('preview');
  if (prev.dataset.url) URL.revokeObjectURL(prev.dataset.url);
  prev.src = url; prev.dataset.url = url;
  prev.onload = () => {
    $('file-info').textContent = `${name} · ${prev.naturalWidth}×${prev.naturalHeight} · ${fmtBytes(bytes.length)} (original ${fmtBytes(sourceFile.size)})`;
  };
  $('preview-wrap').hidden = false;
  updateEstimate();
}

// Nyttelast per symbol i valgt modus (byte).
function currentSymbolPayload() {
  if (opt.mode.value === 'grid') return gridParams();
  return { B: Math.max(50, +opt.chunk.value || 380) };
}

function updateEstimate() {
  if (!payloadBytes) return;
  const { B } = currentSymbolPayload();
  const streamLen = 2 + 120 + payloadBytes.length;
  const K = Math.max(1, Math.ceil(streamLen / B));
  let text;
  if (opt.mode.value === 'grid') {
    const fps = Math.max(1, Math.min(30, +opt.fps.value || 12));
    if (B < 16) { $('estimate').textContent = 'Rutenettet er for lite til feilretting. Velg flere celler.'; $('btn-start').disabled = true; return; }
    const { G, P } = gridParams();
    const t = (share) => fmtTime((K * 1.1) / (fps * share));
    text = `${G}×${G} celler, ${P} farger: ${B} byte per bilde, ${K} blokker. ${fps} bilder/s gir ${fmtBytes(Math.round(fps * B))}/s brutto. ` +
      `Tid for denne filen: ca. ${t(1)} hvis mottakeren leser alle bildene, ${t(0.6)} ved 60 %, ${t(0.3)} ved 30 %.`;
  } else {
    const per = Math.max(1, +opt.perPacket.value || 10);
    const interval = Math.max(30, +opt.interval.value || 300);
    const perSec = (per * B) / (interval / 1000);
    text = `${K} symboler à ${B} byte, ${per} QR per pakke. ${fmtBytes(Math.round(perSec))}/s. ` +
      `Ca. ${fmtTime((K * 1.25 * interval) / 1000 / per)} til alt er mottatt (med tap og overhead).`;
  }
  $('estimate').textContent = text;
  $('btn-start').disabled = false;
}

// ---------------------------------------------------------------- avspilling
const pc = $('player-canvas');
const pctx = pc.getContext('2d', { alpha: false });
const tx = {
  playing: false, paused: false, mode: 'qr', enc: null, timer: 0,
  perPacket: 10, interval: 300, ecc: 'M', fps: 10, G: 40, P: 4, B: 380,
  lastQr: [], lastSym: null,
};

function qrCanvas(bytes, ecc) {
  const qr = qrcode(0, ecc);
  qr.addData(bytesToBinaryString(bytes), 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const c = document.createElement('canvas');
  c.width = n; c.height = n;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(n, n);
  for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) {
    const v = qr.isDark(r, col) ? 0 : 255, o = (r * n + col) * 4;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = v; img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function bestGrid(count, W, H) {
  let best = { cols: 1, rows: count, cell: 0 };
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const cell = Math.min(W / cols, H / rows);
    if (cell > best.cell) best = { cols, rows, cell };
  }
  return best;
}

function drawQrs(x0, y0, W, H, qrs, slots) {
  const g = bestGrid(slots, W, H);
  const offX = x0 + (W - g.cols * g.cell) / 2, offY = y0 + (H - g.rows * g.cell) / 2;
  pctx.imageSmoothingEnabled = false;
  qrs.forEach((q, k) => {
    const mod = Math.max(1, Math.floor(g.cell / (q.width + 6)));   // 3 moduler stillesone
    const size = mod * q.width;
    const x = Math.round(offX + (k % g.cols) * g.cell + (g.cell - size) / 2);
    const y = Math.round(offY + Math.floor(k / g.cols) * g.cell + (g.cell - size) / 2);
    pctx.drawImage(q, x, y, size, size);
  });
}

function resizePlayer() {
  const dpr = window.devicePixelRatio || 1;
  pc.width = Math.round(pc.clientWidth * dpr);
  pc.height = Math.round(pc.clientHeight * dpr);
  drawFrame();
}

function drawFrame() {
  if (!tx.playing) return;
  const dpr = window.devicePixelRatio || 1;
  const W = pc.width, H = pc.height - Math.round($('player-bar').offsetHeight * dpr);
  pctx.fillStyle = '#fff';
  pctx.fillRect(0, 0, pc.width, pc.height);
  if (tx.mode === 'qr') drawQrs(0, 0, W, H, tx.lastQr, tx.perPacket);
  else if (tx.lastSym) renderGrid(pctx, 0, 0, W, H, tx.lastSym, tx.G, tx.P);
  const k = tx.enc.count, K = tx.enc.K;
  const phase = k <= K ? `første gjennomgang ${k}/${K}` : `fortsetter · ${K} blokker`;
  const rate = tx.mode === 'qr' ? `${tx.interval} ms/pakke` : `${tx.fps} bilder/s`;
  $('player-status').textContent =
    `${tx.mode === 'qr' ? 'QR' : 'Farger'} · symbol ${k} · ${phase} · ${rate}`;
}

function tick() {
  if (!tx.playing || tx.paused) return;
  if (tx.mode === 'qr') {
    tx.lastQr = [];
    for (let k = 0; k < tx.perPacket; k++) tx.lastQr.push(qrCanvas(tx.enc.next(), tx.ecc));
    drawFrame();
    tx.timer = setTimeout(tick, tx.interval);
  } else {
    tx.nextAt = 0;
    requestAnimationFrame(gridLoop);
  }
}

// Fargerutenettet byttes i takt med skjermens oppfriskning, så hvert bilde står stille like lenge.
function gridLoop(ts) {
  if (!tx.playing || tx.mode !== 'grid' || tx.paused) return;
  if (ts >= tx.nextAt) {
    tx.nextAt = Math.max(tx.nextAt + 1000 / tx.fps, ts);
    tx.lastSym = rsEncodeFrame(tx.enc.next(), tx.cap);
    drawFrame();
  }
  requestAnimationFrame(gridLoop);
}

function startPlayer() {
  if (!payloadBytes) return;
  tx.mode = opt.mode.value === 'grid' ? 'grid' : 'qr';
  if (tx.mode === 'grid') {
    const gp = gridParams();
    tx.G = gp.G; tx.P = gp.P; tx.cap = gp.cap; tx.B = gp.B;
    tx.fps = Math.max(1, Math.min(30, +opt.fps.value || 12));
  } else {
    tx.perPacket = Math.max(1, +opt.perPacket.value || 10);
    tx.interval = Math.max(30, +opt.interval.value || 300);
    tx.ecc = opt.ecc.value;
    tx.B = Math.max(50, +opt.chunk.value || 380);
  }
  if (tx.B < 16) { alert('Rutenettet er for lite. Velg flere celler.'); return; }
  const tid = crypto.getRandomValues(new Uint32Array(1))[0] >>> 0;
  tx.enc = new Encoder(buildStreamBytes(payloadBytes, { name: payloadName, type: payloadType }), tx.B, tid);
  tx.lastQr = []; tx.lastSym = null;
  tx.playing = true; tx.paused = false;
  $('btn-pause').textContent = 'Pause';
  $('player').hidden = false;
  document.documentElement.requestFullscreen?.().catch(() => {});
  keepAwake(true);
  resizePlayer();
  clearTimeout(tx.timer);
  tick();
}

function stopPlayer() {
  tx.playing = false;
  clearTimeout(tx.timer);
  $('player').hidden = true;
  keepAwake(false);
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}

function faster() {
  if (tx.mode === 'qr') tx.interval = Math.max(30, Math.round(tx.interval / 1.25));
  else tx.fps = Math.min(30, Math.max(tx.fps + 1, Math.round(tx.fps * 1.25)));
  drawFrame();
}
function slower() {
  if (tx.mode === 'qr') tx.interval = Math.min(5000, Math.round(tx.interval * 1.25));
  else tx.fps = Math.max(1, Math.min(tx.fps - 1, Math.round(tx.fps / 1.25)));
  drawFrame();
}

$('btn-start').onclick = startPlayer;
$('btn-stop').onclick = stopPlayer;
$('btn-pause').onclick = () => {
  tx.paused = !tx.paused;
  $('btn-pause').textContent = tx.paused ? 'Fortsett' : 'Pause';
  if (!tx.paused) { clearTimeout(tx.timer); tick(); }
};
$('btn-slower').onclick = slower;
$('btn-faster').onclick = faster;
window.addEventListener('resize', () => tx.playing && resizePlayer());
document.addEventListener('keydown', (e) => {
  if (!tx.playing) return;
  if (e.key === 'Escape') stopPlayer();
  else if (e.key === ' ') { e.preventDefault(); $('btn-pause').click(); }
  else if (e.key === '+') faster();
  else if (e.key === '-') slower();
});

// =====================================================================
// MOTTAKER
// =====================================================================
const video = $('video');
let stream = null, cameraOn = false;
let dec = new Decoder();
let tStart = 0, tEnd = 0, symQr = 0, symGrid = 0, gridFound = 0, gridSeen = 0, gridFixed = 0;
let gridLock = null, gridLastOk = 0, gridTry = 0;   // rutenettet avsenderen bruker, når det er funnet
let fpsT0 = performance.now(), framesDone = 0;
let workers = [], gridWorkers = [], lastResultUrl = null, resultBlob = null, resultName = '';
const grab = document.createElement('canvas');
const gctx = grab.getContext('2d', { willReadFrequently: true });

function initWorkers() {
  if (workers.length) return;
  const n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
  for (let i = 0; i < n; i++) {
    const w = new Worker('decoder-worker.js');
    w.busy = true;
    w.onmessage = (e) => onWorkerMessage(w, e.data);
    w.onerror = (e) => setStatus('Feil i QR-dekoderen: ' + (e.message || e));
    workers.push(w);
  }
  for (let i = 0; i < Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1)); i++) {
    const g = new Worker('grid-worker.js', { type: 'module' });
    g.busy = true;
    g.onmessage = (e) => onGridMessage(g, e.data);
    g.onerror = (e) => setStatus('Feil i rutenettdekoderen: ' + (e.message || e));
    gridWorkers.push(g);
  }
}

function onGridMessage(g, msg) {
  if (msg.type === 'ready') { g.busy = false; return; }
  if (msg.type !== 'result') return;
  g.busy = false;
  if (msg.found) gridFound++;
  if (msg.bytes) {
    const sym = parseSymbol(msg.bytes);
    if (sym) {
      symGrid++; gridFixed += msg.fixed;
      gridLastOk = performance.now();
      if (!gridLock || gridLock[0] !== msg.G || gridLock[1] !== msg.P) {
        gridLock = [msg.G, msg.P];
        $('opt-rg').value = msg.G; $('opt-rp').value = msg.P;
      }
      onSymbol(sym);
    }
  }
}

function onWorkerMessage(w, msg) {
  if (msg.type === 'ready') { w.busy = false; return; }
  if (msg.type === 'error') { setStatus('Kunne ikke laste QR-dekoderen: ' + msg.message); return; }
  if (msg.type === 'result') {
    w.busy = false;
    framesDone++;
    for (const bytes of msg.codes) {
      const sym = parseSymbol(bytes);
      if (sym) { symQr++; onSymbol(sym); }
    }
  }
}

function onSymbol(sym) {
  const newTransfer = dec.tid !== null && sym.tid !== dec.tid;
  if (newTransfer || dec.tid === null) {
    tStart = performance.now(); tEnd = 0;
    $('result').hidden = true;
  }
  const r = dec.add(sym);
  if (r === 'new' || r === 'redundant') drawChunkMap();
  if (dec.complete && !tEnd) finish();
}

function setStatus(t) { $('recv-status').textContent = t; }

function updateProgressText() {
  const K = dec.K || 0;
  const pct = K ? (100 * dec.decoded) / K : 0;
  $('recv-pct').textContent = `${pct < 100 && pct > 99 ? 99 : Math.floor(pct)} %`;
  const ms = tStart ? (tEnd || performance.now()) - tStart : 0;
  $('recv-time').textContent = fmtClock(ms);
  const useful = K ? Math.min(dec.streamLen, dec.decoded * dec.B) : 0;
  $('recv-speed').textContent = fmtMBs(ms > 0 ? useful / (ms / 1000) : 0);
  $('recv-time-label').textContent = tEnd ? 'overføringstid (ferdig)' : 'overføringstid';
  $('progress-bar').style.width = `${pct}%`;
}
setInterval(updateProgressText, 100);

function drawChunkMap() {
  const cm = $('chunk-map');
  const dpr = window.devicePixelRatio || 1;
  cm.width = Math.round(cm.clientWidth * dpr); cm.height = Math.round(40 * dpr);
  const ctx = cm.getContext('2d');
  const css = getComputedStyle(document.documentElement);
  ctx.fillStyle = css.getPropertyValue('--missing'); ctx.fillRect(0, 0, cm.width, cm.height);
  if (!dec.K || !dec.blocks) return;
  const n = dec.K, w = cm.width / n;
  ctx.fillStyle = css.getPropertyValue('--ok');
  for (let i = 0; i < n; i++) if (dec.blocks[i]) ctx.fillRect(Math.floor(i * w), 0, Math.ceil(w), cm.height);
}

function finish() {
  tEnd = performance.now();
  updateProgressText();
  const { meta, file, ok } = dec.assemble();
  resultName = meta.name || 'bilde';
  resultBlob = new Blob([file], { type: meta.type || 'application/octet-stream' });
  if (lastResultUrl) URL.revokeObjectURL(lastResultUrl);
  lastResultUrl = URL.createObjectURL(resultBlob);
  $('result-img').src = lastResultUrl;
  $('btn-download').href = lastResultUrl;
  $('btn-download').download = resultName;
  const secs = (tEnd - tStart) / 1000;
  $('result-info').textContent =
    `${resultName} · ${fmtBytes(file.length)} · ${dec.K} blokker, ${dec.symbols} symboler · ` +
    `overført på ${fmtClock(tEnd - tStart)} (${fmtMBs(file.length / Math.max(0.001, secs))} MB/s) · ` +
    (ok ? 'kontrollsum OK ✔' : 'KONTROLLSUM FEILER – filen kan være skadet');
  $('result').hidden = false;
  setStatus(ok ? `Ferdig! Alt mottatt (${dec.K} blokker).` : 'Ferdig, men kontrollsummen stemmer ikke.');
  $('result').scrollIntoView({ behavior: 'smooth' });
  if (navigator.vibrate) navigator.vibrate(150);
}

function recvStatusLine(fps) {
  const parts = [`symboler: ${dec.symbols || 0} (QR ${symQr}, farger ${symGrid})`];
  if (dec.K) parts.push(`dekodet ${dec.decoded}/${dec.K}`);
  if (gridSeen) parts.push(`rutenett funnet ${gridFound}/${gridSeen}` + (gridLock ? ` (${gridLock[0]}×${gridLock[0]}, ${gridLock[1]} farger, ${gridFixed} byte rettet)` : ''));
  if (fps != null) parts.push(`${fps.toFixed(1)} bilder/s · kamera ${video.videoWidth}×${video.videoHeight}`);
  return parts.join(' · ');
}

function pump() {
  if (!cameraOn) return;
  const now = performance.now();
  if (now - fpsT0 >= 1000) {
    const fps = framesDone / ((now - fpsT0) / 1000);
    framesDone = 0; fpsT0 = now;
    if (!dec.complete) setStatus(recvStatusLine(fps));
  }
  if (!dec.complete && video.readyState >= 2) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (vw && vh) {
      if (grab.width !== vw || grab.height !== vh) { grab.width = vw; grab.height = vh; }
      gctx.drawImage(video, 0, 0, vw, vh);
      const img = gctx.getImageData(0, 0, vw, vh);
      // Både QR-koder og fargerutenett leses i arbeidstråder. Hver tråd får sin egen kopi av bildet.
      // Rutenettet: bruk det som sist ga et gyldig bilde. Ellers prøves feltene og de vanlige valgene etter tur.
      let G, P;
      if (gridLock && now - gridLastOk < 1500) [G, P] = gridLock;
      else {
        const own = [Math.max(24, Math.min(160, +$('opt-rg').value || 96)), $('opt-rp').value === '4' ? 4 : 8];
        const list = [own, ...GRID_CANDIDATES.filter(([g, p]) => g !== own[0] || p !== own[1])];
        [G, P] = list[gridTry++ % list.length];
      }
      const gw = gridWorkers.find((x) => !x.busy);
      // QR-lesingen er tung. Den hviler mens fargerutenettet leverer symboler.
      const w = now - gridLastOk < 1500 ? null : workers.find((x) => !x.busy);
      if (gw) {
        const buf = w ? new Uint8ClampedArray(img.data).buffer : img.data.buffer;
        gw.busy = true; gridSeen++;
        gw.postMessage({ width: vw, height: vh, buffer: buf, G, P }, [buf]);
      }
      if (w) {
        w.busy = true;
        w.postMessage({ width: vw, height: vh, buffer: img.data.buffer }, [img.data.buffer]);
      }
    }
  }
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(pump);
  else requestAnimationFrame(pump);
}

async function listCameras() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    const sel = $('opt-camera');
    const cur = stream?.getVideoTracks()[0]?.getSettings().deviceId;
    sel.innerHTML = '';
    devs.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId; o.textContent = d.label || `Kamera ${i + 1}`;
      if (d.deviceId === cur) o.selected = true;
      sel.appendChild(o);
    });
    sel.hidden = devs.length < 2;
  } catch {}
}

async function startCamera(deviceId) {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('Kameraet krever HTTPS (eller localhost) og en nettleser med kamerastøtte.');
    return;
  }
  stopCamera();
  initWorkers();
  const [w, h] = $('opt-res').value.split('x').map(Number);
  const vc = { width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 30 } };
  if (deviceId) vc.deviceId = { exact: deviceId };
  else vc.facingMode = { ideal: 'environment' };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: vc, audio: false });
  } catch (e) {
    setStatus('Fikk ikke tilgang til kameraet: ' + e.message);
    return;
  }
  const track = stream.getVideoTracks()[0];
  try {
    const caps = track.getCapabilities?.() || {};
    if (caps.focusMode?.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
  } catch {}
  video.srcObject = stream;
  await video.play().catch(() => {});
  cameraOn = true;
  $('video-hint').hidden = true;
  $('btn-camera').textContent = 'Stopp kamera';
  keepAwake(true);
  listCameras();
  fpsT0 = performance.now(); framesDone = 0;
  pump();
}

function stopCamera() {
  cameraOn = false;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  $('video-hint').hidden = false;
  $('btn-camera').textContent = 'Start kamera';
  if (!tx.playing) keepAwake(false);
}

function resetReceiver() {
  dec = new Decoder();
  tStart = 0; tEnd = 0; symQr = 0; symGrid = 0; gridFound = 0; gridSeen = 0; gridFixed = 0; gridLock = null; gridLastOk = 0;
  $('result').hidden = true;
  updateProgressText();
  drawChunkMap();
  setStatus(cameraOn ? 'Venter på symboler …' : 'Kameraet er av');
}

$('btn-camera').onclick = () => (cameraOn ? stopCamera() : startCamera($('opt-camera').value || undefined));
$('opt-camera').onchange = () => cameraOn && startCamera($('opt-camera').value);
$('opt-res').onchange = () => cameraOn && startCamera($('opt-camera').value || undefined);
for (const id of ['opt-rg', 'opt-rp']) {
  $(id).addEventListener('change', () => {
    try { localStorage.setItem('qrsend4-recv', JSON.stringify({ rg: $('opt-rg').value, rp: $('opt-rp').value })); } catch {}
    resetReceiver();
  });
}
$('btn-reset').onclick = resetReceiver;

$('btn-share').onclick = async () => {
  if (!resultBlob) return;
  const f = new File([resultBlob], resultName, { type: resultBlob.type });
  if (navigator.canShare?.({ files: [f] })) {
    try { await navigator.share({ files: [f], title: resultName }); } catch {}
  } else {
    $('btn-download').click();
  }
};

window.addEventListener('resize', drawChunkMap);

// ---------------------------------------------------------------- init
loadSettings();
try {
  const r = JSON.parse(localStorage.getItem('qrsend4-recv') || '{}');
  if (r.rg) $('opt-rg').value = r.rg;
  if (r.rp) $('opt-rp').value = r.rp;
} catch {}
let startTab = 'send';
try { startTab = new URLSearchParams(location.search).get('mode') || localStorage.getItem('qrsend4-tab') || 'send'; } catch {}
showTab(startTab === 'recv' ? 'recv' : 'send');
drawChunkMap();
updateProgressText();
if (!window.isSecureContext) setStatus('Obs: siden er ikke lastet over HTTPS – kameraet vil ikke virke her.');
