// Shared helpers (no dependencies). Pure logic is kept free of network access so it can be tested offline.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const MAX_CAPTION = 2200;
export const MAX_HASHTAGS = 30;
export const MAX_IMAGES = 10;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MIN_REEL_SECONDS = 3;
export const MAX_REEL_SECONDS = 15 * 60;
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024; // GitHub rejects files > 100MB anyway

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
  const files = fs.readdirSync(dir);
  if (files.includes('reel.mp4')) return loadReel(dir, files);
  const problems = [];
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
  return { kind: 'images', images, caption, problems };
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

export function isMp4(buf) {
  return buf.length > 12 && buf.toString('latin1', 4, 8) === 'ftyp';
}

function readCaption(dir, problems) {
  const capPath = path.join(dir, 'caption.txt');
  if (!fs.existsSync(capPath)) { problems.push('caption.txt is missing'); return ''; }
  const caption = fs.readFileSync(capPath, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();
  problems.push(...validateCaption(caption));
  return caption;
}

/** Reel folder: reel.mp4 + cover.jpg + caption.txt. Returns the same shape as loadPost with kind 'reel'. Video specs are checked separately (needs ffprobe). */
function loadReel(dir, files) {
  const problems = [];
  const jpgs = files.filter((f) => /\.(jpe?g)$/i.test(f));
  const extra = jpgs.filter((f) => f !== 'cover.jpg');
  if (extra.length) problems.push(`reel folder must not contain other images (only cover.jpg): ${extra.join(', ')}`);
  const mp4s = files.filter((f) => /\.mp4$/i.test(f) && f !== 'reel.mp4');
  if (mp4s.length) problems.push(`reel folder must contain only reel.mp4, found also: ${mp4s.join(', ')}`);
  const videoBuf = fs.readFileSync(path.join(dir, 'reel.mp4'));
  if (!isMp4(videoBuf)) problems.push('reel.mp4 is not a valid MP4 (no ftyp box)');
  if (videoBuf.length > MAX_VIDEO_BYTES) problems.push(`reel.mp4 is ${videoBuf.length} bytes (max ${MAX_VIDEO_BYTES})`);
  if (!files.includes('cover.jpg')) problems.push('cover.jpg is missing (required for a reel)');
  else {
    const buf = fs.readFileSync(path.join(dir, 'cover.jpg'));
    if (!isJpeg(buf)) problems.push('cover.jpg is not a valid JPEG (bad magic bytes)');
    if (buf.length > MAX_IMAGE_BYTES) problems.push(`cover.jpg is ${buf.length} bytes (max ${MAX_IMAGE_BYTES})`);
  }
  const caption = readCaption(dir, problems);
  return { kind: 'reel', video: 'reel.mp4', cover: 'cover.jpg', images: [], caption, problems };
}

/** Judge ffprobe JSON (-show_streams -show_format) against Instagram Reels requirements. Returns a list of problems. */
export function checkVideoInfo(info) {
  const problems = [];
  const streams = info?.streams || [];
  const v = streams.find((s) => s.codec_type === 'video');
  if (!v) return ['no video stream found in reel.mp4'];
  if (v.codec_name !== 'h264') problems.push(`video codec is "${v.codec_name}", expected h264`);
  if (v.pix_fmt !== 'yuv420p') problems.push(`pixel format is "${v.pix_fmt}", expected yuv420p`);
  const { width, height } = v;
  if (!width || !height) problems.push('video size could not be read');
  else if (Math.abs(width / height - 9 / 16) > 0.01) problems.push(`video is ${width}x${height}, expected vertical 9:16 (e.g. 1080x1920)`);
  const duration = Number(v.duration ?? info?.format?.duration);
  if (!Number.isFinite(duration)) problems.push('video duration could not be read');
  else if (duration < MIN_REEL_SECONDS || duration > MAX_REEL_SECONDS) problems.push(`video is ${duration.toFixed(1)}s, expected ${MIN_REEL_SECONDS}s to ${MAX_REEL_SECONDS / 60} min`);
  const [n, d] = String(v.avg_frame_rate || '0/1').split('/').map(Number);
  const fps = d ? n / d : 0;
  if (fps && (fps < 23 || fps > 60)) problems.push(`frame rate is ${fps.toFixed(1)} fps, expected 23-60`);
  const a = streams.find((s) => s.codec_type === 'audio');
  if (a && a.codec_name !== 'aac') problems.push(`audio codec is "${a.codec_name}", expected aac`);
  return problems;
}

/** Run ffprobe (ffprobe-static if installed, else ffprobe on PATH) and return { info, summary } or throw with a clear message. */
export async function probeVideo(file) {
  let bin = 'ffprobe';
  try { bin = (await import('ffprobe-static')).default.path; } catch { /* fall back to PATH */ }
  let out;
  try {
    out = execFileSync(bin, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  } catch (e) {
    throw new Error(`ffprobe failed (${bin}): ${e.stderr || e.message}. Run "npm ci" or install ffmpeg.`);
  }
  const info = JSON.parse(out);
  const v = (info.streams || []).find((s) => s.codec_type === 'video');
  const summary = v ? `${v.width}x${v.height} ${v.codec_name} ${v.pix_fmt} ${Number(v.duration ?? info.format?.duration).toFixed(1)}s` : 'no video stream';
  return { info, summary };
}
