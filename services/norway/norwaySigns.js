// Norwegian road signs in the export: every sign plate NVDB records
// (services/norway/nvdbRoads.js, features of type 'road_sign'), stood up where
// it stands, on a post, facing its traffic.
//
// A plate is a flat panel with the sign's picture as its texture. The pictures
// are files in the app's /norway_signs folder (one per sign number, listed in
// index.json; scripts/norway/fetch_sign_art.py fills the folder from the NVDB
// Datakatalog and Skiltforskriften). A picture is redrawn as a PNG for the
// level, and a white surround (the regulation's pictures have one) is cleared. Plates
// that carry their own wording (underskilt, 8xx) and speed limits with no
// picture of their own are drawn here. A sign number with no picture is left
// out and counted.
//
// Shapes face their local -Y, as the game's own signs do, so
// yaw = atan2(-dx, dy) turns a plate toward traffic travelling along (dx, dy).
import * as THREE from 'three';
import { ColladaExporter } from '../ColladaExporter.js';

export const NORWAY_SIGNS_INDEX_URL = '/norway_signs/index.json';
export const NORWAY_SIGNS_STORAGE_KEY = 'mapng_norwaySigns';
export const SIGN_ASSET_DIR = 'map_assets/custom_assets/norway_signs';
export const SIGN_BACK_MATERIAL = 'mapng_nosign_back';
export const SIGN_POST_SHAPE = 'mapng_nosign_post.dae';
const MAX_PLATES = 8000;
const POST_REACH_M = 0.6;        // plates this close together share a post
const ROAD_REACH_M = 40;
const KERB_GAP_M = 1.0;          // a sign recorded on the road's centre line stands this far past the road's edge
const STACK_TOP_M = 3.0;
const STACK_GAP_M = 0.04;
const MIN_CLEAR_M = 1.0;         // the lowest plate's underside is at least this high

/** On unless switched off in settings (localStorage mapng_norwaySigns = "0"). */
export function norwaySignsEnabled(storage = globalThis.localStorage) {
  try { return storage?.getItem(NORWAY_SIGNS_STORAGE_KEY) !== '0'; } catch { return true; }
}

let artLoading = null;
/** The sign pictures the app has: { signs: { '202': { file, w?, h? }, ... } }, or null when there are none. */
export function loadSignArt({ fetchImpl = globalThis.fetch, url = NORWAY_SIGNS_INDEX_URL } = {}) {
  if (!artLoading) {
    artLoading = (async () => {
      try {
        const res = await fetchImpl(url);
        if (!res.ok) return null;
        const index = await res.json();
        return index?.signs && Object.keys(index.signs).length ? index : null;
      } catch { return null; }
    })();
  }
  return artLoading;
}
export const forgetSignArt = () => { artLoading = null; };

/**
 * The picture for a sign number: its own, else its number without the trailing
 * letter, else without its last sub-number ("808.319" -> "808"), else the first
 * variant of the number ("521" -> "521.1", "306" -> "306.0"), or null.
 */
export function resolveArt(code, signs) {
  if (!code || !signs) return null;
  let key = String(code);
  for (let i = 0; i < 6; i++) {
    if (signs[key]) return key;
    if (signs[key.toUpperCase()]) return key.toUpperCase();
    if (signs[key.toLowerCase()]) return key.toLowerCase();
    if (/[A-Za-z]$/.test(key)) { key = key.slice(0, -1); continue; }
    if (key.includes('.')) { key = key.slice(0, key.lastIndexOf('.')); continue; }
    break;
  }
  const variants = Object.keys(signs).filter((k) => k.startsWith(`${key}.`))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return variants[0] || null;
}

/** A plate's width in metres, by the kind of sign its number says it is (medium sizes). */
export function signWidthMetres(code, aspect = 1) {
  const n = Number.parseFloat(code) || 0;
  const cls = Math.floor(n / 100);
  if (cls === 1) return 0.9;                       // warning triangles
  if (cls === 2) return n >= 206 && n < 210 ? 0.7 : 0.9;   // give way, stop; priority-road diamonds
  if (cls === 3 || cls === 4) return 0.6;          // prohibition and mandatory discs
  if (cls === 5) return aspect < 0.7 ? 1.0 : 0.6;  // information squares; wide lane boards
  if (cls === 6) return 0.9;
  if (cls === 7) return aspect < 0.5 ? 1.5 : 1.1;  // direction signs
  if (cls === 8) return 0.6;                       // plates under a sign
  if (cls === 9) return aspect > 2 ? 0.25 : 0.5;   // markers
  return 0.6;
}

const isTextPlate = (code) => Math.floor((Number.parseFloat(code) || 0) / 100) === 8;
const safe = (s) => String(s).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'x';

/** A picture's height / width (1 when the index does not say). */
const aspectOf = (entry) => (entry?.w > 0 && entry?.h > 0 ? entry.h / entry.w : 1);

/** FNV-1a, for a short stable name of a drawn face. */
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };

/**
 * The face a plate shows: { key, kind: 'art' | 'text' | 'speed', file?, text?, value?, aspect }, or null
 * when there is nothing to show for it. `aspect` is height / width.
 */
export function faceFor(code, text, signs) {
  const speed = /^(362|366)(\.|$)/.test(code) ? Number.parseInt(String(text || code.split('.')[1] || ''), 10) : NaN;
  if (Number.isFinite(speed) && speed > 0 && speed <= 130) {
    const own = signs?.[`${code.split('.')[0]}.${speed}`];
    if (own) return { key: `art_${safe(`${code.split('.')[0]}.${speed}`)}`, kind: 'art', file: own.file, aspect: aspectOf(own) };
    if (code.startsWith('362')) return { key: `speed_${speed}`, kind: 'speed', value: speed, aspect: 1 };
  }
  if (isTextPlate(code) && text) {
    const lines = Math.min(3, Math.max(1, Math.ceil(String(text).length / 14)));
    return { key: `text_${hash(String(text))}`, kind: 'text', text: String(text), aspect: 0.22 + 0.2 * lines };
  }
  const art = resolveArt(code, signs);
  if (art) return { key: `art_${safe(art)}`, kind: 'art', file: signs[art].file, aspect: aspectOf(signs[art]) };
  if (text) {
    const lines = Math.min(3, Math.max(1, Math.ceil(String(text).length / 14)));
    return { key: `text_${hash(String(text))}`, kind: 'text', text: String(text), aspect: 0.22 + 0.2 * lines };
  }
  return null;
}

/** Road centre lines ([{ nodes: [[x, y], ...], half }]) in a grid: nearest(x, y) -> { cx, cy, ux, uy, d, half }. */
function roadGrid(roads) {
  const CELL = 50;
  const cells = new Map();
  for (const road of roads || []) {
    const nodes = road.nodes || [];
    for (let i = 0; i + 1 < nodes.length; i++) {
      const ax = nodes[i][0], ay = nodes[i][1], bx = nodes[i + 1][0], by = nodes[i + 1][1];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 0.05) continue;
      const seg = { ax, ay, ux: (bx - ax) / len, uy: (by - ay) / len, len, half: Number(road.half) || 3 };
      for (let x = Math.floor(Math.min(ax, bx) / CELL); x <= Math.floor(Math.max(ax, bx) / CELL); x++) {
        for (let y = Math.floor(Math.min(ay, by) / CELL); y <= Math.floor(Math.max(ay, by) / CELL); y++) {
          const k = `${x},${y}`;
          if (!cells.has(k)) cells.set(k, []);
          cells.get(k).push(seg);
        }
      }
    }
  }
  return (x, y, reach = ROAD_REACH_M) => {
    let best = null;
    const r = Math.ceil(reach / CELL);
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
      for (const seg of cells.get(`${Math.floor(x / CELL) + i},${Math.floor(y / CELL) + j}`) || []) {
        const t = Math.max(0, Math.min(seg.len, (x - seg.ax) * seg.ux + (y - seg.ay) * seg.uy));
        const cx = seg.ax + seg.ux * t, cy = seg.ay + seg.uy * t, d = Math.hypot(x - cx, y - cy);
        if (d <= reach && (!best || d < best.d)) best = { cx, cy, ux: seg.ux, uy: seg.uy, d, half: seg.half };
      }
    }
    return best;
  };
}

/**
 * Where every plate goes.
 * features: the map's features (type 'road_sign': one point, tags mapng:sign, mapng:sign_text, mapng:sign_facing)
 * opts: { toWorld(lat, lng) -> [x, y], groundAt(x, y) -> z, roads: [{ nodes, half }], signs (the picture index), leftHandTraffic }
 * Returns { plates: [{ code, face, x, y, z, yaw, width, height }], posts: [{ x, y, z, height }], faces: Map(key -> face),
 *           missing: Map(code -> count), total }.
 */
export function planNorwaySigns(features, { toWorld, groundAt = () => 0, roads = [], signs = null, leftHandTraffic = false } = {}) {
  const nearest = roadGrid(roads);
  const missing = new Map();
  const faces = new Map();
  const groups = new Map();      // post -> its plates
  let total = 0;

  for (const f of features || []) {
    if (f?.type !== 'road_sign' || f.geometry?.length !== 1) continue;
    const code = String(f.tags?.['mapng:sign'] || '');
    if (!code) continue;
    total++;
    const face = faceFor(code, f.tags['mapng:sign_text'], signs);
    if (!face) { missing.set(code, (missing.get(code) || 0) + 1); continue; }
    let [x, y] = toWorld(f.geometry[0].lat, f.geometry[0].lng);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

    // the road it belongs to: which way its traffic runs, and off the carriageway if it was recorded on it
    const road = nearest(x, y);
    let tx = 0, ty = 1;          // the direction of the traffic the plate addresses
    if (road) {
      let rx = x - road.cx, ry = y - road.cy;
      let d = Math.hypot(rx, ry);
      if (d < 0.3) {             // on the centre line: no side recorded, so the driving side of the road's own direction
        rx = leftHandTraffic ? -road.uy : road.uy; ry = leftHandTraffic ? road.ux : -road.ux; d = 1;
      } else { rx /= d; ry /= d; }
      const clear = road.half + KERB_GAP_M;
      if (Math.hypot(x - road.cx, y - road.cy) < clear) { x = road.cx + rx * clear; y = road.cy + ry * clear; }
      // a sign stands on the driving side of the traffic it speaks to
      const onRight = road.ux * ry - road.uy * rx < 0;
      const along = onRight !== leftHandTraffic;
      tx = along ? road.ux : -road.ux; ty = along ? road.uy : -road.uy;
      const facing = f.tags['mapng:sign_facing'];
      if (facing === 'toward') { tx = rx; ty = ry; } else if (facing === 'away') { tx = -rx; ty = -ry; }
    }
    const key = `${Math.round(x / POST_REACH_M)},${Math.round(y / POST_REACH_M)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ code, face, x, y, tx, ty, facing: f.tags['mapng:sign_facing'] || '' });
    faces.set(face.key, face);
  }

  const plates = [];
  const posts = [];
  for (const group of groups.values()) {
    if (plates.length >= MAX_PLATES) break;
    const { x, y } = group[0];
    const z = groundAt(x, y);
    if (!Number.isFinite(z)) continue;
    // plates recorded as facing opposite ways along the road stand back to back: the fewer turn round
    const withN = group.filter((p) => p.facing === 'with').length, againstN = group.filter((p) => p.facing === 'against').length;
    if (withN && againstN) {
      const turn = withN >= againstN ? 'against' : 'with';
      for (const p of group) if (p.facing === turn) { p.tx = -p.tx; p.ty = -p.ty; }
    }
    // one stack per direction faced: the sign above, its plates under it
    const stacks = new Map();
    for (const p of group) {
      const k = `${Math.round(Math.atan2(p.ty, p.tx) / (Math.PI / 4))}`;
      if (!stacks.has(k)) stacks.set(k, []);
      stacks.get(k).push(p);
    }
    let postTop = 0;
    for (const stack of stacks.values()) {
      stack.sort((a, b) => (isTextPlate(a.code) - isTextPlate(b.code)) || (Number.parseFloat(a.code) - Number.parseFloat(b.code)));
      const sized = stack.map((p) => { const width = signWidthMetres(p.code, p.face.aspect); return { ...p, width, height: width * p.face.aspect }; });
      const tall = sized.reduce((s, p) => s + p.height + STACK_GAP_M, 0);
      let top = Math.max(STACK_TOP_M, tall + MIN_CLEAR_M);
      postTop = Math.max(postTop, top);
      for (const p of sized) {
        plates.push({
          code: p.code, face: p.face, x: p.x, y: p.y, z: z + top - p.height / 2,
          yaw: Math.atan2(-p.tx, p.ty), width: p.width, height: p.height,
          // (the plate stands just in front of its post)
          dx: -p.tx * 0.04, dy: -p.ty * 0.04,
        });
        top -= p.height + STACK_GAP_M;
      }
    }
    posts.push({ x, y, z, height: postTop });
  }
  return { plates, posts, faces, missing, total };
}

// ---- shapes -----------------------------------------------------------------

const toDae = (root) => {
  root.updateMatrixWorld(true);
  return new ColladaExporter().parse(root, undefined, { version: '1.4.1', upAxis: 'Z_UP' })?.data ?? null;
};
const shell = () => {
  const base00 = new THREE.Group(); base00.name = 'base00';
  const start01 = new THREE.Group(); start01.name = 'start01';
  base00.add(start01);
  return { base00, start01 };
};

/** A plate one metre wide and high, standing in the XZ plane, its face toward -Y (scaled per sign), with a plain back. */
export function buildSignPlateDAE(materialName) {
  const { base00, start01 } = shell();
  const front = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(Math.PI / 2).toNonIndexed(), new THREE.MeshStandardMaterial({ name: materialName }));
  front.name = 'platea2';
  const back = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0.004, 0).toNonIndexed(), new THREE.MeshStandardMaterial({ name: SIGN_BACK_MATERIAL }));
  back.name = 'plateb2';
  start01.add(front, back);
  return toDae(base00);
}

/** A post one metre tall from the ground up (scaled in height per sign), 6 cm across. */
export function buildSignPostDAE() {
  const { base00, start01 } = shell();
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1, 8).rotateX(Math.PI / 2).translate(0, 0, 0.5).toNonIndexed(), new THREE.MeshStandardMaterial({ name: SIGN_BACK_MATERIAL }));
  post.name = 'posta2';
  start01.add(post);
  return toDae(base00);
}

export const faceMaterialName = (face) => `mapng_nosign_${face.key}`;
export const faceShapeName = (face) => `mapng_nosign_${face.key}.dae`;
export const faceTextureName = (face) => `${face.key}.png`;

/** The materials of the plates used, the back and the post (main.materials.json contents). */
export function signMaterialDefs(levelName, faces) {
  const defs = {
    [SIGN_BACK_MATERIAL]: {
      class: 'Material', name: SIGN_BACK_MATERIAL, mapTo: SIGN_BACK_MATERIAL,
      Stages: [{ diffuseColor: [0.55, 0.57, 0.6, 1] }], translucentBlendOp: 'None',
    },
  };
  for (const face of faces) {
    const name = faceMaterialName(face);
    defs[name] = {
      class: 'Material', name, mapTo: name,
      Stages: [{ diffuseMap: `levels/${levelName}/${SIGN_ASSET_DIR}/textures/${faceTextureName(face)}`, diffuseColor: [1, 1, 1, 1] }],
      // (the picture's clear corners are cut away: a triangle, a disc, an octagon)
      alphaTest: true, alphaRef: 127, translucentBlendOp: 'None',
    };
  }
  return defs;
}

// ---- drawn faces --------------------------------------------------------------

const newCanvas = (w, h) => {
  if (typeof document === 'undefined' || !document.createElement) return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c.getContext?.('2d') ? c : null;
};

/** A speed-limit disc: white, red ring, the number. Null where there is nothing to draw on. */
export function drawSpeedFace(value) {
  const S = 256;
  const c = newCanvas(S, S);
  if (!c) return null;
  const g = c.getContext('2d');
  g.clearRect(0, 0, S, S);
  g.fillStyle = '#c8102e'; g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#ffffff'; g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 30, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#111111'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `bold ${String(value).length > 2 ? 96 : 124}px Arial, Helvetica, sans-serif`;
  g.fillText(String(value), S / 2, S / 2 + 6);
  return c;
}

/** A plate with wording: white, black edge, the text on up to three lines. Null where there is nothing to draw on. */
export function drawTextFace(text, aspect) {
  const W = 256, H = Math.max(48, Math.round(W * aspect));
  const c = newCanvas(W, H);
  if (!c) return null;
  const g = c.getContext('2d');
  g.fillStyle = '#111111'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#ffffff'; g.fillRect(6, 6, W - 12, H - 12);
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  for (const word of words) {
    const last = lines[lines.length - 1];
    if (last != null && (last + ' ' + word).length <= 14) lines[lines.length - 1] = `${last} ${word}`; else lines.push(word);
  }
  const shown = lines.slice(0, 3);
  const longest = Math.max(1, ...shown.map((l) => l.length));
  const size = Math.max(16, Math.min(Math.floor((H - 20) / shown.length) - 4, Math.floor(((W - 28) / longest) * 1.75)));
  g.fillStyle = '#111111'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `bold ${size}px Arial, Helvetica, sans-serif`;
  shown.forEach((line, i) => g.fillText(line, W / 2, H / 2 + (i - (shown.length - 1) / 2) * (size + 4), W - 24));
  return c;
}

const canvasPng = (canvas) => new Promise((resolve) => canvas.toBlob((b) => resolve(b || null), 'image/png'));

const MIME = { png: 'image/png', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml', webp: 'image/webp' };
const TEXTURE_PX = 256;

/** A white surround, reached from the picture's edge, made clear (the sign's own white field is fenced in by its rim). */
export function clearSurround(pixels, w, h) {
  const white = (i) => pixels[i * 4 + 3] > 200 && pixels[i * 4] > 236 && pixels[i * 4 + 1] > 236 && pixels[i * 4 + 2] > 236;
  if (![0, w - 1, (h - 1) * w, h * w - 1].some(white)) return false;
  const seen = new Uint8Array(w * h);
  const stack = [];
  const visit = (i) => { if (!seen[i] && white(i)) { seen[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) { visit(x); visit((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { visit(y * w); visit(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop();
    pixels[i * 4 + 3] = 0;
    const x = i % w;
    if (x > 0) visit(i - 1);
    if (x < w - 1) visit(i + 1);
    if (i >= w) visit(i - w);
    if (i < (h - 1) * w) visit(i + w);
  }
  return true;
}

/** A sign picture as the plate's PNG: redrawn 256 px wide with its white surround cleared; as it is when it can't be redrawn and is a PNG. */
async function plateTexture(bytes, file) {
  const ext = String(file).split('.').pop().toLowerCase();
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(new Blob([bytes], { type: MIME[ext] || 'application/octet-stream' }));
      const w = TEXTURE_PX, h = Math.max(8, Math.round((TEXTURE_PX * bitmap.height) / Math.max(1, bitmap.width)));
      const canvas = newCanvas(w, h);
      if (canvas) {
        const g = canvas.getContext('2d');
        g.clearRect?.(0, 0, w, h);
        g.drawImage(bitmap, 0, 0, w, h);
        bitmap.close?.();
        if (g.getImageData && g.putImageData) {
          const image = g.getImageData(0, 0, w, h);
          if (image?.data && clearSurround(image.data, w, h)) g.putImageData(image, 0, 0);
        }
        const blob = await canvasPng(canvas);
        if (blob) return new Uint8Array(await blob.arrayBuffer());
      }
    } catch { /* not a picture this can read: below */ }
  }
  return ext === 'png' ? bytes : null;
}

/**
 * The files of the signs planned: { files: [{ path, data }], objects: [TSStatic ...], left: [face keys with no picture] }.
 * Paths are relative to the level's folder. opts: { levelName, fetchImpl, persistentId(), rotationMatrixFromYaw(yaw) }
 */
export async function buildNorwaySignAssets(plan, { levelName, fetchImpl = globalThis.fetch, persistentId, rotationMatrixFromYaw }) {
  const files = [];
  const ready = new Set();
  const left = [];
  for (const face of plan.faces.values()) {
    let data = null;
    try {
      if (face.kind === 'art') {
        const res = await fetchImpl(`/norway_signs/${face.file}`);
        if (res.ok) data = await plateTexture(new Uint8Array(await res.arrayBuffer()), face.file);
      } else {
        const canvas = face.kind === 'speed' ? drawSpeedFace(face.value) : drawTextFace(face.text, face.aspect);
        const blob = canvas ? await canvasPng(canvas) : null;
        if (blob) data = new Uint8Array(await blob.arrayBuffer());
      }
    } catch { data = null; }
    const dae = data ? buildSignPlateDAE(faceMaterialName(face)) : null;
    if (!data || !dae) { left.push(face.key); continue; }
    files.push({ path: `${SIGN_ASSET_DIR}/textures/${faceTextureName(face)}`, data });
    files.push({ path: `${SIGN_ASSET_DIR}/${faceShapeName(face)}`, data: dae });
    ready.add(face.key);
  }
  if (!ready.size) return { files: [], objects: [], left };
  const round = (v) => Math.round(v * 1000) / 1000;
  const objects = [];
  const postDae = buildSignPostDAE();
  if (postDae) {
    files.push({ path: `${SIGN_ASSET_DIR}/${SIGN_POST_SHAPE}`, data: postDae });
    plan.posts.forEach((p, i) => objects.push({
      __parent: 'signs', class: 'TSStatic', name: `nosign_post_${i}`, persistentId: persistentId(),
      position: [round(p.x), round(p.y), round(p.z)], scale: [1, 1, round(p.height)],
      shapeName: `/levels/${levelName}/${SIGN_ASSET_DIR}/${SIGN_POST_SHAPE}`, collisionType: 'None', decalType: 'None', useInstanceRenderData: true,
    }));
  }
  plan.plates.forEach((p, i) => {
    if (!ready.has(p.face.key)) return;
    objects.push({
      __parent: 'signs', class: 'TSStatic', name: `nosign_${safe(p.code)}_${i}`, persistentId: persistentId(),
      position: [round(p.x + p.dx), round(p.y + p.dy), round(p.z)], rotationMatrix: rotationMatrixFromYaw(p.yaw), scale: [round(p.width), 1, round(p.height)],
      shapeName: `/levels/${levelName}/${SIGN_ASSET_DIR}/${faceShapeName(p.face)}`, collisionType: 'None', decalType: 'None', useInstanceRenderData: true,
    });
  });
  files.push({ path: `${SIGN_ASSET_DIR}/main.materials.json`, data: JSON.stringify(signMaterialDefs(levelName, [...plan.faces.values()].filter((f) => ready.has(f.key))), null, 2) });
  return { files, objects, left };
}
