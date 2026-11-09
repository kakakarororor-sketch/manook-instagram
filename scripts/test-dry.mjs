// Offline tests: node --test scripts/test-dry.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFolderName, selectDue, validateCaption, countHashtags, loadPost, extractCaptionFromMarkdown, checkVideoInfo } from './lib.mjs';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'igq-'));
  const mk = (name, n, caption) => {
    const d = path.join(root, name);
    fs.mkdirSync(d);
    for (let i = 1; i <= n; i++) fs.writeFileSync(path.join(d, `${String(i).padStart(2, '0')}.jpg`), JPEG);
    if (caption !== null) fs.writeFileSync(path.join(d, 'caption.txt'), caption);
    return d;
  };
  mk('2026-11-02_1900_second', 2, 'b #a');
  mk('2026-11-01_1900_first', 3, 'a #a #b');
  mk('2026-12-31_1200_future', 1, 'c');
  fs.mkdirSync(path.join(root, 'bad name'));
  return { root, mk };
}

test('parseFolderName reads JST as UTC+9', () => {
  const p = parseFolderName('2026-11-01_1900_first');
  assert.equal(p.date.toISOString(), '2026-11-01T10:00:00.000Z');
  assert.equal(parseFolderName('2026-13-01_1900_x'), null);
  assert.equal(parseFolderName('2026-11-01_1900_日本語'), null);
});

test('selectDue returns only due folders, oldest first, ignores invalid', () => {
  const { root } = fixture();
  const now = new Date('2026-11-02T11:00:00Z'); // 2026-11-02 20:00 JST
  const { due, invalid } = selectDue(root, now);
  assert.deepEqual(due.map((d) => d.name), ['2026-11-01_1900_first', '2026-11-02_1900_second']);
  assert.deepEqual(invalid, ['bad name']);
  assert.equal(selectDue(root, new Date('2026-11-01T09:59:00Z')).due.length, 0); // 18:59 JST
  assert.equal(selectDue(root, new Date('2026-11-01T10:00:00Z')).due.length, 1); // exactly 19:00 JST
});

test('loadPost validates a good folder', () => {
  const { root } = fixture();
  const r = loadPost(path.join(root, '2026-11-01_1900_first'));
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.images, ['01.jpg', '02.jpg', '03.jpg']);
});

test('loadPost flags PNG, missing caption, too many images, fake jpeg', () => {
  const { root, mk } = fixture();
  const d = mk('2026-11-03_1900_bad', 11, null);
  fs.writeFileSync(path.join(d, 'x.png'), 'png');
  fs.writeFileSync(path.join(d, '01.jpg'), 'not a jpeg');
  const p = loadPost(d).problems.join('\n');
  assert.match(p, /non-JPEG/);
  assert.match(p, /caption.txt is missing/);
  assert.match(p, /11 images/);
  assert.match(p, /01.jpg is not a valid JPEG/);
});

test('caption limits', () => {
  assert.deepEqual(validateCaption('hello #a'), []);
  assert.match(validateCaption('あ'.repeat(2201))[0], /2201 chars/);
  assert.deepEqual(validateCaption('あ'.repeat(2200)), []);
  const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ');
  assert.equal(countHashtags(tags), 31);
  assert.match(validateCaption(tags)[0], /31 hashtags/);
  assert.match(validateCaption('')[0], /empty/);
});

test('extractCaptionFromMarkdown joins caption and hashtags, drops notes', () => {
  const md = '# t\n\n## キャプション\n\n本文1\n本文2\n\n## ハッシュタグ\n\n#a #b\n\n## 代替テキスト\n\n1枚目';
  assert.equal(extractCaptionFromMarkdown(md), '本文1\n本文2\n\n#a #b\n');
});

// ---- reels ----
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(16)]);
const goodProbe = () => ({
  streams: [{ codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 1080, height: 1920, avg_frame_rate: '30/1', duration: '25.0' }],
  format: { duration: '25.0' },
});

function reelDir(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'igreel-'));
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(d, name), data);
  return d;
}

test('loadPost recognises a reel folder (reel.mp4 + cover.jpg + caption.txt)', () => {
  const r = loadPost(reelDir({ 'reel.mp4': MP4, 'cover.jpg': JPEG, 'caption.txt': 'hi #a' }));
  assert.deepEqual(r.problems, []);
  assert.equal(r.kind, 'reel');
  assert.equal(r.video, 'reel.mp4');
  assert.equal(r.cover, 'cover.jpg');
  assert.deepEqual(r.images, []);
});

test('loadPost keeps image folders as kind images', () => {
  const { root } = fixture();
  assert.equal(loadPost(path.join(root, '2026-11-01_1900_first')).kind, 'images');
});

test('loadPost flags reel problems: missing cover, extra image, fake mp4, no caption', () => {
  const p = loadPost(reelDir({ 'reel.mp4': Buffer.from('not a video at all'), '01.jpg': JPEG })).problems.join('\n');
  assert.match(p, /not a valid MP4/);
  assert.match(p, /cover.jpg is missing/);
  assert.match(p, /other images/);
  assert.match(p, /caption.txt is missing/);
});

test('checkVideoInfo accepts a 1080x1920 H.264 yuv420p 25s video (with or without AAC audio)', () => {
  assert.deepEqual(checkVideoInfo(goodProbe()), []);
  const withAudio = goodProbe();
  withAudio.streams.push({ codec_type: 'audio', codec_name: 'aac' });
  assert.deepEqual(checkVideoInfo(withAudio), []);
});

test('checkVideoInfo rejects wrong codec, pixel format, aspect, duration, fps, audio', () => {
  const bad = (patch) => checkVideoInfo({ streams: [{ ...goodProbe().streams[0], ...patch }] }).join('\n');
  assert.match(bad({ codec_name: 'hevc' }), /expected h264/);
  assert.match(bad({ pix_fmt: 'yuv444p' }), /expected yuv420p/);
  assert.match(bad({ width: 1920, height: 1080 }), /9:16/);
  assert.match(bad({ duration: '2.0' }), /expected 3s to 15 min/);
  assert.match(bad({ duration: '901' }), /expected 3s to 15 min/);
  assert.match(bad({ avg_frame_rate: '15/1' }), /frame rate/);
  const a = goodProbe(); a.streams.push({ codec_type: 'audio', codec_name: 'mp3' });
  assert.match(checkVideoInfo(a).join('\n'), /audio codec/);
  assert.match(checkVideoInfo({ streams: [] })[0], /no video stream/);
});
