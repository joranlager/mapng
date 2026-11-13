import qrcode from './vendor/qrcode.mjs';
import {
  makeChunks, parseChunk, bytesToBinaryString, Assembler, makeAck, parseAck, ACK_IDS_PER_CODE,
} from './protocol.js';

const $ = (id) => document.getElementById(id);
const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1048576).toFixed(2)} MB`);
const fmtTime = (s) => (s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`);

const ACK_FRAME_MS = 300;       // hvor ofte mottakeren bytter kvitteringsbilde
const ACK_AFTER_DONE_MS = 8000; // mottakeren viser kvitteringer så lenge etter at alt er mottatt
const ACK_GRACE_MS = 1000;     // avsender venter så lenge på kvitteringer før en ny runde
const ACK_REPEAT = 2;          // hver ny id kvitteres i minst så mange kvitteringsbilder
const ACK_MIN_AGE_MS = 200;     // kvittering godtas bare for numre avsenderen har vist minst så lenge
const SENDER_SCAN_FPS = 10;     // avsenderen trenger bare å lese kvitteringer

// ---------------------------------------------------------------- tabs
function showTab(name) {
  $('tab-send').setAttribute('aria-selected', name === 'send');
  $('tab-recv').setAttribute('aria-selected', name === 'recv');
  $('view-send').hidden = name !== 'send';
  $('view-recv').hidden = name !== 'recv';
  if (name !== 'recv') stopReceiver();
  try { localStorage.setItem('qrsend2-tab', name); } catch {}
}
$('tab-send').onclick = () => showTab('send');
$('tab-recv').onclick = () => showTab('recv');

// ---------------------------------------------------------------- wake lock
let wakeLock = null, wakeWanted = false;
async function keepAwake(on) {
  wakeWanted = on;
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
  if (document.visibilityState === 'visible' && wakeWanted) keepAwake(true);
});


// ---------------------------------------------------------------- QR drawing
function qrMatrixCanvas(bytes, ecc) {
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

// Tegner QR-koder i et rutenett med `slots` plasser over hele lerretet – bare QR-koder på hvitt.
function drawQrGrid(canvas, ctx, qrs, slots) {
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  const g = bestGrid(slots, W, H);
  const offX = (W - g.cols * g.cell) / 2, offY = (H - g.rows * g.cell) / 2;
  ctx.imageSmoothingEnabled = false;
  qrs.forEach((q, k) => {
    const mod = Math.max(1, Math.floor(g.cell / (q.width + 6)));
    const size = mod * q.width;
    const x = Math.round(offX + (k % g.cols) * g.cell + (g.cell - size) / 2);
    const y = Math.round(offY + Math.floor(k / g.cols) * g.cell + (g.cell - size) / 2);
    ctx.drawImage(q, x, y, size, size);
  });
}

function fitCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.round(c.clientWidth * dpr);
  c.height = Math.round(c.clientHeight * dpr);
}

// ---------------------------------------------------------------- camera scanner
// Leser QR-koder fra et kamera i Web Workers (zxing-cpp/WebAssembly).
class Scanner {
  constructor(video, onCodes, { workers = 2, maxFps = 0 } = {}) {
    this.video = video;
    this.onCodes = onCodes;
    this.maxFps = maxFps;
    this.nWorkers = workers;
    this.workers = [];
    this.stream = null;
    this.on = false;
    this.frames = 0;
    this.lastGrab = 0;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.onError = () => {};
  }
  initWorkers() {
    if (this.workers.length) return;
    for (let i = 0; i < this.nWorkers; i++) {
      const w = new Worker('decoder-worker.js');
      w.busy = true;
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'ready') w.busy = false;
        else if (m.type === 'error') this.onError('Kunne ikke laste QR-dekoderen: ' + m.message);
        else if (m.type === 'result') {
          w.busy = false;
          this.frames++;
          if (this.on && m.codes.length) this.onCodes(m.codes);
        }
      };
      w.onerror = (e) => this.onError('Feil i dekoder: ' + (e.message || e));
      this.workers.push(w);
    }
  }
  async start({ deviceId, res = '1280x720' } = {}) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Kameraet krever HTTPS og en nettleser med kamerastøtte.');
    this.stop();
    this.initWorkers();
    const [w, h] = res.split('x').map(Number);
    const vc = { width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 30 } };
    if (deviceId) vc.deviceId = { exact: deviceId };
    else vc.facingMode = { ideal: 'user' }; // frontkameraet
    this.stream = await navigator.mediaDevices.getUserMedia({ video: vc, audio: false });
    const track = this.stream.getVideoTracks()[0];
    try {
      const caps = track.getCapabilities?.() || {};
      if (caps.focusMode?.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
    } catch {}
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    this.on = true;
    this.pump();
  }
  stop() {
    this.on = false;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }
  deviceId() { return this.stream?.getVideoTracks()[0]?.getSettings().deviceId; }
  pump = () => {
    if (!this.on) return;
    const v = this.video, now = performance.now();
    if (v.readyState >= 2 && (!this.maxFps || now - this.lastGrab >= 1000 / this.maxFps)) {
      const w = this.workers.find((x) => !x.busy);
      if (w) {
        this.lastGrab = now;
        const vw = v.videoWidth, vh = v.videoHeight;
        if (this.canvas.width !== vw || this.canvas.height !== vh) { this.canvas.width = vw; this.canvas.height = vh; }
        this.ctx.drawImage(v, 0, 0, vw, vh);
        const img = this.ctx.getImageData(0, 0, vw, vh);
        w.busy = true;
        w.postMessage({ width: vw, height: vh, buffer: img.data.buffer }, [img.data.buffer]);
      }
    }
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(this.pump);
    else requestAnimationFrame(this.pump);
  };
}

// =====================================================================
// SENDER
// =====================================================================
let sourceFile = null, payloadBytes = null, payloadType = '', payloadName = '', prepareToken = 0;

const opt = {
  format: $('opt-format'), maxSide: $('opt-maxside'), quality: $('opt-quality'),
  perPacket: $('opt-perpacket'), chunk: $('opt-chunk'), interval: $('opt-interval'), ecc: $('opt-ecc'),
  sendRes: $('opt-send-res'),
};
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('qrsend2-opts') || '{}');
    for (const k in opt) if (s[k] != null) opt[k].value = s[k];
  } catch {}
  $('out-quality').textContent = opt.quality.value;
}
function saveSettings() {
  try {
    const s = {};
    for (const k in opt) s[k] = opt[k].value;
    localStorage.setItem('qrsend2-opts', JSON.stringify(s));
  } catch {}
}

$('file').addEventListener('change', (e) => {
  sourceFile = e.target.files[0] || null;
  if (sourceFile) $('file-label').textContent = sourceFile.name;
  prepare();
});
for (const k of ['format', 'maxSide', 'quality']) opt[k].addEventListener('input', () => { saveSettings(); prepare(); });
for (const k of ['perPacket', 'chunk', 'interval', 'ecc', 'sendRes']) opt[k].addEventListener('input', () => { saveSettings(); updateEstimate(); });
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

function updateEstimate() {
  if (!payloadBytes) return;
  const chunk = Math.max(50, +opt.chunk.value || 400);
  const per = Math.max(1, +opt.perPacket.value || 10);
  const interval = Math.max(30, +opt.interval.value || 300);
  const chunksN = Math.ceil((2 + 100 + payloadBytes.length) / chunk);
  const packets = Math.ceil(chunksN / per);
  $('estimate').textContent =
    `${chunksN} QR-koder → ${packets} pakker à ${per}. Første runde tar ca. ${fmtTime((packets * interval) / 1000)}; ` +
    `deretter sendes bare det som mangler.`;
  $('btn-start').disabled = false;
}

// ---------------------------------------------------------------- transfer state
const tx = {
  active: false, paused: false, done: false,
  chunks: [], qrCache: new Map(), acked: null, ackedCount: 0,
  queue: [], round: 0, roundSize: 0, roundSent: 0, current: [],
  perPacket: 10, interval: 300, ecc: 'M', timer: 0, lastAck: 0, t0: 0, sentTotal: 0,
  ackReads: 0, otherReads: 0, camOk: false,
};
const pc = $('player-canvas');
const pctx = pc.getContext('2d', { alpha: false });
const sendScanner = new Scanner($('send-video'), onAckCodes, { workers: 1, maxFps: SENDER_SCAN_FPS });
sendScanner.onError = (m) => console.warn(m);

function qrFor(i) {
  let c = tx.qrCache.get(i);
  if (!c) { c = qrMatrixCanvas(tx.chunks[i], tx.ecc); tx.qrCache.set(i, c); }
  return c;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function unacked() {
  const out = [];
  for (let i = 0; i < tx.chunks.length; i++) if (!tx.acked[i]) out.push(i);
  return out;
}

function startRound() {
  const rest = unacked();
  if (!rest.length) { finishSend(); return false; }
  tx.round++;
  tx.queue = tx.round === 1 ? rest : shuffle(rest);
  tx.roundSize = tx.queue.length;
  tx.roundSent = 0;
  tx.waited = false;
  return true;
}

const acksActive = () => tx.lastAck && performance.now() - tx.lastAck < 3000;

// Neste pakke: de neste ikke-kvitterte bitene i rundens kø.
function nextPacket() {
  const pkt = [];
  while (pkt.length < tx.perPacket) {
    if (!tx.queue.length) {
      if (pkt.length) break;           // send en delvis siste pakke
      // Før ny runde: gi mottakeren tid til å kvittere de siste id-ene, så de ikke sendes på nytt.
      if (tx.round > 0 && !tx.waited && acksActive()) { tx.waited = true; return 'wait'; }
      if (!startRound()) return null;  // alt kvittert
      continue;
    }
    const i = tx.queue.shift();
    tx.roundSent++;
    if (!tx.acked[i]) pkt.push(i);
  }
  return pkt;
}

function resizePlayer() {
  fitCanvas(pc);
  drawPacket();
}

function drawPacket() {
  if (!tx.active) return;
  const now = performance.now();
  for (const i of tx.current) if (!tx.shownAt[i]) tx.shownAt[i] = now;
  drawQrGrid(pc, pctx, tx.current.map(qrFor), tx.perPacket);
  updateSendStatus();
}

function updateSendStatus() {
  const n = tx.chunks.length;
  const ackAge = tx.lastAck ? (performance.now() - tx.lastAck) / 1000 : null;
  let ackTxt;
  if (!tx.camOk) ackTxt = 'kamera av – sender alt i løkke';
  else if (ackAge == null) ackTxt = 'ingen kvittering lest ennå – sikt kameraet mot mottakerens skjerm';
  else if (ackAge < 2) ackTxt = `kvitteringer OK (${tx.ackReads} lest)`;
  else ackTxt = `siste kvittering for ${ackAge.toFixed(0)} s siden – sikt kameraet mot mottakeren`;
  $('player-status').textContent =
    `Runde ${tx.round}: ${Math.min(tx.roundSent, tx.roundSize)}/${tx.roundSize} · mottatt ${tx.ackedCount}/${n} · ${tx.interval} ms · ${ackTxt}`;
  $('send-progress').style.width = `${(100 * tx.ackedCount) / n}%`;
}

function tick() {
  if (!tx.active || tx.paused || tx.done) return;
  const pkt = nextPacket();
  if (!pkt) return;
  clearTimeout(tx.timer);
  if (pkt === 'wait') {
    tx.current = []; tx.waiting = true;
    drawPacket();
    tx.timer = setTimeout(tick, ACK_GRACE_MS);
    return;
  }
  tx.waiting = false;
  tx.current = pkt;
  tx.sentTotal += pkt.length;
  drawPacket();
  tx.timer = setTimeout(tick, tx.interval);
}

function onAckCodes(codes) {
  if (!tx.active) return;
  for (const b of codes) {
    const ids = parseAck(b);
    if (!ids) { tx.otherReads++; continue; }
    tx.ackReads++;
    tx.lastAck = performance.now();
    const n = tx.chunks.length, now = performance.now();
    // Bare numre denne overføringen faktisk har vist (gamle kvitteringer fra en tidligere overføring avvises).
    for (const i of ids) {
      if (i < n && !tx.acked[i] && tx.shownAt[i] && now - tx.shownAt[i] >= ACK_MIN_AGE_MS) { tx.acked[i] = 1; tx.ackedCount++; }
    }
    if (tx.ackedCount === n) { finishSend(); return; }
  }
  // Kvitterte id-er tas bort fra skjermen med en gang.
  if (tx.current.some((i) => tx.acked[i])) {
    tx.current = tx.current.filter((i) => !tx.acked[i]);
    if (!tx.current.length && !tx.paused && !tx.waiting) tick();
    else drawPacket();
  }
  updateSendStatus();
}

async function startSend() {
  if (!payloadBytes) return;
  const chunkSize = Math.max(50, +opt.chunk.value || 400);
  Object.assign(tx, {
    perPacket: Math.max(1, +opt.perPacket.value || 10),
    interval: Math.max(30, +opt.interval.value || 300),
    ecc: opt.ecc.value,
  });
  try {
    tx.chunks = makeChunks(payloadBytes, { name: payloadName, type: payloadType }, chunkSize);
  } catch (e) { alert(e.message); return; }
  Object.assign(tx, {
    qrCache: new Map(), acked: new Uint8Array(tx.chunks.length), shownAt: new Float64Array(tx.chunks.length), ackedCount: 0, queue: [], round: 0,
    roundSize: 0, roundSent: 0, current: [], lastAck: 0, t0: performance.now(), sentTotal: 0,
    ackReads: 0, otherReads: 0, camOk: false, waited: false, waiting: false,
    active: true, paused: false, done: false,
  });
  $('send-report').hidden = true;
  $('done-info').textContent = '';
  $('player').hidden = false;
  document.documentElement.requestFullscreen?.().catch(() => {});
  keepAwake(true);
  resizePlayer();
  try {
    await sendScanner.start({ res: opt.sendRes.value });
    tx.camOk = true;
  } catch (e) {
    $('player-status').textContent = 'Kamera utilgjengelig – sender alt i løkke uten kvitteringer. (' + e.message + ')';
  }
  clearTimeout(tx.timer);
  tick();
  clearInterval(tx.statusTimer);
  tx.statusTimer = setInterval(() => tx.active && !tx.done && updateSendStatus(), 500);
}

function finishSend() {
  if (tx.done) return;
  tx.done = true;
  clearTimeout(tx.timer);
  sendScanner.stop();
  updateSendStatus();
  const secs = (performance.now() - tx.t0) / 1000;
  stopSend();
  $('send-report-title').textContent = '✔ Mottakeren har fått alt';
  $('done-info').textContent =
    `${tx.chunks.length} QR-koder levert på ${fmtTime(secs)} i ${tx.round} runde(r). ` +
    `${tx.sentTotal} koder vist totalt (${(tx.sentTotal / tx.chunks.length).toFixed(2)}× per bit).`;
  if (navigator.vibrate) navigator.vibrate(150);
}

function stopSend() {
  if (!tx.active) return;
  updateSendStatus();
  if (!tx.done) {
    $('send-report-title').textContent = 'Overføringen ble stoppet';
    $('done-info').textContent = `Mottakeren har kvittert ${tx.ackedCount} av ${tx.chunks.length} QR-koder.`;
  }
  $('send-report').hidden = false;
  tx.active = false;
  clearTimeout(tx.timer);
  clearInterval(tx.statusTimer);
  sendScanner.stop();
  $('player').hidden = true;
  keepAwake(false);
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}

$('btn-start').onclick = startSend;
pc.onclick = () => { if (tx.active && confirm('Stoppe overføringen?')) stopSend(); };
function togglePause() {
  tx.paused = !tx.paused;
  if (!tx.paused) { clearTimeout(tx.timer); tx.timer = setTimeout(tick, tx.interval); }
}
window.addEventListener('resize', () => tx.active && resizePlayer());
document.addEventListener('keydown', (e) => {
  if (!tx.active) return;
  if (e.key === 'Escape') stopSend();
  else if (e.key === ' ') { e.preventDefault(); togglePause(); }
  else if (e.key === '+') tx.interval = Math.max(30, Math.round(tx.interval / 1.25));
  else if (e.key === '-') tx.interval = Math.min(5000, Math.round(tx.interval * 1.25));
});

// =====================================================================
// RECEIVER
// =====================================================================
let asm = new Assembler(), done = false, doneAt = 0;
let pending = new Map();    // nye numre -> hvor mange ganger de er kvittert (vises først)
let ackCursor = 0;          // rundgang over alle mottatte numre
let ackTimer = 0, statsT0 = performance.now(), receiving = false;
let lastResultUrl = null, resultBlob = null, resultName = '', ackPer = 10;
const ac = $('ack-canvas');
const actx = ac.getContext('2d', { alpha: false });
const recvWorkers = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
const recvScanner = new Scanner($('video'), onDataCodes, { workers: recvWorkers });
recvScanner.onError = (m) => setStatus(m);

function setStatus(t) { $('recv-status').textContent = t; }
window.qrsendDebug = () => ({ count: asm.count, received: asm.received, missing: asm.count ? [...Array(asm.count).keys()].filter((i) => !asm.parts.has(i)) : null });

function resetAssembler() {
  asm = new Assembler(); done = false; doneAt = 0; pending = new Map(); ackCursor = 0;
  $('result').hidden = true;
}

function onDataCodes(codes) {
  let changed = false;
  for (const b of codes) {
    const c = parseChunk(b);
    if (!c) continue;
    let r = asm.add(c);
    if (r === 'conflict') {           // samme nr med annet innhold: ny overføring
      resetAssembler();
      if (!$('ack-player').hidden || receiving) showAckPlayer();
      r = asm.add(c);
    }
    if (r === 'new') { changed = true; pending.set(c.index, 0); }
  }
  if (changed) {
    drawChunkMap();
    if (asm.complete && !done) finishRecv();
  }
}

function drawChunkMap() {
  const cm = $('chunk-map');
  const dpr = window.devicePixelRatio || 1;
  cm.width = Math.round(cm.clientWidth * dpr); cm.height = Math.round(24 * dpr);
  const ctx = cm.getContext('2d');
  const css = getComputedStyle(document.documentElement);
  ctx.fillStyle = css.getPropertyValue('--missing'); ctx.fillRect(0, 0, cm.width, cm.height);
  const n = asm.count || asm.maxIndex + 1;
  $('progress-bar').style.width = asm.count ? `${(100 * asm.received) / asm.count}%` : '0';
  if (!n) return;
  const w = cm.width / n;
  ctx.fillStyle = css.getPropertyValue('--ok');
  for (const i of asm.parts.keys()) ctx.fillRect(Math.floor(i * w), 0, Math.ceil(w), cm.height);
}

// Ett kvitteringsbilde over hele skjermen: så få QR-koder som mulig (store ruter er lette å lese),
// men opptil ackPer når mange nye numre venter. Hver kode har opptil 11 numre.
// Nye numre først (hvert kvitteres ACK_REPEAT ganger), ledig plass fylles med alle mottatte numre etter tur.
function ackTick() {
  if (receiving && asm.received) {
    const nCodes = Math.max(1, Math.min(ackPer, Math.ceil(pending.size / ACK_IDS_PER_CODE)));
    const cap = nCodes * ACK_IDS_PER_CODE;
    const ids = [...pending.keys()].sort((x, y) => pending.get(x) - pending.get(y)).slice(0, cap);
    for (const id of ids) {
      const n = pending.get(id) + 1;
      if (n >= ACK_REPEAT) pending.delete(id); else pending.set(id, n);
    }
    const all = [...asm.parts.keys()];
    const chosen = new Set(ids);
    for (let k = 0; k < all.length && ids.length < cap; k++) {
      const id = all[(ackCursor + k) % all.length];
      if (!chosen.has(id)) { ids.push(id); chosen.add(id); }
    }
    ackCursor = (ackCursor + cap) % Math.max(1, all.length);
    const qrs = [];
    for (let k = 0; k < ids.length; k += ACK_IDS_PER_CODE) {
      qrs.push(qrMatrixCanvas(makeAck(ids.slice(k, k + ACK_IDS_PER_CODE).sort((x, y) => x - y)), 'M'));
    }
    drawQrGrid(ac, actx, qrs, qrs.length);
    if (done && performance.now() - doneAt > ACK_AFTER_DONE_MS) hideAckPlayer();
  }
  const now = performance.now();
  if (now - statsT0 >= 1000 && recvScanner.on) {
    const fps = recvScanner.frames / ((now - statsT0) / 1000);
    recvScanner.frames = 0; statsT0 = now;
    const v = $('video');
    const prog = asm.count ? `${asm.received}/${asm.count} biter` : asm.received ? `${asm.received} biter (antall kommer med bit 0)` : 'ingen biter ennå';
    if (!done) setStatus(`${prog} · ${fps.toFixed(1)} bilder/s · ${v.videoWidth}×${v.videoHeight}`);
  }
}

function showAckPlayer() {
  $('ack-player').hidden = false;
  fitCanvas(ac);
  drawQrGrid(ac, actx, [], ackPer);
  document.documentElement.requestFullscreen?.().catch(() => {});
}

function hideAckPlayer() {
  $('ack-player').hidden = true;
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  stopReceiver();
}

async function startReceiver({ resume = false } = {}) {
  if (done && !resume) { resetAssembler(); drawChunkMap(); }   // nytt mottak
  ackPer = Math.max(1, Math.min(30, +$('opt-ackper').value || 10));
  try { localStorage.setItem('qrsend2-ackper', ackPer); } catch {}
  receiving = true;
  showAckPlayer();
  try {
    await recvScanner.start({ deviceId: $('opt-camera').value || undefined, res: $('opt-res').value });
  } catch (e) {
    receiving = false;
    hideAckPlayer();
    setStatus('Fikk ikke tilgang til kameraet: ' + e.message);
    return;
  }
  keepAwake(true);
  statsT0 = performance.now(); recvScanner.frames = 0;
  setStatus('Venter på QR-koder … hold frontkameraet mot avsenderens skjerm.');
  clearInterval(ackTimer);
  ackTimer = setInterval(ackTick, ACK_FRAME_MS);
  listCameras();
}

function stopReceiver() {
  receiving = false;
  recvScanner.stop();
  clearInterval(ackTimer); ackTimer = 0;
  if (!tx.active) keepAwake(false);
  if (!done) setStatus(asm.received ? `Stoppet med ${asm.received}${asm.count ? '/' + asm.count : ''} biter.` : 'Kameraet er av');
}

async function listCameras() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    const sel = $('opt-camera'), cur = sel.value;
    sel.innerHTML = '<option value="">Frontkamera (standard)</option>';
    devs.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId; o.textContent = d.label || `Kamera ${i + 1}`;
      sel.appendChild(o);
    });
    if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
    $('camera-label').hidden = devs.length < 2;
  } catch {}
}

$('btn-recv-start').onclick = () => startReceiver();
$('btn-show-acks').onclick = () => startReceiver({ resume: true });
ac.onclick = () => { if (confirm('Stoppe mottaket?')) hideAckPlayer(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('ack-player').hidden) hideAckPlayer(); });
window.addEventListener('resize', () => { if (!$('ack-player').hidden) fitCanvas(ac); drawChunkMap(); });
$('btn-reset').onclick = () => {
  resetAssembler();
  drawChunkMap();
  setStatus(recvScanner.on ? 'Venter på QR-koder …' : 'Kameraet er av');
};

function finishRecv() {
  done = true;
  doneAt = performance.now();
  const { meta, file, ok } = asm.assemble();
  resultName = meta.name || 'bilde';
  resultBlob = new Blob([file], { type: meta.type || 'application/octet-stream' });
  if (lastResultUrl) URL.revokeObjectURL(lastResultUrl);
  lastResultUrl = URL.createObjectURL(resultBlob);
  $('result-img').src = lastResultUrl;
  $('btn-download').href = lastResultUrl;
  $('btn-download').download = resultName;
  $('result-info').textContent =
    `${resultName} · ${fmtBytes(file.length)} · ${asm.count} QR-koder · ` +
    (ok ? 'kontrollsum OK ✔' : 'KONTROLLSUM FEILER – filen kan være skadet');
  $('result').hidden = false;
  setStatus(ok ? `Ferdig! ${asm.count}/${asm.count} biter mottatt.` : 'Ferdig, men kontrollsummen stemmer ikke.');
  if (navigator.vibrate) navigator.vibrate(150);
}

$('btn-share').onclick = async () => {
  if (!resultBlob) return;
  const f = new File([resultBlob], resultName, { type: resultBlob.type });
  if (navigator.canShare?.({ files: [f] })) {
    try { await navigator.share({ files: [f], title: resultName }); } catch {}
  } else {
    $('btn-download').click();
  }
};

// ---------------------------------------------------------------- init
loadSettings();
let startTab = 'send';
try { startTab = new URLSearchParams(location.search).get('mode') || localStorage.getItem('qrsend2-tab') || 'send'; } catch {}
showTab(startTab === 'recv' ? 'recv' : 'send');
try { const v = localStorage.getItem('qrsend2-ackper'); if (v) $('opt-ackper').value = v; } catch {}
drawChunkMap();
if (!window.isSecureContext) setStatus('Obs: siden er ikke lastet over HTTPS – kameraet vil ikke virke her.');
