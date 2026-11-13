// Decodes camera frames off the main thread with zxing-cpp (WebAssembly).
// Finds many QR codes in one frame.
importScripts('vendor/zxing-reader.js');

ZXingWASM.prepareZXingModule({
  overrides: {
    locateFile: (path, prefix) =>
      path.endsWith('.wasm') ? new URL('vendor/zxing_reader.wasm', self.location.href).href : prefix + path,
  },
  fireImmediately: true,
}).then(
  () => self.postMessage({ type: 'ready' }),
  (e) => self.postMessage({ type: 'error', message: String(e) })
);

const OPTIONS = {
  formats: ['QRCode'],
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  tryDownscale: true,
  maxNumberOfSymbols: 64,
};

self.onmessage = async (e) => {
  const { id, width, height, buffer } = e.data;
  try {
    const img = new ImageData(new Uint8ClampedArray(buffer), width, height);
    const results = await ZXingWASM.readBarcodes(img, OPTIONS);
    const codes = [];
    for (const r of results) if (r.isValid && r.bytes && r.bytes.length) codes.push(r.bytes.slice());
    self.postMessage({ type: 'result', id, codes, buffer }, [buffer]);
  } catch (err) {
    self.postMessage({ type: 'result', id, codes: [], buffer, error: String(err) }, [buffer]);
  }
};
