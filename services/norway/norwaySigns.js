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

// ---- what a plate says ------------------------------------------------------------
//
// NVDB writes a plate's wording (Tekst) in a fixed system, as seen in real data:
//   "@@"            a new line                         "08-20@@(08-20)"
//   "@32@", "@H90@" an arrow (30..37; H, V, R + degrees)   "@32@Sentrum", "Lade@33@", "Krabberødstrand@H90@"
//   "@807.6@"       a small sign or symbol             "@807.6@ unntatt"
//   "@723.12 E18@"  a road number in its shield; also "@723.12@E6" and "$E6$"
// ("$...$" is also written for "@...@", and "807,6" for "807.6".)

// Arrow numbers -> the way they point, in degrees anticlockwise from "to the right".
const ARROWS = { 30: 180, 31: 0, 32: 180, 33: 0, 34: 90, 35: 45, 36: 135, 37: 270 };
const NO_WORDING = /^(ingen|symbol|-+)$/i;
// "H90", "V45", "R": to the right, to the left, straight on, by so many degrees off straight on.
const turnDegrees = (side, angle) => (side === 'R' ? 90 : side === 'H' ? 90 - angle : 90 + angle);
// A road number is on green when it is a European road's, or the shield is a national road's (723.12).
const routeToken = (shield, number) => {
  const v = String(number).replace(/\s+/g, '').toUpperCase();
  return { t: 'route', v: /^E\d/.test(v) ? `E ${v.slice(1)}` : v, green: /^E\d/.test(v) || shield === '723.12' };
};
const ROUTE_NUMBER = /^([A-Za-z]{1,2}\s?)?\d{1,4}$/;
// A bare three-digit number between "$" that is a sign's number rather than a road's: the classes signs come in.
const SIGN_NUMBER = /^(1[0-5]\d|2[01]\d|3[0-9]\d|4[01]\d|5[0-9]\d|6[0-5]\d|80\d|82\d|9[0-4]\d)$/;

/**
 * A plate's wording as lines of tokens: [[{ t: 'text', v } | { t: 'arrow', deg } | { t: 'sign', code } |
 * { t: 'route', v, green }]]. An empty list when it says nothing ("Ingen").
 *
 * "@" parts the text into fields; an empty field (two "@" in a row) starts a new line. A field is an arrow
 * ("32", "H90"), a road-number shield with its number ("723.12 E18", "723.11¤E18") or waiting for it ("723.12"
 * then "E6"), a small sign ("807.6"), or words. numbersAreWords: a bare number is words, never a small sign. "$...$" inside words marks a road number or a small sign.
 */
export function parseSignText(text, { numbersAreWords = false } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw || NO_WORDING.test(raw)) return [];
  const lines = [[]];
  const line = () => lines[lines.length - 1];
  let shield = null;                       // a road-number shield waiting for its number
  const words = (v) => {
    const s = v.replace(/\s+/g, ' ').trim();
    if (!s) return;
    if (shield && ROUTE_NUMBER.test(s.split(' ')[0])) {
      line().push(routeToken(shield, s.split(' ')[0]));
      shield = null;
      words(s.split(' ').slice(1).join(' '));
      return;
    }
    shield = null;
    const last = line()[line().length - 1];
    if (last?.t === 'text') last.v += ` ${s}`; else line().push({ t: 'text', v: s });
  };
  const field = (f) => {
    const inner = f.trim().replace(/(\d),(\d)/g, '$1.$2');
    if (!inner) return;
    if (ARROWS[inner] != null) { line().push({ t: 'arrow', deg: ARROWS[inner] }); return; }
    const turn = /^([HVR])(\d{0,3})$/.exec(inner);
    if (turn) { line().push({ t: 'arrow', deg: turnDegrees(turn[1], Number(turn[2] || (turn[1] === 'R' ? 0 : 90))) }); return; }
    const route = /^(723(?:\.\d+)?)(?:[\s¤]+(.+))?$/.exec(inner);
    if (route) {
      if (!route[2]) { shield = route[1]; return; }
      const [number, ...rest] = route[2].trim().split(/\s+/);
      line().push(routeToken(route[1], number));
      words(rest.join(' '));
      return;
    }
    const sign = /^(\d{3}(?:\.\d+)*[A-Za-z]?)(?:\s+(.+))?$/.exec(inner);
    // ("807.6", "765 Kristiansand": a small sign, and words after it; a bare number after a shield is its road number)
    // (on a distance sign, 725, a bare number is the kilometres to the place)
    if (sign && !(numbersAreWords && /^\d+$/.test(inner)) && !(shield && ROUTE_NUMBER.test(inner)) && SIGN_NUMBER.test(sign[1].split('.')[0]) && (sign[1].includes('.') || !sign[2] || /^[A-Za-zÆØÅæøå]/.test(sign[2]))) {
      shield = null;
      line().push({ t: 'sign', code: sign[1] });
      if (sign[2]) words(sign[2]);
      return;
    }
    // words, with "$...$" marking a road number or a small sign inside them
    let at = 0;
    for (const m of inner.matchAll(/\$([^$]+)\$/g)) {
      words(inner.slice(at, m.index));
      at = m.index + m[0].length;
      const v = m[1].trim().replace(',', '.');
      if (ARROWS[v] != null) line().push({ t: 'arrow', deg: ARROWS[v] });
      else if (ROUTE_NUMBER.test(v) && (shield || /[A-Za-z]/.test(v) || !SIGN_NUMBER.test(v))) { line().push(routeToken(shield, v)); shield = null; }
      else if (/^\d{3}(\.\d+)*[A-Za-z]?$/.test(v)) line().push({ t: 'sign', code: v });
      else words(v);
    }
    words(inner.slice(at));
  };
  raw.split('@').forEach((f, i) => {
    if (i > 0 && f === '' ) {
      // (an arrow alone on a line belongs to the line after it)
      if (line().length && !line().every((k) => k.t === 'arrow')) { lines.push([]); shield = null; }
      return;
    }
    field(f);
  });
  return lines.filter((l) => l.length);
}

// A token's width in letter heights ("em"), near enough to size the plate before anything is drawn.
const tokenEm = (k) => (k.t === 'text' ? k.v.length * 0.56 : k.t === 'arrow' ? 1.0 : k.t === 'sign' ? 1.2 : k.v.length * 0.6 + 0.6);
const lineEm = (l) => l.reduce((s, k) => s + tokenEm(k), 0) + Math.max(0, l.length - 1) * 0.3;

const MAX_BOARD_LINES = 8;
/** Lines no wider than maxEm: a long run of words is broken between words. At most MAX_BOARD_LINES lines. */
export function wrapSignLines(lines, maxEm) {
  const out = [];
  for (const l of lines) {
    let cur = [];
    const push = (k) => {
      if (cur.length && lineEm([...cur, k]) > maxEm) { out.push(cur); cur = []; }
      cur.push(k);
    };
    for (const k of l) {
      if (k.t !== 'text' || tokenEm(k) <= maxEm) { push(k); continue; }
      for (const w of k.v.split(' ')) {
        const last = cur[cur.length - 1];
        if (last?.t === 'text' && last.joined && lineEm([...cur.slice(0, -1), { t: 'text', v: `${last.v} ${w}` }]) <= maxEm) last.v += ` ${w}`;
        else {
          // (the next word of the same run never shares a line as a piece of its own: it starts the next line)
          if (last?.t === 'text' && last.joined) { out.push(cur); cur = []; }
          push({ t: 'text', v: w, joined: true });
        }
      }
    }
    if (cur.length) out.push(cur);
  }
  return out.slice(0, MAX_BOARD_LINES).map((l) => l.map(({ joined, ...k }) => k));
}

// Plate colours (NVDB's Farge, the plate's ground colour) -> [ground, wording].
const BOARD_COLOURS = {
  gul: ['#f8a800', '#111111'], hvit: ['#ffffff', '#111111'], 'blå': ['#00539f', '#ffffff'], 'grønn': ['#00704a', '#ffffff'],
  brun: ['#6b3f1d', '#ffffff'], burgunder: ['#7b1e2b', '#ffffff'], oransje: ['#f28c00', '#111111'], svart: ['#111111', '#ffffff'],
  'rød': ['#c8102e', '#ffffff'], 'gulgrønn fluorescerende': ['#d7e600', '#111111'],
};
/** The ground colour a plate has when NVDB does not say: plates under a sign white, cycle route signs burgundy, direction signs yellow. */
const defaultColour = (code) => {
  const n = Number.parseFloat(code) || 0;
  if (n >= 751 && n < 760) return 'burgunder';
  if (n >= 700 && n < 800) return Math.floor(n) === 729 ? 'hvit' : 'gul';
  return 'hvit';
};

/**
 * What a direction sign's own number says about its arrow ("711.R" straight on, "711.H90" to the right,
 * "713.V" to the left): { deg, side: 'left' | 'right', pointed } or null. `pointed`: the plate itself is the
 * arrow (713, an ordinary direction sign), with no arrow drawn on it.
 */
export function arrowOfSign(code) {
  const m = /^(7\d\d)(?:\.\d+)*\.?(R|[VH])(\d{0,3})$/.exec(String(code));
  if (!m) return null;
  const deg = turnDegrees(m[2], Number(m[3] || (m[2] === 'R' ? 0 : 90)));
  return { deg, side: m[2] === 'H' ? 'right' : 'left', pointed: m[1] === '713' || m[1] === '715' };
}

/** A worded plate's face: its lines, colours and size. Null when the wording says nothing. */
function boardFace(code, text, colour) {
  const n = Number.parseFloat(code) || 0;
  const direction = n >= 700 && n < 800;
  let lines = parseSignText(text, { numbersAreWords: Math.floor(n) === 725 });
  if (!lines.length) return null;
  // (a symbol plate under a sign, 807.x, with words: its own symbol first)
  if (n >= 807 && n < 808 && !lines.some((l) => l.some((k) => k.t === 'sign'))) lines = [[{ t: 'sign', code: String(code) }], ...lines];
  lines = wrapSignLines(lines, direction ? 18 : 11);
  // the arrow the sign's number gives it, where its wording has none
  const own = direction && !lines.some((l) => l.some((k) => k.t === 'arrow')) ? arrowOfSign(code) : null;
  const sideEm = own ? (own.pointed ? 1.0 : 1.5) : 0;
  const cols = Math.max(direction ? 6 : 5, ...lines.map(lineEm)) + 1.2 + sideEm;
  const rows = lines.length * 1.3 + 0.9;
  const name = BOARD_COLOURS[String(colour || '').toLowerCase()] ? String(colour).toLowerCase() : defaultColour(code);
  const [ground, ink] = BOARD_COLOURS[name];
  // (orientation boards before a junction, 701 to 709, are the big ones)
  const widthM = direction && n < 710 ? Math.min(3.6, Math.max(1.8, cols * 0.26))
    : direction ? Math.min(3.2, Math.max(0.8, cols * 0.16)) : Math.min(0.9, Math.max(0.5, cols * 0.085));
  return {
    key: `text_${hash(`${name}|${own ? `${own.deg}${own.side}${own.pointed}` : ''}|${JSON.stringify(lines)}`)}`, kind: 'text', text: String(text), lines, ground, ink,
    cols, aspect: rows / cols, widthM, ...(own ? { arrow: own } : {}),
  };
}

const isWorded = (code) => { const c = Math.floor((Number.parseFloat(code) || 0) / 100); return c === 7 || c === 8; };

/**
 * The face a plate shows: { key, kind: 'art' | 'text' | 'speed' | 'zone', file?, lines?, value?, aspect }, or null
 * when there is nothing to show for it. `aspect` is height / width. A direction sign or a plate under a sign with
 * wording in NVDB is drawn with that wording (the regulation's picture of it only shows an example); a speed
 * limit shows its own number.
 */
export function faceFor(code, text, signs, colour) {
  const base = code.split('.')[0];
  const number = Number.parseInt(String(code.split('.')[1] || (String(text ?? '').match(/\b(\d{2,3})\b/) || [])[1] || ''), 10);
  if (/^(362|364|366|368)$/.test(base) && Number.isFinite(number) && number >= 5 && number <= 130) {
    const own = signs?.[`${base}.${number}`];
    if (own) return { key: `art_${safe(`${base}.${number}`)}`, kind: 'art', file: own.file, aspect: aspectOf(own) };
    if (base === '362') return { key: `speed_${number}`, kind: 'speed', value: number, aspect: 1 };
    if (base === '364') return { key: `speedend_${number}`, kind: 'speed', value: number, end: true, aspect: 1 };
    return { key: `zone${base === '368' ? 'end' : ''}_${number}`, kind: 'zone', value: number, end: base === '368', aspect: 1.3 };
  }
  if (isWorded(code)) {
    const board = boardFace(code, text, colour);
    if (board) return board;
  }
  const art = resolveArt(code, signs);
  if (art) return { key: `art_${safe(art)}`, kind: 'art', file: signs[art].file, aspect: aspectOf(signs[art]) };
  return boardFace(code, text, colour);
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
    const face = faceFor(code, f.tags['mapng:sign_text'], signs, f.tags['mapng:sign_colour']);
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
      const sized = stack.map((p) => { const width = p.face.widthM ?? signWidthMetres(p.code, p.face.aspect); return { ...p, width, height: width * p.face.aspect }; });
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
  return { plates, posts, faces, missing, total, signs };
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

/** A speed-limit disc: white, red ring, the number; `end`: the limit ends (grey number, struck through). Null where there is nothing to draw on. */
export function drawSpeedFace(value, { end = false } = {}) {
  const S = 256;
  const c = newCanvas(S, S);
  if (!c) return null;
  const g = c.getContext('2d');
  g.clearRect(0, 0, S, S);
  discAt(g, S / 2, S / 2, S / 2 - 2, value, end);
  return c;
}

function discAt(g, cx, cy, r, value, end) {
  g.fillStyle = end ? '#111111' : '#c8102e'; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#ffffff'; g.beginPath(); g.arc(cx, cy, end ? r * 0.95 : r * 0.78, 0, Math.PI * 2); g.fill();
  g.fillStyle = end ? '#8a8a8a' : '#111111'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `bold ${Math.round(r * (String(value).length > 2 ? 0.76 : 0.98))}px Arial, Helvetica, sans-serif`;
  g.fillText(String(value), cx, cy + r * 0.05);
  if (end) {
    g.strokeStyle = '#111111'; g.lineWidth = r * 0.045;
    for (const off of [-0.16, -0.08, 0, 0.08, 0.16]) {
      g.beginPath(); g.moveTo(cx - r * 0.62 + off * r, cy + r * 0.62 + off * r); g.lineTo(cx + r * 0.62 + off * r, cy - r * 0.62 + off * r); g.stroke();
    }
  }
}

/** A speed-limit zone plate (366), or the end of one (368): the disc on a white plate with "Sone" under it. */
export function drawZoneFace(value, end) {
  const W = 256, H = Math.round(W * 1.3);
  const c = newCanvas(W, H);
  if (!c) return null;
  const g = c.getContext('2d');
  g.fillStyle = '#111111'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#ffffff'; g.fillRect(5, 5, W - 10, H - 10);
  discAt(g, W / 2, 122, 104, value, end);
  g.fillStyle = end ? '#8a8a8a' : '#111111'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = 'bold 60px Arial, Helvetica, sans-serif';
  g.fillText('Sone', W / 2, H - 50);
  return c;
}

// An arrow in a box of half-size r round (cx, cy): drawn pointing right, then turned (the picture's y runs down).
function drawArrow(g, cx, cy, r, deg, colour) {
  g.save(); g.translate(cx, cy); g.rotate((-deg * Math.PI) / 180);
  g.fillStyle = colour;
  g.beginPath();
  g.moveTo(-r * 0.9, -r * 0.15); g.lineTo(r * 0.2, -r * 0.15); g.lineTo(r * 0.2, -r * 0.48); g.lineTo(r * 0.9, 0);
  g.lineTo(r * 0.2, r * 0.48); g.lineTo(r * 0.2, r * 0.15); g.lineTo(-r * 0.9, r * 0.15);
  g.closePath(); g.fill();
  g.restore();
}

/**
 * A worded plate: its ground colour with an edge, and its lines of words, arrows, small signs and road numbers.
 * face: faceFor's (kind 'text'); symbols: Map(sign code -> picture to draw, anything drawImage takes that has a
 * width and a height). face.arrow (from the sign's own number): an arrow at that side of the wording, or, for a
 * pointed plate, the plate cut to a point at that side. Null where there is nothing to draw on.
 */
export function drawTextFace(face, symbols = new Map()) {
  const lines = face.lines || [];
  const cols = face.cols || Math.max(5, ...lines.map(lineEm)) + 1.2;
  const W = 512, H = Math.max(64, Math.round(W * face.aspect));
  const c = newCanvas(W, H);
  if (!c) return null;
  const g = c.getContext('2d');
  const em = W / cols;
  const edge = Math.max(3, em * 0.08);
  const side = face.arrow?.side;
  const tip = face.arrow?.pointed ? Math.min(H * 0.5, em * 1.6) : 0;
  // the plate: a rectangle, or one drawn to a point at one end (the rest of the picture stays clear)
  const outline = (inset) => {
    const l = inset, r = W - inset, t = inset, b = H - inset;
    const reach = Math.max(0, tip - inset * 0.6);
    g.beginPath();
    if (tip && side === 'left') { g.moveTo(l + reach, t); g.lineTo(r, t); g.lineTo(r, b); g.lineTo(l + reach, b); g.lineTo(l + inset * 0.4, H / 2); }
    else if (tip) { g.moveTo(l, t); g.lineTo(r - reach, t); g.lineTo(r - inset * 0.4, H / 2); g.lineTo(r - reach, b); g.lineTo(l, b); }
    else { g.moveTo(l, t); g.lineTo(r, t); g.lineTo(r, b); g.lineTo(l, b); }
    g.closePath(); g.fill();
  };
  g.clearRect?.(0, 0, W, H);
  g.fillStyle = face.ink; outline(0);
  g.fillStyle = face.ground; outline(edge);
  // the room the wording has: beside the arrow or the point
  const sideW = face.arrow ? (tip ? tip * 0.75 : em * 1.5) : 0;
  const x0 = em * 0.45 + (side === 'left' ? sideW : 0), x1 = W - em * 0.45 - (side === 'right' ? sideW : 0);
  if (face.arrow && !tip) {
    const r = Math.min(em * 0.85, H * 0.36);
    drawArrow(g, side === 'left' ? em * 0.5 + sideW / 2 : W - em * 0.5 - sideW / 2, H / 2, r, face.arrow.deg, face.ink);
  }
  const font = (px) => `bold ${Math.round(px)}px Arial, Helvetica, sans-serif`;
  const rowH = (H - em * 0.9) / Math.max(1, lines.length);
  lines.forEach((line, row) => {
    const cy = em * 0.45 + rowH * (row + 0.5);
    // each token's width as drawn; the line is narrowed to its room if it comes out wider
    const measure = (scale) => line.map((k) => {
      if (k.t === 'text') { g.font = font(em * 0.92 * scale); return g.measureText(k.v).width; }
      if (k.t === 'route') { g.font = font(em * 0.78 * scale); return g.measureText(k.v).width + em * 0.55 * scale; }
      if (k.t === 'sign') { const img = symbols.get(k.code); return img ? (em * 1.15 * scale * img.width) / Math.max(1, img.height) : 0; }
      return em * scale;
    });
    let scale = 1;
    let widths = measure(scale);
    const total = () => widths.reduce((s, w) => s + w, 0) + em * 0.3 * scale * Math.max(0, widths.filter((w) => w > 0).length - 1);
    if (total() > x1 - x0) { scale = (x1 - x0) / total(); widths = measure(scale); }
    let x = x0 + (x1 - x0 - total()) / 2;
    line.forEach((k, i) => {
      const w = widths[i];
      if (!(w > 0)) return;
      if (k.t === 'text') {
        g.font = font(em * 0.92 * scale); g.fillStyle = face.ink; g.textAlign = 'left'; g.textBaseline = 'middle';
        g.fillText(k.v, x, cy + em * 0.04);
      } else if (k.t === 'route') {
        // a road number: white on green with a white edge (European and national roads), or black on white
        const h = em * 1.0 * scale, rim = Math.max(2, em * 0.06 * scale);
        g.fillStyle = k.green ? '#ffffff' : '#111111'; g.fillRect(x, cy - h / 2, w, h);
        g.fillStyle = k.green ? '#00704a' : '#ffffff'; g.fillRect(x + rim, cy - h / 2 + rim, w - 2 * rim, h - 2 * rim);
        g.font = font(em * 0.78 * scale); g.fillStyle = k.green ? '#ffffff' : '#111111'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(k.v, x + w / 2, cy + em * 0.04);
      } else if (k.t === 'sign') {
        const h = em * 1.15 * scale;
        g.drawImage(symbols.get(k.code), x, cy - h / 2, w, h);
      } else drawArrow(g, x + w / 2, cy, w / 2, k.deg, face.ink);
      x += w + em * 0.3 * scale;
    });
  });
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
  const symbols = new Map();
  for (const face of plan.faces.values()) {
    let data = null;
    try {
      if (face.kind === 'art') {
        const res = await fetchImpl(`/norway_signs/${face.file}`);
        if (res.ok) data = await plateTexture(new Uint8Array(await res.arrayBuffer()), face.file);
      } else {
        let canvas;
        if (face.kind === 'speed') canvas = drawSpeedFace(face.value, { end: face.end });
        else if (face.kind === 'zone') canvas = drawZoneFace(face.value, face.end);
        else {
          // the small signs in the wording, as pictures (one that can't be had is left out of its line)
          for (const line of face.lines || []) for (const k of line) {
            if (k.t !== 'sign' || symbols.has(k.code)) continue;
            symbols.set(k.code, null);
            const art = resolveArt(k.code, plan.signs);
            if (!art || typeof createImageBitmap !== 'function') continue;
            try {
              const file = plan.signs[art].file;
              const res = await fetchImpl(`/norway_signs/${file}`);
              if (res.ok) symbols.set(k.code, await createImageBitmap(new Blob([await res.arrayBuffer()], { type: MIME[String(file).split('.').pop().toLowerCase()] || 'image/png' })));
            } catch { /* left out */ }
          }
          canvas = drawTextFace(face, new Map([...symbols].filter(([, v]) => v)));
        }
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
