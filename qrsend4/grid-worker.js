// Leser fargerutenettet i en egen tråd, slik at hovedtråden og kameraet ikke venter.
import { decodeGrid } from './grid.js';

self.onmessage = (e) => {
  const { width, height, buffer, G, P } = e.data;
  let r;
  try {
    r = decodeGrid({ width, height, data: new Uint8ClampedArray(buffer) }, G, P);
  } catch (err) {
    r = { found: false, bytes: null };
  }
  self.postMessage({ type: 'result', found: r.found, bytes: r.bytes }, r.bytes ? [r.bytes.buffer] : []);
};
self.postMessage({ type: 'ready' });
