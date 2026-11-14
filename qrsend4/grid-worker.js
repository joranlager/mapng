// Leser fargerutenettet i en egen tråd: finner rammen, leser cellene, retter feil (Reed-Solomon).
import { decodeGrid, gridCapacity } from './grid.js';
import { rsDecodeFrame } from './rs.js';

self.onmessage = (e) => {
  const { width, height, buffer, G, P } = e.data;
  let found = false, bytes = null, fixed = 0;
  try {
    const r = decodeGrid({ width, height, data: new Uint8ClampedArray(buffer) }, G, P);
    found = r.found;
    if (r.bytes) {
      const d = rsDecodeFrame(r.bytes, gridCapacity(G, P));
      if (d) { bytes = d.data; fixed = d.fixed; }
    }
  } catch (err) { /* ugyldig bilde */ }
  self.postMessage({ type: 'result', found, bytes, fixed, G, P }, bytes ? [bytes.buffer] : []);
};
self.postMessage({ type: 'ready' });
