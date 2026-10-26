#!/usr/bin/env node
// Refreshes the long-lived Instagram token and stores the new one in the IG_ACCESS_TOKEN repo secret.
// Needs env: IG_ACCESS_TOKEN, GH_PAT (fine-grained PAT, this repo only, Repository permission "Secrets: Read and write"), GITHUB_REPOSITORY.
import { execFileSync } from 'node:child_process';

const fail = (m) => { console.error(`ERROR: ${m}`); process.exit(1); };
const old = process.env.IG_ACCESS_TOKEN;
const pat = process.env.GH_PAT;
const repo = process.env.GITHUB_REPOSITORY || 'kakakarororor-sketch/manook-instagram';

if (old) console.log(`::add-mask::${old}`);
if (!old) fail('IG_ACCESS_TOKEN secret is not set.');
if (!pat) fail('GH_PAT secret is missing. Create a fine-grained personal access token (GitHub > Settings > Developer settings > Fine-grained tokens): Repository access = only kakakarororor-sketch/manook-instagram, Repository permissions > Secrets = Read and write. Then register it as repo secret GH_PAT.');

const redact = (s) => String(s).split(old).join('***');

const url = `https://graph.instagram.com/refresh_access_token?${new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: old })}`;
const res = await fetch(url);
const text = await res.text();
let json = null;
try { json = JSON.parse(text); } catch { /* handled below */ }
if (!res.ok || !json?.access_token) {
  const hint = /expired|invalid|session/i.test(text) ? ' The token may already be expired (>60 days) or invalid; generate a new one and update IG_ACCESS_TOKEN manually.' : '';
  fail(`Token refresh failed (HTTP ${res.status}): ${redact(text)}.${hint}`);
}
const fresh = json.access_token;
console.log(`::add-mask::${fresh}`);
console.log(`Refreshed. expires_in=${json.expires_in}s (~${Math.round(json.expires_in / 86400)} days)`);

try {
  execFileSync('gh', ['secret', 'set', 'IG_ACCESS_TOKEN', '--repo', repo], {
    input: fresh, env: { ...process.env, GH_TOKEN: pat }, stdio: ['pipe', 'inherit', 'pipe'],
  });
} catch (e) {
  fail(`Failed to update secret IG_ACCESS_TOKEN via gh (check GH_PAT permissions: Secrets read/write): ${redact(e.stderr || e.message)}`);
}
console.log('Secret IG_ACCESS_TOKEN updated.');
