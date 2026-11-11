// The wording on Norwegian sign plates: NVDB's text system read into lines, and the face a plate gets.
// The texts are ones seen on real plates in Trondheim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSignText, wrapSignLines, faceFor, planNorwaySigns, arrowOfSign } from '../services/norway/norwaySigns.js';

const signs = {
  202: { file: '202.png', w: 256, h: 224 }, 302: { file: '302.png', w: 256, h: 256 }, 366: { file: '366.png', w: 256, h: 256 },
  753: { file: '753.png', w: 256, h: 80 }, '807.6': { file: '807.6.png', w: 256, h: 128 }, 808: { file: '808.png', w: 256, h: 128 },
  '570.2': { file: '570.2.png', w: 256, h: 128 }, '362.50': { file: '362.50.png', w: 256, h: 256 },
};
const kinds = (lines) => lines.map((l) => l.map((k) => (k.t === 'text' ? k.v : k.t === 'arrow' ? `>${k.deg}` : k.t === 'sign' ? `#${k.code}` : `[${k.v}]`)));

test('new lines, arrows, small signs and road numbers are read out of the text', () => {
  assert.deepEqual(kinds(parseSignText('08-20@@(08-20)@@13-20')), [['08-20'], ['(08-20)'], ['13-20']]);
  assert.deepEqual(kinds(parseSignText('@32@Lade@807.6@@32@Strindheim@807.6@')), [['>180', 'Lade', '#807.6'], ['>180', 'Strindheim', '#807.6']]);
  assert.deepEqual(kinds(parseSignText('$807.6$@@$32$Sentrum@@Rosenborg$33$')), [['#807.6'], ['>180', 'Sentrum'], ['Rosenborg', '>0']]);
  assert.deepEqual(kinds(parseSignText('@34@ @723.12@$706$ @723.12@$E6$ @@ Strindheim')), [['>90', '[706]', '[E 6]'], ['Strindheim']]);
  assert.deepEqual(kinds(parseSignText('@34@@723.12@E6')), [['>90', '[E 6]']]);
  assert.deepEqual(kinds(parseSignText('@807,6@ unntatt')), [['#807.6', 'unntatt']]);
  assert.deepEqual(kinds(parseSignText('07 - 17 @372@ over 15 min')), [['07 - 17', '#372', 'over 15 min']]);
  assert.deepEqual(kinds(parseSignText('Kong Øysteins veg')), [['Kong Øysteins veg']]);
  assert.equal(parseSignText('@723.13@ 6690')[0][0].green, false, 'a county road number: not on green');
});

test('the road number inside the shield field, turns by letter, and a lone arrow line (Bamble, E18)', () => {
  assert.deepEqual(kinds(parseSignText('@723.12 E18@Osl@@Kristiansand')), [['[E 18]', 'Osl'], ['Kristiansand']]);
  assert.deepEqual(kinds(parseSignText('@Porsgrunn@@723.12 E18@723.13 354@@Krabberød-@@strand')), [['Porsgrunn'], ['[E 18]', '[354]'], ['Krabberød-'], ['strand']]);
  const shields = parseSignText('@723.12 E18@723.13 354@')[0];
  assert.deepEqual(shields.map((k) => k.green), [true, false], 'the European road on green, the county road on white');
  assert.deepEqual(kinds(parseSignText('@H90@@723.13 354@723.12 E18@ Porsgrunn')), [['>0', '[354]', '[E 18]', 'Porsgrunn']]);
  assert.deepEqual(kinds(parseSignText('Krabberødstrand@H90@')), [['Krabberødstrand', '>0']]);
  assert.deepEqual(kinds(parseSignText('@ 723.11¤E18@@Kristiansand@162@@Arendal@100', { numbersAreWords: true })), [['[E 18]'], ['Kristiansand 162'], ['Arendal 100']]);
  assert.deepEqual(kinds(faceFor('725.1', 'Arendal@100', signs).lines), [['Arendal 100']], 'on a distance sign a number is the distance');
  assert.deepEqual(kinds(parseSignText('@R45@Brevik@@723.11 354@Heistad')), [['>90', 'Brevik'], ['[354]', 'Heistad']]);
  assert.deepEqual(kinds(parseSignText('Oslo@723.12 E18@@Kristiansand')), [['Oslo', '[E 18]'], ['Kristiansand']]);
  assert.deepEqual(kinds(parseSignText('@V135@Skien')), [['>225', 'Skien']]);
});

test('a direction sign takes its arrow from its own number where its wording has none', () => {
  assert.deepEqual(arrowOfSign('711.R'), { deg: 90, side: 'left', pointed: false });
  assert.deepEqual(arrowOfSign('711.H90'), { deg: 0, side: 'right', pointed: false });
  assert.deepEqual(arrowOfSign('711.V135'), { deg: 225, side: 'left', pointed: false });
  assert.deepEqual(arrowOfSign('713.V'), { deg: 180, side: 'left', pointed: true });
  assert.equal(arrowOfSign('729'), null);
  assert.equal(arrowOfSign('570.2V'), null);
  const ahead = faceFor('711.R', '@723.12 E18@Oslo@@Kristiansand', signs);
  assert.deepEqual(ahead.arrow, { deg: 90, side: 'left', pointed: false });
  assert.equal(faceFor('711.R', '@34@ Sentrum', signs).arrow, undefined, 'the wording has its own arrow');
  assert.ok(ahead.cols > faceFor('709.1', '@723.12 E18@Oslo@@Kristiansand', signs).cols, 'room for the arrow');
  assert.notEqual(ahead.key, faceFor('711.H90', '@723.12 E18@Oslo@@Kristiansand', signs).key);
});

test('a plate that says nothing has no wording', () => {
  for (const text of ['Ingen', 'ingen', 'Symbol', '', undefined, null, '  ']) assert.deepEqual(parseSignText(text), []);
});

test('long wording is broken between words', () => {
  const lines = wrapSignLines(parseSignText('Gjelder ikke moped, MC, taxi og buss med løyve.'), 11);
  assert.ok(lines.length >= 3);
  assert.equal(lines.map((l) => l[0].v).join(' '), 'Gjelder ikke moped, MC, taxi og buss med løyve.');
  assert.ok(lines.every((l) => l[0].v.length <= 20));
  assert.equal(wrapSignLines(parseSignText('a@@b@@c@@d@@e@@f@@g@@h@@i@@j'), 11).length, 8);
});

test('direction signs and plates under a sign are drawn with NVDB\'s wording, not the regulation\'s example', () => {
  const route = faceFor('753', '@32@Lade@807.6@', signs);
  assert.equal(route.kind, 'text');
  assert.equal(route.ground, '#7b1e2b', 'a cycle route sign');
  assert.equal(route.ink, '#ffffff');
  assert.ok(route.widthM >= 0.8 && route.widthM <= 2.8);
  assert.ok(Math.abs(route.aspect - (1.3 + 0.9) / route.cols) < 1e-9);
  assert.equal(faceFor('711.R', '@34@ Sentrum', signs).ground, '#f8a800');
  assert.equal(faceFor('711.R', '@34@ Sentrum', signs, 'Blå').ground, '#00539f', 'the colour NVDB gives the plate');
  assert.equal(faceFor('729', 'Kong Øysteins veg', signs).ground, '#ffffff');
  assert.equal(faceFor('753', undefined, signs).kind, 'art', 'no wording in NVDB: the picture');
  // a symbol plate with words: its own symbol first
  assert.deepEqual(kinds(faceFor('807.6', 'Gjelder ikke', signs).lines), [['#807.6'], ['Gjelder ikke']]);
  assert.equal(faceFor('808', 'Ingen', signs).kind, 'art');
  // the same wording on another colour is another face
  assert.notEqual(faceFor('711.R', 'Sentrum', signs).key, faceFor('711.R', 'Sentrum', signs, 'Blå').key);
});

test('signs that are pictures keep their picture whatever NVDB writes beside them', () => {
  assert.equal(faceFor('302', '@807,6@ unntatt', signs).kind, 'art');
  assert.equal(faceFor('202', 'Ingen', signs).kind, 'art');
  assert.equal(faceFor('570.2V', '150 m', signs).kind, 'art');
});

test('speed limits show their own number', () => {
  assert.deepEqual(faceFor('362.40', undefined, signs), { key: 'speed_40', kind: 'speed', value: 40, aspect: 1 });
  assert.equal(faceFor('362.50', undefined, signs).file, '362.50.png');
  assert.deepEqual(faceFor('366', 'Sone 30', signs), { key: 'zone_30', kind: 'zone', value: 30, end: false, aspect: 1.3 });
  assert.deepEqual(faceFor('368', '30', signs), { key: 'zoneend_30', kind: 'zone', value: 30, end: true, aspect: 1.3 });
  assert.equal(faceFor('364.60', undefined, signs).end, true);
  assert.equal(faceFor('366', undefined, signs).kind, 'art', 'no number known: the picture');
});

test('a worded plate is as wide as its wording, and the colour tag reaches it', () => {
  const feature = (text, extra = {}) => ({ type: 'road_sign', geometry: [{ lat: 0, lng: 0 }], tags: { 'mapng:sign': '711.R', 'mapng:sign_text': text, ...extra } });
  const plan = (f) => planNorwaySigns([f], { toWorld: () => [10, 10], signs });
  const short = plan(feature('Moholt')).plates[0], long = plan(feature('@34@ Trondheim lufthavn Værnes')).plates[0];
  assert.ok(long.width > short.width);
  assert.ok(Math.abs(short.height - short.width * short.face.aspect) < 1e-9);
  assert.equal(plan(feature('Moholt', { 'mapng:sign_colour': 'Grønn' })).plates[0].face.ground, '#00704a');
});
