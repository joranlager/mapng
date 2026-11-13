import qrcode from './vendor/qrcode.mjs';
import {
  buildStream, makeChunks, parseChunk, bytesToBinaryString, Assembler, makeAcks, parseAck,
} from './protocol.js';

const $ = (id) => document.getElementById(id);
const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1048576).toFixed(2)} MB`);
const fmtTime = (s) => (s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`);

const ACK_SEGMENT_BYTES = 80;   // 640 chunks per kvitterings-QR (liten QR = lett å lese på avstand)
const ACK_FRAME_MS = 350;       // hvor ofte mottakeren bytter kvitterings-QR
const SENDER_SCAN_FPS = 8;      // avsenderen trenger bare å lese kvitteringer

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
  id: 0, chunks: [], qrCache: new Map(), acked: null, ackedCount: 0,
  queue: [], round: 0, roundSize: 0, roundSent: 0, current: [],
  perPacket: 10, interval: 300, ecc: 'M', timer: 0, lastAck: 0, t0: 0, sentTotal: 0,
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
  return true;
}

// Neste pakke: de neste ikke-kvitterte bitene i rundens kø.
function nextPacket() {
  const pkt = [];
  while (pkt.length < tx.perPacket) {
    if (!tx.queue.length) {
      if (pkt.length) break;           // send en delvis siste pakke
      if (!startRound()) return null;  // alt kvittert
      continue;
    }
    const i = tx.queue.shift();
    tx.roundSent++;
    if (!tx.acked[i]) pkt.push(i);
  }
  return pkt;
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

function resizePlayer() {
  const dpr = window.devicePixelRatio || 1;
  pc.width = Math.round(pc.clientWidth * dpr);
  pc.height = Math.round(pc.clientHeight * dpr);
  drawPacket();
}

function drawPacket() {
  if (!tx.active) return;
  const dpr = window.devicePixelRatio || 1;
  const W = pc.width, H = pc.height - Math.round($('player-bar').offsetHeight * dpr);
  pctx.fillStyle = '#fff';
  pctx.fillRect(0, 0, W, pc.height);
  const g = bestGrid(tx.perPacket, W, H);
  const offX = (W - g.cols * g.cell) / 2, offY = (H - g.rows * g.cell) / 2;
  pctx.imageSmoothingEnabled = false;
  tx.current.forEach((ci, k) => {
    const q = qrFor(ci);
    const mod = Math.max(1, Math.floor(g.cell / (q.width + 6)));
    const size = mod * q.width;
    const x = Math.round(offX + (k % g.cols) * g.cell + (g.cell - size) / 2);
    const y = Math.round(offY + Math.floor(k / g.cols) * g.cell + (g.cell - size) / 2);
    pctx.drawImage(q, x, y, size, size);
  });
  updateSendStatus();
}

function updateSendStatus() {
  const n = tx.chunks.length;
  const ackAge = tx.lastAck ? (performance.now() - tx.lastAck) / 1000 : null;
  const ackTxt = ackAge == null ? 'ingen kvittering lest ennå' : ackAge < 2 ? 'kvitteringer leses' : `siste kvittering for ${ackAge.toFixed(0)} s siden`;
  $('player-status').textContent =
    `Runde ${tx.round} · ${Math.min(tx.roundSent, tx.roundSize)}/${tx.roundSize} · mottatt ${tx.ackedCount}/${n} · ${tx.interval} ms · ${ackTxt}`;
  $('send-progress').style.width = `${(100 * tx.ackedCount) / n}%`;
}

function tick() {
  if (!tx.active || tx.paused || tx.done) return;
  const pkt = nextPacket();
  if (!pkt) return;
  tx.current = pkt;
  tx.sentTotal += pkt.length;
  drawPacket();
  tx.timer = setTimeout(tick, tx.interval);
}

function onAckCodes(codes) {
  if (!tx.active) return;
  for (const b of codes) {
    const a = parseAck(b);
    if (!a || a.id !== tx.id || a.count !== tx.chunks.length) continue;
    tx.lastAck = performance.now();
    for (const i of a.indices) if (!tx.acked[i]) { tx.acked[i] = 1; tx.ackedCount++; }
    if (a.complete || tx.ackedCount === tx.chunks.length) { finishSend(); return; }
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
    id: crypto.getRandomValues(new Uint32Array(1))[0] >>> 0,
  });
  try {
    tx.chunks = makeChunks(buildStream(payloadBytes, { name: payloadName, type: payloadType }), chunkSize, tx.id);
  } catch (e) { alert(e.message); return; }
  Object.assign(tx, {
    qrCache: new Map(), acked: new Uint8Array(tx.chunks.length), ackedCount: 0, queue: [], round: 0,
    roundSize: 0, roundSent: 0, current: [], lastAck: 0, t0: performance.now(), sentTotal: 0,
    active: true, paused: false, done: false,
  });
  $('btn-pause').textContent = 'Pause';
  $('player-done').hidden = true;
  $('player').hidden = false;
  document.documentElement.requestFullscreen?.().catch(() => {});
  keepAwake(true);
  resizePlayer();
  try {
    await sendScanner.start({ res: opt.sendRes.value });
  } catch (e) {
    $('player-status').textContent = 'Kamera utilgjengelig – sender alt i løkke uten kvitteringer. (' + e.message + ')';
  }
  clearTimeout(tx.timer);
  tick();
}

function finishSend() {
  if (tx.done) return;
  tx.done = true;
  clearTimeout(tx.timer);
  sendScanner.stop();
  updateSendStatus();
  const secs = (performance.now() - tx.t0) / 1000;
  $('done-info').textContent =
    `${tx.chunks.length} QR-koder levert på ${fmtTime(secs)} i ${tx.round} runde(r). ` +
    `${tx.sentTotal} koder vist totalt (${(tx.sentTotal / tx.chunks.length).toFixed(2)}× per bit).`;
  $('player-done').hidden = false;
  if (navigator.vibrate) navigator.vibrate(150);
}

function stopSend() {
  tx.active = false;
  clearTimeout(tx.timer);
  sendScanner.stop();
  $('player').hidden = true;
  keepAwake(false);
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}

$('btn-start').onclick = startSend;
$('btn-stop').onclick = stopSend;
$('btn-done-close').onclick = stopSend;
$('btn-pause').onclick = () => {
  tx.paused = !tx.paused;
  $('btn-pause').textContent = tx.paused ? 'Fortsett' : 'Pause';
  if (!tx.paused) { clearTimeout(tx.timer); tx.timer = setTimeout(tick, tx.interval); }
};
$('btn-slower').onclick = () => { tx.interval = Math.min(5000, Math.round(tx.interval * 1.25)); updateSendStatus(); };
$('btn-faster').onclick = () => { tx.interval = Math.max(30, Math.round(tx.interval / 1.25)); updateSendStatus(); };
window.addEventListener('resize', () => tx.active && resizePlayer());
document.addEventListener('keydown', (e) => { if (tx.active && e.key === 'Escape') stopSend(); });

// =====================================================================
// RECEIVER
// =====================================================================
let assembler = null, done = false, ackTimer = 0, ackSeg = 0, ackDirty = true, ackList = [];
let statsT0 = performance.now(), lastResultUrl = null, resultBlob = null, resultName = '';
const recvWorkers = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
const recvScanner = new Scanner($('video'), onDataCodes, { workers: recvWorkers });
recvScanner.onError = (m) => setStatus(m);

function setStatus(t) { $('recv-status').textContent = t; }

function onDataCodes(codes) {
  let changed = false;
  for (const b of codes) {
    const c = parseChunk(b);
    if (!c) continue;
    if (!assembler || assembler.id !== c.id) {
      assembler = new Assembler(c.id, c.count);   // ny overføring
      done = false;
      $('result').hidden = true;
      changed = true;
    }
    if (done) continue;
    if (assembler.add(c)) changed = true;
  }
  if (changed) {
    ackDirty = true;
    drawChunkMap();
    if (assembler.complete && !done) finishRecv();
  }
}

function drawChunkMap() {
  const cm = $('chunk-map');
  const dpr = window.devicePixelRatio || 1;
  cm.width = Math.round(cm.clientWidth * dpr); cm.height = Math.round(24 * dpr);
  const ctx = cm.getContext('2d');
  const css = getComputedStyle(document.documentElement);
  ctx.fillStyle = css.getPropertyValue('--missing'); ctx.fillRect(0, 0, cm.width, cm.height);
  $('progress-bar').style.width = assembler ? `${(100 * assembler.received) / assembler.count}%` : '0';
  if (!assembler) return;
  const n = assembler.count, w = cm.width / n;
  ctx.fillStyle = css.getPropertyValue('--ok');
  for (let i = 0; i < n; i++) if (assembler.parts[i]) ctx.fillRect(Math.floor(i * w), 0, Math.ceil(w), cm.height);
}

// Viser kvitterings-QR (bitmap over mottatte biter), roterer mellom segmentene.
function ackTick() {
  if (assembler) {
    if (ackDirty) { ackList = makeAcks(assembler, ACK_SEGMENT_BYTES, done); ackDirty = false; }
    ackSeg = (ackSeg + 1) % ackList.length;
    drawAck(ackList[ackSeg]);
    $('ack-hint').hidden = true;
  }
  const now = performance.now();
  if (now - statsT0 >= 1000 && recvScanner.on && !done) {
    const fps = recvScanner.frames / ((now - statsT0) / 1000);
    recvScanner.frames = 0; statsT0 = now;
    const v = $('video');
    const prog = assembler ? `${assembler.received}/${assembler.count} biter` : 'ingen biter ennå';
    const segs = ackList.length > 1 ? ` · kvittering ${ackSeg + 1}/${ackList.length}` : '';
    setStatus(`${prog} · ${fps.toFixed(1)} bilder/s · ${v.videoWidth}×${v.videoHeight}${segs}`);
  }
}

function drawAck(bytes) {
  const q = qrMatrixCanvas(bytes, 'M');
  const c = $('ack-canvas');
  const dpr = window.devicePixelRatio || 1;
  const S = Math.round(c.clientWidth * dpr);
  if (c.width !== S) { c.width = S; c.height = S; }
  const ctx = c.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, S, S);
  const mod = Math.max(1, Math.floor(S / (q.width + 8)));
  const size = mod * q.width, o = Math.round((S - size) / 2);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(q, o, o, size, size);
}

async function startReceiver(deviceId) {
  try {
    await recvScanner.start({ deviceId, res: $('opt-res').value });
  } catch (e) {
    setStatus('Fikk ikke tilgang til kameraet: ' + e.message);
    return;
  }
  $('btn-camera').textContent = 'Stopp kamera';
  keepAwake(true);
  statsT0 = performance.now(); recvScanner.frames = 0;
  setStatus('Venter på QR-koder … pek frontkameraet mot avsenderens skjerm.');
  clearInterval(ackTimer);
  ackTimer = setInterval(ackTick, ACK_FRAME_MS);
  listCameras();
}

function stopReceiver({ keepAck = false } = {}) {
  recvScanner.stop();
  $('btn-camera').textContent = 'Start kamera';
  if (!keepAck) { clearInterval(ackTimer); ackTimer = 0; }
  if (!tx.active && !keepAck) keepAwake(false);
}

async function listCameras() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    const sel = $('opt-camera'), cur = recvScanner.deviceId();
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

$('btn-camera').onclick = () => (recvScanner.on ? stopReceiver() : startReceiver($('opt-camera').value || undefined));
$('opt-camera').onchange = () => recvScanner.on && startReceiver($('opt-camera').value);
$('opt-res').onchange = () => recvScanner.on && startReceiver($('opt-camera').value || undefined);
$('btn-reset').onclick = () => {
  assembler = null; done = false; ackList = []; ackDirty = true;
  $('result').hidden = true; $('ack-hint').hidden = false;
  const c = $('ack-canvas'); c.getContext('2d').clearRect(0, 0, c.width, c.height);
  drawChunkMap();
  setStatus(recvScanner.on ? 'Venter på QR-koder …' : 'Kameraet er av');
};

function finishRecv() {
  done = true;
  ackDirty = true;
  // Fortsett å vise «ferdig»-kvitteringen så avsenderen ser den; kameraet trengs ikke mer.
  stopReceiver({ keepAck: true });
  const { meta, file, ok } = assembler.assemble();
  resultName = meta.name || 'bilde';
  resultBlob = new Blob([file], { type: meta.type || 'application/octet-stream' });
  if (lastResultUrl) URL.revokeObjectURL(lastResultUrl);
  lastResultUrl = URL.createObjectURL(resultBlob);
  $('result-img').src = lastResultUrl;
  $('btn-download').href = lastResultUrl;
  $('btn-download').download = resultName;
  $('result-info').textContent =
    `${resultName} · ${fmtBytes(file.length)} · ${assembler.count} QR-koder · ` +
    (ok ? 'kontrollsum OK ✔' : 'KONTROLLSUM FEILER – filen kan være skadet');
  $('result').hidden = false;
  setStatus((ok ? 'Ferdig! ' : 'Ferdig, men kontrollsummen stemmer ikke. ') +
    'Hold skjermen mot avsenderen til den viser at overføringen er ferdig.');
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
window.addEventListener('resize', drawChunkMap);

// ---------------------------------------------------------------- init
loadSettings();
let startTab = 'send';
try { startTab = new URLSearchParams(location.search).get('mode') || localStorage.getItem('qrsend2-tab') || 'send'; } catch {}
showTab(startTab === 'recv' ? 'recv' : 'send');
drawChunkMap();
if (!window.isSecureContext) setStatus('Obs: siden er ikke lastet over HTTPS – kameraet vil ikke virke her.');
