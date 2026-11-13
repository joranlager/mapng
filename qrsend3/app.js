import qrcode from './vendor/qrcode.mjs';
import {
  buildStream, makeChunks, parseChunk, bytesToBinaryString, Assembler,
} from './protocol.js';

const $ = (id) => document.getElementById(id);
const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1048576).toFixed(2)} MB`);
const fmtTime = (s) => (s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`);

// ---------------------------------------------------------------- tabs
function showTab(name) {
  $('tab-send').setAttribute('aria-selected', name === 'send');
  $('tab-recv').setAttribute('aria-selected', name === 'recv');
  $('view-send').hidden = name !== 'send';
  $('view-recv').hidden = name !== 'recv';
  if (name !== 'recv') stopCamera();
  try { localStorage.setItem('qrsend3-tab', name); } catch {}
}
$('tab-send').onclick = () => showTab('send');
$('tab-recv').onclick = () => showTab('recv');

// ---------------------------------------------------------------- wake lock
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
  if (document.visibilityState === 'visible' && (playing || cameraOn)) keepAwake(true);
});

// =====================================================================
// SENDER
// =====================================================================
let sourceFile = null;
let payloadBytes = null; // Uint8Array that will be sent
let payloadType = '';
let payloadName = '';
let prepareToken = 0;

const opt = {
  format: $('opt-format'), maxSide: $('opt-maxside'), quality: $('opt-quality'),
  perPacket: $('opt-perpacket'), rounds: $('opt-rounds'), chunk: $('opt-chunk'), interval: $('opt-interval'), ecc: $('opt-ecc'),
};

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('qrsend3-opts') || '{}');
    for (const k in opt) if (s[k] != null) opt[k].value = s[k];
  } catch {}
  $('out-quality').textContent = opt.quality.value;
}
function saveSettings() {
  try {
    const s = {};
    for (const k in opt) s[k] = opt[k].value;
    localStorage.setItem('qrsend3-opts', JSON.stringify(s));
  } catch {}
}

$('file').addEventListener('change', (e) => {
  sourceFile = e.target.files[0] || null;
  if (sourceFile) $('file-label').textContent = sourceFile.name;
  prepare();
});
for (const k of ['format', 'maxSide', 'quality']) opt[k].addEventListener('input', () => { saveSettings(); prepare(); });
for (const k of ['perPacket', 'chunk', 'interval', 'ecc']) opt[k].addEventListener('input', () => { saveSettings(); updateEstimate(); });
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

function canvasToBlob(canvas, type, q) {
  return new Promise((res) => canvas.toBlob(res, type, q));
}

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
    const w0 = img.width, h0 = img.height;
    const maxSide = Math.max(16, +opt.maxSide.value || 1600);
    const scale = Math.min(1, maxSide / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * scale)), h = Math.max(1, Math.round(h0 * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    let blob = await canvasToBlob(c, format, +opt.quality.value);
    if (!blob || blob.type !== format) blob = await canvasToBlob(c, 'image/jpeg', +opt.quality.value);
    bytes = new Uint8Array(await blob.arrayBuffer());
    type = blob.type;
    const ext = type === 'image/webp' ? 'webp' : 'jpg';
    name = name.replace(/\.[^.]+$/, '') + '.' + ext;
  }
  if (token !== prepareToken) return;
  payloadBytes = bytes; payloadType = type; payloadName = name;
  const blobUrl = URL.createObjectURL(new Blob([bytes], { type }));
  const prev = $('preview');
  if (prev.dataset.url) URL.revokeObjectURL(prev.dataset.url);
  prev.src = blobUrl; prev.dataset.url = blobUrl;
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
  const stream = 2 + 120 + payloadBytes.length;
  const chunks = Math.ceil(stream / chunk);
  const rounds = Math.max(1, +opt.rounds.value || 3);
  const h1 = Math.ceil(chunks / 2), h2 = chunks - h1;
  const p1 = Math.ceil(h1 / per), p2 = Math.ceil(h2 / per);
  const secs = ((p1 + p2) * rounds * interval) / 1000;
  const rate = (per * chunk) / (interval / 1000);
  $('estimate').textContent =
    `${chunks} QR-koder: første halvdel ${h1} (${p1} pakker), andre halvdel ${h2} (${p2} pakker), à ${per} per pakke. ` +
    `${rounds} runder per halvdel tar ca. ${fmtTime(secs)} til sammen (${fmtBytes(Math.round(rate))}/s).`;
  $('btn-start').disabled = false;
}

// ---------------------------------------------------------------- player
let playing = false, paused = false;
let chunks = [], qrCache = new Map(), order = [], packetCount = 0, packetIdx = 0, loop = 0, timer = 0;
// Halvdeler: alle rundene på første halvdel sendes ferdig før andre halvdel.
let halves = [], half = 0, round = 0, rounds = 3, cycle = 0;
let perPacket = 10, interval = 300, ecc = 'M';
const pc = $('player-canvas');
const pctx = pc.getContext('2d', { alpha: false });

function qrCanvasFor(i) {
  let c = qrCache.get(i);
  if (c) return c;
  const qr = qrcode(0, ecc);
  qr.addData(bytesToBinaryString(chunks[i]), 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  c = document.createElement('canvas');
  c.width = n; c.height = n;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(n, n);
  for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) {
    const v = qr.isDark(r, col) ? 0 : 255, o = (r * n + col) * 4;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = v; img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  qrCache.set(i, c);
  return c;
}

// Rekkefølgen for gjeldende halvdel og runde. Første runde i rekkefølge, deretter blandet,
// så en kode som var vanskelig å lese et sted på skjermen havner et annet sted neste runde.
function setHalfOrder() {
  const ids = halves[half];
  order = buildOrder(ids.length, round + rounds * cycle).map((k) => ids[k]);
  packetCount = Math.ceil(order.length / perPacket);
}

// Seeded shuffle so each loop groups / positions chunks differently.
function buildOrder(n, seed) {
  const a = Array.from({ length: n }, (_, i) => i);
  if (seed === 0) return a;
  let s = seed * 2654435761 >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
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
  if (!playing) return;
  const W = pc.width, barH = Math.round($('player-bar').offsetHeight * (window.devicePixelRatio || 1));
  const H = pc.height - barH;
  pctx.fillStyle = '#fff';
  pctx.fillRect(0, 0, W, pc.height);
  const start = packetIdx * perPacket;
  const ids = order.slice(start, start + perPacket);
  const g = bestGrid(perPacket, W, H);
  const offX = (W - g.cols * g.cell) / 2, offY = (H - g.rows * g.cell) / 2;
  pctx.imageSmoothingEnabled = false;
  ids.forEach((ci, k) => {
    const q = qrCanvasFor(ci);
    const n = q.width + 6; // 3 modules quiet zone each side
    const mod = Math.max(1, Math.floor(g.cell / n));
    const size = mod * q.width;
    const x = Math.round(offX + (k % g.cols) * g.cell + (g.cell - size) / 2);
    const y = Math.round(offY + Math.floor(k / g.cols) * g.cell + (g.cell - size) / 2);
    pctx.drawImage(q, x, y, size, size);
  });
  $('player-status').textContent =
    `Halvdel ${half + 1}/2 · runde ${round + 1}/${rounds} · pakke ${packetIdx + 1}/${packetCount}` +
    (cycle ? ` · gjennomgang ${cycle + 1}` : '') + ` · ${interval} ms · ${chunks.length} koder`;
}

function tick() {
  if (!playing || paused) return;
  packetIdx++;
  if (packetIdx >= packetCount) {
    packetIdx = 0; loop++;
    round++;
    if (round >= rounds) {           // denne halvdelen er ferdig sendt
      round = 0;
      half++;
      if (half >= halves.length) { half = 0; cycle++; }   // begge ferdige: begynn på nytt
    }
    setHalfOrder();
  }
  drawPacket();
  // pre-render the next packet's QR codes while idle
  const ns = ((packetIdx + 1) % packetCount) * perPacket;
  for (const ci of order.slice(ns, ns + perPacket)) qrCanvasFor(ci);
  timer = setTimeout(tick, interval);
}

function startPlayer() {
  if (!payloadBytes) return;
  const chunkSize = Math.max(50, +opt.chunk.value || 400);
  perPacket = Math.max(1, +opt.perPacket.value || 10);
  interval = Math.max(30, +opt.interval.value || 300);
  ecc = opt.ecc.value;
  const id = (crypto.getRandomValues(new Uint32Array(1))[0]) >>> 0;
  const stream = buildStream(payloadBytes, { name: payloadName, type: payloadType });
  try {
    chunks = makeChunks(stream, chunkSize, id);
  } catch (e) { alert(e.message); return; }
  qrCache = new Map();
  rounds = Math.max(1, +opt.rounds.value || 3);
  const h = Math.ceil(chunks.length / 2);
  halves = [[...Array(h).keys()], [...Array(chunks.length - h).keys()].map((i) => i + h)].filter((x) => x.length);
  half = 0; round = 0; cycle = 0;
  packetIdx = 0; loop = 0; paused = false; playing = true;
  setHalfOrder();
  $('btn-pause').textContent = 'Pause';
  $('player').hidden = false;
  document.documentElement.requestFullscreen?.().catch(() => {});
  keepAwake(true);
  resizePlayer();
  clearTimeout(timer);
  timer = setTimeout(tick, interval);
}

function stopPlayer() {
  playing = false;
  clearTimeout(timer);
  $('player').hidden = true;
  keepAwake(false);
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}

$('btn-start').onclick = startPlayer;
$('btn-stop').onclick = stopPlayer;
$('btn-pause').onclick = () => {
  paused = !paused;
  $('btn-pause').textContent = paused ? 'Fortsett' : 'Pause';
  if (!paused) { clearTimeout(timer); timer = setTimeout(tick, interval); }
};
$('btn-slower').onclick = () => { interval = Math.min(5000, Math.round(interval * 1.25)); drawPacket(); };
$('btn-faster').onclick = () => { interval = Math.max(30, Math.round(interval / 1.25)); drawPacket(); };
window.addEventListener('resize', () => playing && resizePlayer());
document.addEventListener('keydown', (e) => { if (playing && e.key === 'Escape') stopPlayer(); });

// =====================================================================
// RECEIVER
// =====================================================================
const video = $('video');
let stream = null, cameraOn = false, assembler = null, done = false;
let workers = [], readyWorkers = 0, framesDone = 0, codesSeen = 0, fpsT0 = performance.now();
let lastResultUrl = null, resultBlob = null, resultName = '';
const grab = document.createElement('canvas');
const gctx = grab.getContext('2d', { willReadFrequently: true });

function initWorkers() {
  if (workers.length) return;
  const n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
  for (let i = 0; i < n; i++) {
    const w = new Worker('decoder-worker.js');
    w.busy = true; // until ready
    w.spare = null;
    w.onmessage = (e) => onWorkerMessage(w, e.data);
    w.onerror = (e) => setStatus('Feil i dekoder: ' + (e.message || e));
    workers.push(w);
  }
}

function onWorkerMessage(w, msg) {
  if (msg.type === 'ready') { w.busy = false; readyWorkers++; return; }
  if (msg.type === 'error') { setStatus('Kunne ikke laste QR-dekoderen: ' + msg.message); return; }
  if (msg.type === 'result') {
    w.busy = false;
    w.spare = msg.buffer;
    framesDone++;
    for (const bytes of msg.codes) onCode(bytes);
  }
}

function onCode(bytes) {
  const c = parseChunk(bytes);
  if (!c) return;
  codesSeen++;
  if (!assembler || assembler.id !== c.id) {
    // A new transfer started: switch to it.
    assembler = new Assembler(c.id, c.count);
    done = false;
    $('result').hidden = true;
  }
  if (done) return;
  if (assembler.add(c)) {
    drawChunkMap();
    if (assembler.complete) finish();
  }
}

function setStatus(t) { $('recv-status').textContent = t; }

function drawChunkMap() {
  const cm = $('chunk-map');
  const dpr = window.devicePixelRatio || 1;
  cm.width = Math.round(cm.clientWidth * dpr); cm.height = Math.round(40 * dpr);
  const ctx = cm.getContext('2d');
  const css = getComputedStyle(document.documentElement);
  ctx.fillStyle = css.getPropertyValue('--missing'); ctx.fillRect(0, 0, cm.width, cm.height);
  if (!assembler) return;
  const n = assembler.count, w = cm.width / n;
  ctx.fillStyle = css.getPropertyValue('--ok');
  for (let i = 0; i < n; i++) if (assembler.parts[i]) ctx.fillRect(Math.floor(i * w), 0, Math.ceil(w), cm.height);
  $('progress-bar').style.width = `${(100 * assembler.received) / n}%`;
}

function updateStats() {
  if (!cameraOn) return;
  const now = performance.now(), dt = (now - fpsT0) / 1000;
  if (dt >= 1) {
    const fps = framesDone / dt;
    framesDone = 0; fpsT0 = now;
    const vw = video.videoWidth, vh = video.videoHeight;
    const prog = assembler ? `${assembler.received}/${assembler.count} biter` : 'ingen biter ennå';
    const miss = assembler && !done && assembler.received > assembler.count * 0.8
      ? ` · mangler: ${assembler.missing().slice(0, 12).join(', ')}${assembler.missing().length > 12 ? ' …' : ''}` : '';
    if (!done) setStatus(`${prog} · ${fps.toFixed(1)} bilder/s analysert · ${vw}×${vh}${miss}`);
  }
}

function pump() {
  if (!cameraOn) return;
  updateStats();
  if (!done && video.readyState >= 2) {
    const w = workers.find((x) => !x.busy);
    if (w) {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (grab.width !== vw || grab.height !== vh) { grab.width = vw; grab.height = vh; }
      gctx.drawImage(video, 0, 0, vw, vh);
      const img = gctx.getImageData(0, 0, vw, vh);
      w.busy = true;
      w.postMessage({ width: vw, height: vh, buffer: img.data.buffer }, [img.data.buffer]);
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
  const video_c = { width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 30 } };
  if (deviceId) video_c.deviceId = { exact: deviceId };
  else video_c.facingMode = { ideal: 'environment' };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: video_c, audio: false });
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
  if (!playing) keepAwake(false);
}

$('btn-camera').onclick = () => (cameraOn ? stopCamera() : startCamera($('opt-camera').value || undefined));
$('opt-camera').onchange = () => cameraOn && startCamera($('opt-camera').value);
$('opt-res').onchange = () => cameraOn && startCamera($('opt-camera').value || undefined);
$('btn-reset').onclick = () => {
  assembler = null; done = false; codesSeen = 0;
  $('result').hidden = true; $('progress-bar').style.width = '0';
  drawChunkMap();
  setStatus('Venter på QR-koder …');
};

function finish() {
  done = true;
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
  setStatus(ok ? `Ferdig! ${assembler.count}/${assembler.count} biter mottatt.` : 'Ferdig, men kontrollsummen stemmer ikke.');
  $('result').scrollIntoView({ behavior: 'smooth' });
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
try { startTab = new URLSearchParams(location.search).get('mode') || localStorage.getItem('qrsend3-tab') || 'send'; } catch {}
showTab(startTab === 'recv' ? 'recv' : 'send');
drawChunkMap();
if (!window.isSecureContext) {
  setStatus('Obs: siden er ikke lastet over HTTPS – kameraet vil ikke virke her.');
}
