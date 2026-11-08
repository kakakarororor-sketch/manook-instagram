#!/usr/bin/env node
// Downloads insights artifacts with `gh` into <dest>/YYYY-MM-DD/ (outside the repo). Existing date folders are never overwritten.
// Usage: node scripts/insights-pull.mjs [--all] [--dest=DIR] [--repo=owner/name]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const opt = (n, d) => (args.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3) || d;
const ALL = args.includes('--all');
const REPO = opt('repo', 'kakakarororor-sketch/manook-instagram');
const DEST = path.resolve(opt('dest', 'C:/Users/damai/OneDrive/Desktop/work_space/insta運用/manook/insights'));
const gh = (a) => execFileSync('gh', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

let list;
try { list = JSON.parse(gh(['api', `repos/${REPO}/actions/artifacts?name=insights&per_page=100`])).artifacts; }
catch (e) { console.error(`ERROR: gh api failed (is gh logged in?): ${e.stderr || e.message}`); process.exit(1); }
list = list.filter((a) => !a.expired).sort((a, b) => b.created_at.localeCompare(a.created_at));
if (!list.length) { console.error('ERROR: no (unexpired) insights artifact found. Run the insights workflow first.'); process.exit(1); }
if (!ALL) list = list.slice(0, 1);

for (const a of list) {
  const date = new Date(new Date(a.created_at).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const target = path.join(DEST, date);
  if (fs.existsSync(target)) { console.log(`skip ${date}: already exists (${target})`); continue; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-ins-'));
  try {
    gh(['run', 'download', String(a.workflow_run.id), '--repo', REPO, '--name', 'insights', '--dir', tmp]);
    fs.mkdirSync(DEST, { recursive: true });
    fs.cpSync(tmp, target, { recursive: true });
    console.log(`saved ${date}: ${target}`);
  } catch (e) {
    console.error(`ERROR: download of run ${a.workflow_run.id} failed: ${e.stderr || e.message}`);
    process.exitCode = 1;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
