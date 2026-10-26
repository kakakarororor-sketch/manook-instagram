// Shared helpers (no dependencies). Pure logic is kept free of network access so it can be tested offline.
import fs from 'node:fs';
import path from 'node:path';

export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const MAX_CAPTION = 2200;
export const MAX_HASHTAGS = 30;
export const MAX_IMAGES = 10;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const FOLDER_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})_([A-Za-z0-9][A-Za-z0-9_-]*)$/;

/** Parse "YYYY-MM-DD_HHMM_slug" (JST) into a Date (UTC instant). Returns null if the name is not valid. */
export function parseFolderName(name) {
  const m = FOLDER_RE.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, slug] = m.map((v, i) => (i >= 1 && i <= 5 ? Number(v) : v));
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi) - JST_OFFSET_MS);
  if (Number.isNaN(date.getTime())) return null;
  return { name, slug, date };
}

/** Return due queue entries (JST datetime <= now), oldest first. Invalid folder names are reported in `invalid`. */
export function selectDue(queueDir, now = new Date()) {
  const invalid = [];
  const entries = [];
  if (!fs.existsSync(queueDir)) return { due: [], invalid };
  for (const ent of fs.readdirSync(queueDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const parsed = parseFolderName(ent.name);
    if (!parsed) { invalid.push(ent.name); continue; }
    entries.push(parsed);
  }
  entries.sort((a, b) => a.date - b.date || a.name.localeCompare(b.name));
  return { due: entries.filter((e) => e.date <= now), invalid };
}

export function countHashtags(text) {
  return (text.match(/(^|\s)#[^\s#]+/g) || []).length;
}

/** Returns a list of problems (empty = OK). */
export function validateCaption(text) {
  const problems = [];
  const len = [...text].length;
  if (len === 0) problems.push('caption.txt is empty');
  if (len > MAX_CAPTION) problems.push(`caption is ${len} chars (max ${MAX_CAPTION})`);
  const tags = countHashtags(text);
  if (tags > MAX_HASHTAGS) problems.push(`caption has ${tags} hashtags (max ${MAX_HASHTAGS})`);
  return problems;
}

export function isJpeg(buf) {
  return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

/** Inspect a post folder: images (01.jpg ...) + caption.txt. Returns { images, caption, problems }. */
export function loadPost(dir) {
  const problems = [];
  const files = fs.readdirSync(dir);
  const images = files.filter((f) => /\.(jpe?g)$/i.test(f)).sort();
  const others = files.filter((f) => /\.(png|gif|webp|heic)$/i.test(f));
  if (others.length) problems.push(`non-JPEG images found (Instagram API accepts JPEG only): ${others.join(', ')}. Use scripts/add-to-queue.mjs`);
  if (images.length < 1) problems.push('no .jpg images found');
  if (images.length > MAX_IMAGES) problems.push(`${images.length} images (max ${MAX_IMAGES})`);
  for (const f of images) {
    const buf = fs.readFileSync(path.join(dir, f));
    if (!isJpeg(buf)) problems.push(`${f} is not a valid JPEG (bad magic bytes)`);
    if (buf.length > MAX_IMAGE_BYTES) problems.push(`${f} is ${buf.length} bytes (max ${MAX_IMAGE_BYTES})`);
  }
  let caption = '';
  const capPath = path.join(dir, 'caption.txt');
  if (!fs.existsSync(capPath)) problems.push('caption.txt is missing');
  else {
    caption = fs.readFileSync(capPath, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();
    problems.push(...validateCaption(caption));
  }
  return { images, caption, problems };
}

/** Build the post text from caption.md: "## キャプション" body + blank line + "## ハッシュタグ" body. */
export function extractCaptionFromMarkdown(md) {
  const text = md.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const sections = {};
  let current = null;
  for (const line of text.split('\n')) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) { current = h[1]; sections[current] = []; continue; }
    if (current) sections[current].push(line);
  }
  const body = (sections['キャプション'] || []).join('\n').trim();
  const tags = (sections['ハッシュタグ'] || []).join('\n').trim();
  if (!body) throw new Error('"## キャプション" section not found or empty in caption.md');
  return tags ? `${body}\n\n${tags}\n` : `${body}\n`;
}
