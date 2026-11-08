#!/usr/bin/env node
// Fetches Instagram insights (account + every published post) and writes JSON + Markdown.
// Usage: node scripts/insights.mjs [--out=insights-out] [--ig-id=17841480768169354]
// Env: IG_ACCESS_TOKEN. Output is NOT meant to be committed (public repo); the workflow uploads it as an artifact.
import fs from 'node:fs';
import path from 'node:path';
import { collect, renderMarkdown, fatalHint, InsightsError } from './insights-lib.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => (args.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3) || d;
const OUT = path.resolve(opt('out', 'insights-out'));
const IG_ID = opt('ig-id', '17841480768169354');
const TOKEN = process.env.IG_ACCESS_TOKEN || '';

if (TOKEN) console.log(`::add-mask::${TOKEN}`);
if (!TOKEN) { console.error('ERROR: IG_ACCESS_TOKEN is not set.'); process.exit(1); }

try {
  const data = await collect({ token: TOKEN, igId: IG_ID });
  const stamp = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `insights-${stamp}.json`), JSON.stringify(data, null, 2));
  fs.writeFileSync(path.join(OUT, `insights-${stamp}.md`), renderMarkdown(data));
  console.log(`Wrote insights-${stamp}.json/.md to ${OUT}: ${data.posts.length} posts, ${data.errors.length} skipped items.`);
  for (const e of data.errors) console.log(`  skipped ${e.target}: [${e.kind}] ${e.message}`);
  if (!data.posts.length && !Object.keys(data.account.windows['7d'] || {}).length) {
    console.error('ERROR: nothing could be fetched.'); process.exit(1);
  }
} catch (e) {
  const hint = e instanceof InsightsError ? fatalHint(e) : '';
  console.error(`ERROR: ${e.message}${hint ? `\n${hint}` : ''}`);
  process.exit(1);
}
