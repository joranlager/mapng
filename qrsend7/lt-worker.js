// LT-dekoderen kjører her, i en egen tråd: kamerabildet og siden fryser ikke under kjedereaksjonen.
import { Decoder, parseSymbol } from './protocol.js';

const dec = new Decoder();
let lastPost = 0, finishedTid = null, dirty = false;

function postState(force) {
  const now = performance.now();
  if (!force && now - lastPost < 80) { dirty = true; return; }
  lastPost = now; dirty = false;
  self.postMessage({
    type: 'state', tid: dec.tid, K: dec.K, B: dec.B, streamLen: dec.streamLen,
    decoded: dec.decoded, symbols: dec.symbols, dups: dec.dups,
    status: dec.status ? dec.status.slice() : null,
  });
}
setInterval(() => { if (dirty) postState(true); }, 100);

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'reset') { dec.reset(); finishedTid = null; postState(true); return; }
  if (m.type !== 'code') return;
  const sym = parseSymbol(new Uint8Array(m.buffer));
  if (!sym || sym.tid === finishedTid) return;
  const r = dec.add(sym);
  if (r === 'other') return;
  if (dec.complete) {
    finishedTid = dec.tid;
    postState(true);
    let res;
    try { res = dec.assemble(); } catch (err) { res = { meta: { name: 'fil' }, file: new Uint8Array(0), ok: false }; }
    self.postMessage({
      type: 'done', meta: res.meta, ok: res.ok, file: res.file.buffer,
      symbols: dec.symbols, K: dec.K, byGauss: dec.byGauss,
      direct: dec.status.filter((v) => v === 1).length,
    }, [res.file.buffer]);
  } else postState(false);
};
self.postMessage({ type: 'ready' });
