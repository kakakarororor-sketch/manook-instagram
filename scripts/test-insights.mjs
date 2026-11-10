// Offline tests: node --test scripts/test-insights.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { metricsFor, sec, collect, renderMarkdown, classifyError, makeClient, pickTotal, InsightsError } from './insights-lib.mjs';

const TOKEN = 'SECRET_TOKEN_123';
const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const bad = (status, error) => ({ ok: false, status, text: async () => JSON.stringify({ error }) });

function fakeFetch(handler) {
  return async (url) => {
    const u = new URL(url);
    return handler(u.pathname.replace(/^\/v[\d.]+\//, ''), Object.fromEntries(u.searchParams));
  };
}

const happy = (p, q) => {
  if (p === '1') return ok({ username: 'manook_official', followers_count: 12, media_count: 2 });
  if (p === '1/media') return ok({ data: [
    { id: 'm2', media_type: 'CAROUSEL_ALBUM', timestamp: '2026-11-05T12:28:09+0000', permalink: 'https://x/2', caption: 'second\nbody', like_count: 3, comments_count: 1 },
    { id: 'm1', media_type: 'CAROUSEL_ALBUM', timestamp: '2026-10-27T00:09:00+0000', permalink: 'https://x/1', caption: 'first | pipe' },
  ] });
  if (p === '1/insights') {
    if (q.metric === 'follower_count') return ok({ data: [{ name: 'follower_count', values: [{ value: 2, end_time: '2026-11-08T08:00:00+0000' }, { value: 1, end_time: '2026-11-09T08:00:00+0000' }] }] });
    if (q.metric === 'follower_demographics') return bad(400, { code: 100, message: 'Not enough followers (at least 100 required)' });
    if (q.metric === 'reach' || q.metric === 'views') return ok({ data: [{ name: q.metric, total_value: { value: 42 } }] });
    return bad(400, { code: 100, message: 'metric not supported' });
  }
  if (p.endsWith('/insights')) {
    if (q.metric === 'profile_visits') return bad(400, { code: 100, message: 'metric not supported for this media' });
    return ok({ data: [{ name: q.metric, values: [{ value: p.startsWith('m2') ? 7 : 5 }] }] });
  }
  throw new Error(`unexpected ${p}`);
};

test('collect: shapes data, sorts posts, records unsupported metrics without stopping', async () => {
  const d = await collect({ token: TOKEN, igId: '1', now: new Date('2026-11-09T00:00:00Z'), fetchFn: fakeFetch(happy) });
  assert.deepEqual(d.posts.map((p) => p.id), ['m1', 'm2']);
  assert.equal(d.posts[1].metrics.saved, 7);
  assert.equal(d.posts[1].metrics.profile_visits, undefined);
  assert.equal(d.account.windows['7d'].reach, 42);
  assert.equal(d.account.windows['28d'].reach, 42);
  assert.equal(d.account.windows['7d'].shares, undefined);
  assert.equal(d.account.followerDaily.length, 2);
  assert.ok(d.errors.some((e) => e.target === 'account.follower_demographics.age' && e.kind === 'unsupported'));
  assert.ok(d.errors.some((e) => e.target === 'media.m1.profile_visits'));
});

test('renderMarkdown: tables, pipe escaping, skipped list', async () => {
  const d = await collect({ token: TOKEN, igId: '1', now: new Date('2026-11-09T00:00:00Z'), fetchFn: fakeFetch(happy) });
  const md = renderMarkdown(d);
  assert.match(md, /@manook_official/);
  assert.match(md, /\| reach \| 42 \| 42 \|/);
  assert.match(md, /first \/ pipe/);
  assert.match(md, /2026-11-05 21:28/); // JST
  assert.match(md, /取得できなかった項目/);
});

test('permission error stops everything with kind=permission', async () => {
  const f = fakeFetch((p) => (p === '1' ? ok({ username: 'x' }) : bad(400, { code: 10, message: '(#10) Application does not have permission for this action' })));
  await assert.rejects(collect({ token: TOKEN, igId: '1', fetchFn: f }), (e) => e instanceof InsightsError && e.kind === 'permission');
});

test('token errors are classified and the token is redacted', async () => {
  const f = fakeFetch(() => bad(401, { code: 190, type: 'OAuthException', message: `Invalid OAuth access token ${TOKEN}` }));
  await assert.rejects(makeClient({ token: TOKEN, fetchFn: f }).get('1'), (e) => e.kind === 'token' && !e.message.includes(TOKEN));
});

test('classifyError / pickTotal', () => {
  assert.equal(classifyError(429, { error: { message: 'x' } }).kind, 'rate');
  assert.equal(classifyError(400, { error: { code: 100, message: 'x' } }).kind, 'unsupported');
  assert.deepEqual(pickTotal({ total_value: { value: 3, breakdowns: [{ results: [{ dimension_values: ['F', '18-24'], value: 2 }] }] } }), { value: 3, breakdown: [{ key: 'F/18-24', value: 2 }] });
  assert.equal(pickTotal({}), null);
});

test('reels: skip profile_visits/follows, request watch time, ms->s in markdown, raw in data', async () => {
  const requested = [];
  const f = fakeFetch((p, q) => {
    if (p === '1') return ok({ username: 'x' });
    if (p === '1/media') return ok({ data: [
      { id: 'r1', media_type: 'VIDEO', media_product_type: 'REELS', timestamp: '2026-11-11T00:00:00+0000', permalink: 'https://x/r' },
      { id: 'c1', media_type: 'CAROUSEL_ALBUM', media_product_type: 'FEED', timestamp: '2026-11-01T00:00:00+0000', permalink: 'https://x/c' },
    ] });
    if (p === '1/insights') return bad(400, { code: 100, message: 'metric not supported' });
    requested.push(`${p}:${q.metric}`);
    if (p === 'r1/insights' && q.metric === 'ig_reels_video_view_total_time') return bad(400, { code: 100, message: 'metric not supported' });
    if (p === 'r1/insights' && q.metric === 'ig_reels_avg_watch_time') return ok({ data: [{ name: q.metric, values: [{ value: 4567 }] }] });
    return ok({ data: [{ name: q.metric, values: [{ value: 3 }] }] });
  });
  const d = await collect({ token: TOKEN, igId: '1', now: new Date('2026-11-12T00:00:00Z'), fetchFn: f });
  assert.ok(!requested.includes('r1/insights:profile_visits') && !requested.includes('r1/insights:follows'));
  assert.ok(requested.includes('c1/insights:profile_visits'));
  assert.ok(!requested.includes('c1/insights:ig_reels_avg_watch_time'));
  const r = d.posts.find((p) => p.id === 'r1');
  assert.equal(r.metrics.ig_reels_avg_watch_time, 4567);
  assert.ok(d.errors.some((e) => e.target === 'media.r1.ig_reels_video_view_total_time' && e.kind === 'unsupported'));
  assert.ok(!d.errors.some((e) => /r1\.(profile_visits|follows)/.test(e.target)));
  const md = renderMarkdown(d);
  assert.match(md, /平均視聴\(秒\) \| 合計視聴\(秒\)/);
  assert.match(md, /\| 4\.6 \| - \| https:\/\/x\/r \|/);
  assert.equal(sec(12345), '12.3');
  assert.equal(sec(undefined), '-');
  assert.equal(metricsFor({ media_product_type: 'FEED' }).includes('follows'), true);
});
