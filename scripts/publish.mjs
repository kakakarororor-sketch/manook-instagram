#!/usr/bin/env node
// Publishes the oldest due folder in queue/ to Instagram (Instagram API with Instagram Login).
// Usage: node scripts/publish.mjs [--dry-run] [--check-urls] [--now=ISO8601] [--queue=dir] [--posted=dir]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { selectDue, loadPost } from './lib.mjs';

const API = 'https://graph.instagram.com/v26.0';
const EXPECTED_USERNAME = 'manook_official';
const REPO = process.env.GITHUB_REPOSITORY || 'kakakarororor-sketch/manook-instagram';
const POLL_INTERVAL_MS = 10_000;
const POLL_TIMEOUT_MS = 5 * 60_000;

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => (args.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3) || d;
const DRY = flag('dry-run');
const CHECK_URLS = flag('check-urls') || !DRY;
const QUEUE = path.resolve(opt('queue', 'queue'));
const POSTED = path.resolve(opt('posted', 'posted'));
const NOW = opt('now') ? new Date(opt('now')) : new Date();
const TOKEN = process.env.IG_ACCESS_TOKEN || '';

if (TOKEN) console.log(`::add-mask::${TOKEN}`);
const redact = (s) => (TOKEN ? String(s).split(TOKEN).join('***') : String(s));
const fail = (msg) => { console.error(`ERROR: ${redact(msg)}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, params = {}, soft = false) {
  const body = new URLSearchParams({ ...params, access_token: TOKEN });
  const url = `${API}/${p}`;
  const res = await fetch(method === 'GET' ? `${url}?${body}` : url, method === 'GET' ? {} : { method, body });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok || json?.error) {
    if (soft) return null;
    fail(`Instagram API ${method} /${p} failed (HTTP ${res.status}): ${text}`);
  }
  return json;
}

async function waitFinished(id, label) {
  const start = Date.now();
  for (;;) {
    const { status_code, status } = await api('GET', id, { fields: 'status_code,status' });
    if (status_code === 'FINISHED') return;
    if (['ERROR', 'EXPIRED'].includes(status_code)) fail(`${label} container ${id} ended with ${status_code}: ${status || ''}`);
    if (Date.now() - start > POLL_TIMEOUT_MS) fail(`${label} container ${id} still ${status_code} after ${POLL_TIMEOUT_MS / 1000}s (timeout)`);
    await sleep(POLL_INTERVAL_MS);
  }
}

async function checkUrl(url) {
  let res;
  try { res = await fetch(url, { method: 'GET' }); } catch (e) { fail(`Cannot fetch ${url}: ${e.message}`); }
  const ct = res.headers.get('content-type') || '';
  await res.arrayBuffer();
  if (res.status !== 200) fail(`Image URL returned HTTP ${res.status}: ${url} (is the folder pushed to GitHub at this commit?)`);
  if (!/^image\/jpe?g/i.test(ct)) fail(`Image URL has content-type "${ct}", expected image/jpeg: ${url}`);
}

function commitSha() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return 'main'; }
}

async function main() {
  const { due, invalid } = selectDue(QUEUE, NOW);
  for (const n of invalid) console.warn(`WARNING: ignoring queue folder with invalid name: ${n} (expected YYYY-MM-DD_HHMM_slug, JST)`);
  if (due.length === 0) { console.log('No due posts. Nothing to do.'); return; }
  const target = due[0];
  console.log(`Due: ${due.length} post(s). Processing oldest: ${target.name}${due.length > 1 ? ` (${due.length - 1} more waiting)` : ''}`);

  const dir = path.join(QUEUE, target.name);
  const { images, caption, problems } = loadPost(dir);
  if (problems.length) fail(`Validation failed for ${target.name}:\n - ${problems.join('\n - ')}`);

  const sha = commitSha();
  const urls = images.map((f) => `https://raw.githubusercontent.com/${REPO}/${sha}/queue/${target.name}/${f}`);
  console.log(`Images (${images.length}): ${images.join(', ')}`);
  console.log(`Caption: ${[...caption].length} chars`);

  if (CHECK_URLS) for (const u of urls) await checkUrl(u);

  if (DRY) {
    console.log(`[dry-run] Would post as ${images.length === 1 ? 'single image' : `carousel of ${images.length}`} to @${EXPECTED_USERNAME}:`);
    urls.forEach((u) => console.log(`  ${u}`));
    console.log('[dry-run] Validation OK. No Instagram API calls were made.');
    return;
  }

  if (!TOKEN) fail('IG_ACCESS_TOKEN is not set. Register it as a repository secret.');
  const me = await api('GET', 'me', { fields: 'user_id,username' });
  if (me.username !== EXPECTED_USERNAME) fail(`Token belongs to "${me.username}", expected "${EXPECTED_USERNAME}". Aborting.`);
  const igId = me.user_id || me.id;

  let creationId;
  if (urls.length === 1) {
    creationId = (await api('POST', `${igId}/media`, { image_url: urls[0], caption })).id;
  } else {
    const children = [];
    for (const u of urls) {
      const c = await api('POST', `${igId}/media`, { image_url: u, is_carousel_item: 'true' });
      children.push(c.id);
    }
    for (const c of children) await waitFinished(c, 'Carousel item');
    creationId = (await api('POST', `${igId}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption })).id;
  }
  await waitFinished(creationId, 'Post');
  const published = await api('POST', `${igId}/media_publish`, { creation_id: creationId });
  const mediaId = published.id;
  console.log(`Published media id ${mediaId}`);

  // Non-fatal: the post is already live, so never exit before recording it in posted/.
  const pl = await api('GET', mediaId, { fields: 'permalink' }, true);
  const permalink = pl?.permalink || null;

  // Move to posted/ (git mv) and write result.json.
  fs.mkdirSync(POSTED, { recursive: true });
  const dest = path.join(POSTED, target.name);
  try { execFileSync('git', ['mv', dir, dest], { stdio: 'inherit' }); } catch { fs.renameSync(dir, dest); }
  fs.writeFileSync(path.join(dest, 'result.json'), JSON.stringify({
    media_id: mediaId, permalink, published_at: new Date().toISOString(), scheduled_for_jst: target.name.slice(0, 15), image_count: images.length,
  }, null, 2) + '\n');
  console.log(`Moved to posted/${target.name}. Permalink: ${permalink}`);
}

main().catch((e) => fail(e.stack || e.message));
