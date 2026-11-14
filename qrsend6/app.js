import qrcode from './vendor/qrcode.mjs';
import {
  buildStreamBytes, Encoder, Decoder, parseSymbol, bytesToBinaryString,
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
  try { localStorage.setItem('qrsend6-tab', name); } catch {}
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
  perPacket: $('opt-perpacket'), chunk: $('opt-chunk'), interval: $('opt-interval'), ecc: $('opt-ecc'),
  countdown: $('opt-countdown'),
};

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('qrsend6-opts') || '{}');
    for (const k in opt) if (s[k] != null) opt[k].value = s[k];
  } catch {}
  $('out-quality').textContent = opt.quality.value;
}
function saveSettings() {
  try {
    const s = {};
    for (const k in opt) s[k] = opt[k].value;
    localStorage.setItem('qrsend6-opts', JSON.stringify(s));
  } catch {}
}

$('file').addEventListener('change', (e) => {
  sourceFile = e.target.files[0] || null;
  if (sourceFile) $('file-label').textContent = sourceFile.name;
  prepare();
});
for (const k of ['format', 'maxSide', 'quality']) opt[k].addEventListener('input', () => { saveSettings(); prepare(); });
for (const k of ['perPacket', 'chunk', 'interval', 'ecc', 'countdown']) opt[k].addEventListener('input', () => { saveSettings(); updateEstimate(); });
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
  const chunk = Math.max(50, +opt.chunk.value || 380);
  const per = Math.max(1, +opt.perPacket.value || 10);
  const interval = Math.max(30, +opt.interval.value || 300);
  const K = Math.ceil((2 + 120 + payloadBytes.length) / chunk);
  const t = (share) => fmtTime((K / share / per) * (interval / 1000));
  $('estimate').textContent =
    `${K} datakoder først, deretter bare paritetskoder (${per} per pakke, ${fmtBytes(Math.round((per * chunk) / (interval / 1000)))}/s). ` +
    `Datakodene tar ${t(1)}. Mottakeren er ferdig etter ca. ${t(1)} hvis den leser alt, ${t(0.8)} ved 20 % tap, ${t(0.5)} ved 50 % tap.`;
  $('btn-start').disabled = false;
}

// ---------------------------------------------------------------- player
let playing = false, paused = false;
let enc = null, current = [], timer = 0;
let perPacket = 10, interval = 300, ecc = 'M';
const pc = $('player-canvas');
const pctx = pc.getContext('2d', { alpha: false });

function qrCanvas(bytes) {
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

function resizePlayer() {
  const dpr = window.devicePixelRatio || 1;
  pc.width = Math.round(pc.clientWidth * dpr);
  pc.height = Math.round(pc.clientHeight * dpr);
  drawPacket();
}

// Nedtelling før sending: stort tall midt på skjermen, så mottakeren rekker å sikte.
let countdownEnd = 0, countdownLeft = 0;
function drawCountdown() {
  const dpr = window.devicePixelRatio || 1;
  const W = pc.width, H = pc.height - Math.round($('player-bar').offsetHeight * dpr);
  const left = paused ? countdownLeft : Math.max(0, countdownEnd - performance.now());
  pctx.fillStyle = '#fff';
  pctx.fillRect(0, 0, W, pc.height);
  pctx.fillStyle = '#15181d';
  pctx.textAlign = 'center'; pctx.textBaseline = 'middle';
  pctx.font = `700 ${Math.round(Math.min(W, H) * 0.45)}px -apple-system, "Segoe UI", sans-serif`;
  pctx.fillText(String(Math.ceil(left / 1000)), W / 2, H / 2);
  pctx.font = `${Math.round(18 * dpr)}px -apple-system, "Segoe UI", sans-serif`;
  pctx.fillStyle = '#5d6673';
  pctx.fillText('Sendingen starter – sikt mottakerens kamera mot denne skjermen', W / 2, H / 2 + Math.min(W, H) * 0.32);
  $('player-status').textContent = `Starter om ${Math.ceil(left / 1000)} s · ${enc.K} datakoder`;
}
function countdownTick() {
  if (!playing || paused) return;
  if (performance.now() >= countdownEnd) { countdownEnd = 0; tick(); return; }
  drawCountdown();
  timer = setTimeout(countdownTick, 100);
}

function drawPacket() {
  if (!playing) return;
  if (countdownEnd) { drawCountdown(); return; }
  const W = pc.width, barH = Math.round($('player-bar').offsetHeight * (window.devicePixelRatio || 1));
  const H = pc.height - barH;
  pctx.fillStyle = '#fff';
  pctx.fillRect(0, 0, W, pc.height);
  const g = bestGrid(perPacket, W, H);
  const offX = (W - g.cols * g.cell) / 2, offY = (H - g.rows * g.cell) / 2;
  pctx.imageSmoothingEnabled = false;
  current.forEach((q, k) => {
    const n = q.width + 6; // 3 modules quiet zone each side
    const mod = Math.max(1, Math.floor(g.cell / n));
    const size = mod * q.width;
    const x = Math.round(offX + (k % g.cols) * g.cell + (g.cell - size) / 2);
    const y = Math.round(offY + Math.floor(k / g.cols) * g.cell + (g.cell - size) / 2);
    pctx.drawImage(q, x, y, size, size);
  });
  const n = enc.count, K = enc.K;
  $('player-status').textContent = (n <= K ? `Data ${n}/${K}` : `Data ferdig (${K}) · paritet ${n - K}`) +
    ` · ${interval} ms · ${perPacket} per pakke`;
}

// Hver pakke er de neste kodene fra koderen: først alle datakodene, deretter paritetskoder uten ende.
function tick() {
  if (!playing || paused) return;
  current = [];
  for (let k = 0; k < perPacket; k++) current.push(qrCanvas(enc.next()));
  drawPacket();
  timer = setTimeout(tick, interval);
}

function startPlayer() {
  if (!payloadBytes) return;
  const chunkSize = Math.max(50, +opt.chunk.value || 380);
  perPacket = Math.max(1, +opt.perPacket.value || 10);
  interval = Math.max(30, +opt.interval.value || 300);
  ecc = opt.ecc.value;
  const tid = (crypto.getRandomValues(new Uint32Array(1))[0]) >>> 0;
  enc = new Encoder(buildStreamBytes(payloadBytes, { name: payloadName, type: payloadType }), chunkSize, tid);
  if (enc.K > 0xffff) { alert('For mange koder – øk byte per QR-kode eller komprimer bildet mer.'); return; }
  current = []; paused = false; playing = true;
  $('btn-pause').textContent = 'Pause';
  $('player').hidden = false;
  document.documentElement.requestFullscreen?.().catch(() => {});
  keepAwake(true);
  const secs = Math.max(0, Math.min(120, +opt.countdown.value || 0));
  countdownEnd = secs > 0 ? performance.now() + secs * 1000 : 0;
  resizePlayer();
  clearTimeout(timer);
  if (countdownEnd) countdownTick(); else tick();
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
  if (countdownEnd) {
    // Pause under nedtellingen fryser tallet. Fortsett teller videre derfra.
    if (paused) countdownLeft = Math.max(0, countdownEnd - performance.now());
    else { countdownEnd = performance.now() + countdownLeft; clearTimeout(timer); countdownTick(); }
    return;
  }
  if (!paused) { clearTimeout(timer); tick(); }
};
$('btn-slower').onclick = () => { interval = Math.min(5000, Math.round(interval * 1.25)); drawPacket(); };
$('btn-faster').onclick = () => { interval = Math.max(30, Math.round(interval / 1.25)); drawPacket(); };
window.addEventListener('resize', () => playing && resizePlayer());
document.addEventListener('keydown', (e) => { if (playing && e.key === 'Escape') stopPlayer(); });

// =====================================================================
// RECEIVER
// =====================================================================
const video = $('video');
let stream = null, cameraOn = false, dec = new Decoder(), done = false, paritySeen = 0;
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
  const sym = parseSymbol(bytes);
  if (!sym) return;
  codesSeen++;
  if (dec.tid === null || sym.tid !== dec.tid) {
    // Ny overføring: overføringstid regnes fra første mottatte kode.
    done = false; paritySeen = 0;
    tStart = performance.now(); tEnd = 0;
    $('result').hidden = true;
  }
  if (done && sym.tid === dec.tid) return;
  const r = dec.add(sym);
  if (r === 'new' || r === 'redundant') {
    if (!(sym.flags & 1)) paritySeen++;
    drawChunkMap();
    if (dec.complete && !done) finish();
  }
}

function setStatus(t) { $('recv-status').textContent = t; }

// Overføringstid og prosent overført
let tStart = 0, tEnd = 0;
const fmtClock = (ms) => {
  const t = Math.max(0, ms) / 1000, m = Math.floor(t / 60), sec = t - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
};
const fmtMBs = (bps) => (bps / 1048576).toFixed(3);
function updateProgressText() {
  const pct = dec.K ? (100 * dec.decoded) / dec.K : 0;
  $('recv-pct').textContent = `${pct < 100 && pct > 99 ? 99 : Math.floor(pct)} %`;
  const ms = tStart ? (tEnd || performance.now()) - tStart : 0;
  $('recv-time').textContent = fmtClock(ms);
  // Hastighet: mottatte bildedata (byte) per sekund, i MB/s
  const bytes = dec.K ? Math.min(dec.streamLen, dec.decoded * dec.B) : 0;
  $('recv-speed').textContent = fmtMBs(ms > 0 ? bytes / (ms / 1000) : 0);
  $('recv-time-label').textContent = tEnd ? 'overføringstid (ferdig)' : 'overføringstid';
}
setInterval(updateProgressText, 100);

// Kartet viser hvilke plasser i ligningssettet som er fylt (data eller paritet som erstatter data).
function drawChunkMap() {
  const cm = $('chunk-map');
  const dpr = window.devicePixelRatio || 1;
  cm.width = Math.round(cm.clientWidth * dpr); cm.height = Math.round(40 * dpr);
  const ctx = cm.getContext('2d');
  const css = getComputedStyle(document.documentElement);
  ctx.fillStyle = css.getPropertyValue('--missing'); ctx.fillRect(0, 0, cm.width, cm.height);
  $('progress-bar').style.width = dec.K ? `${(100 * dec.decoded) / dec.K}%` : '0';
  if (!dec.K) return;
  const n = dec.K, w = cm.width / n;
  ctx.fillStyle = css.getPropertyValue('--ok');
  for (let i = 0; i < n; i++) if (dec.blocks[i]) ctx.fillRect(Math.floor(i * w), 0, Math.ceil(w), cm.height);
}

function updateStats() {
  if (!cameraOn) return;
  const now = performance.now(), dt = (now - fpsT0) / 1000;
  if (dt >= 1) {
    const fps = framesDone / dt;
    framesDone = 0; fpsT0 = now;
    const vw = video.videoWidth, vh = video.videoHeight;
    const prog = dec.K ? `${dec.decoded}/${dec.K} koder (${paritySeen} fra paritet)` : 'ingen koder ennå';
    if (!done) setStatus(`${prog} · ${fps.toFixed(1)} bilder/s analysert · ${vw}×${vh}`);
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
  dec = new Decoder(); done = false; codesSeen = 0; paritySeen = 0; tStart = 0; tEnd = 0;
  updateProgressText();
  $('result').hidden = true; $('progress-bar').style.width = '0';
  drawChunkMap();
  setStatus('Venter på QR-koder …');
};

function finish() {
  done = true;
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
  $('result-info').textContent =
    `${resultName} · ${fmtBytes(file.length)} · ${dec.K} datakoder, ${dec.symbols} mottatt (${paritySeen} paritet) · ` +
    `overført på ${fmtClock(tEnd - tStart)} (${fmtMBs(file.length / Math.max(0.001, (tEnd - tStart) / 1000))} MB/s) · ` +
    (ok ? 'kontrollsum OK ✔' : 'KONTROLLSUM FEILER – filen kan være skadet');
  $('result').hidden = false;
  setStatus(ok ? `Ferdig! ${dec.K}/${dec.K} koder gjenopprettet.` : 'Ferdig, men kontrollsummen stemmer ikke.');
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
try { startTab = new URLSearchParams(location.search).get('mode') || localStorage.getItem('qrsend6-tab') || 'send'; } catch {}
showTab(startTab === 'recv' ? 'recv' : 'send');
drawChunkMap();
if (!window.isSecureContext) {
  setStatus('Obs: siden er ikke lastet over HTTPS – kameraet vil ikke virke her.');
}
