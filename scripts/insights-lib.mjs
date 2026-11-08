// Instagram Insights helpers (Instagram API with Instagram Login, graph.instagram.com). No dependencies.
// Network access goes through an injectable `fetchFn` so everything can be tested offline.

export const API = 'https://graph.instagram.com/v26.0';

// Account-level metrics read as totals over a window (metric_type=total_value).
export const ACCOUNT_METRICS = [
  'reach', 'views', 'profile_views', 'accounts_engaged', 'total_interactions',
  'likes', 'comments', 'shares', 'saves', 'replies', 'follows_and_unfollows', 'profile_links_taps',
];
export const WINDOWS_DAYS = [7, 28];
export const DEMOGRAPHIC_BREAKDOWNS = ['age', 'gender', 'city', 'country'];
// Per-post metrics. Not every metric exists for every media type; unsupported ones are recorded and skipped.
export const MEDIA_METRICS = ['reach', 'views', 'likes', 'comments', 'saved', 'shares', 'total_interactions', 'profile_visits', 'follows'];

export class InsightsError extends Error {
  constructor(message, { kind = 'api', status, code, raw } = {}) {
    super(message);
    this.kind = kind; this.status = status; this.code = code; this.raw = raw;
  }
}

/** Turn an API error body into a human-friendly InsightsError. kind: permission | token | unsupported | rate | api */
export function classifyError(status, body) {
  const e = body?.error || {};
  const msg = e.message || (typeof body === 'string' ? body : JSON.stringify(body));
  const code = e.code;
  let kind = 'api';
  if (code === 190 || (e.type === 'OAuthException' && /access token|session|expired/i.test(msg))) kind = 'token';
  else if (code === 10 || code === 200 || /permission|not authorized|insufficient/i.test(msg)) kind = 'permission';
  else if (code === 4 || code === 17 || code === 32 || code === 613 || status === 429) kind = 'rate';
  else if (code === 100 || code === 36000 || code === 2108006 || /not support|invalid metric|does not exist|not available|not enough|at least/i.test(msg)) kind = 'unsupported';
  return new InsightsError(`HTTP ${status} code=${code ?? '-'} ${msg}`, { kind, status, code, raw: body });
}

export function makeClient({ token, fetchFn = fetch, base = API }) {
  const redact = (s) => (token ? String(s).split(token).join('***') : String(s));
  async function get(path, params = {}) {
    const qs = new URLSearchParams({ ...params, access_token: token });
    let res;
    try { res = await fetchFn(`${base}/${path}?${qs}`); }
    catch (e) { throw new InsightsError(redact(`network error: ${e.message}`), { kind: 'network' }); }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* keep null */ }
    if (!res.ok || json?.error) {
      const err = classifyError(res.status, json ?? text);
      err.message = redact(err.message);
      throw err;
    }
    return json;
  }
  return { get, redact };
}

const day = 86400;
const unix = (d) => Math.floor(d.getTime() / 1000);

/** Run fn; on non-fatal errors record them in `errors` and return null. permission/token errors are rethrown (stop everything). */
async function soft(errors, label, fn) {
  try { return await fn(); }
  catch (e) {
    if (e instanceof InsightsError && (e.kind === 'permission' || e.kind === 'token')) throw e;
    errors.push({ target: label, kind: e.kind || 'error', message: e.message });
    return null;
  }
}

/** Normalize a total_value insight item to { value, breakdown? }. */
export function pickTotal(item) {
  const tv = item?.total_value;
  if (!tv) return null;
  const out = { value: tv.value ?? 0 };
  if (tv.breakdowns?.length) {
    out.breakdown = tv.breakdowns.flatMap((b) => (b.results || []).map((r) => ({
      key: (r.dimension_values || []).join('/'), value: r.value,
    })));
  }
  return out;
}

export async function fetchAccount(client, igId, now, errors) {
  const profile = await soft(errors, 'account.profile', () =>
    client.get(igId, { fields: 'username,name,followers_count,follows_count,media_count' }));
  const windows = {};
  for (const days of WINDOWS_DAYS) {
    const w = {};
    const since = unix(now) - days * day;
    for (const m of ACCOUNT_METRICS) {
      const r = await soft(errors, `account.${days}d.${m}`, () =>
        client.get(`${igId}/insights`, { metric: m, period: 'day', metric_type: 'total_value', since: String(since), until: String(unix(now)) }));
      const t = pickTotal(r?.data?.[0]);
      if (t) w[m] = t.value;
    }
    windows[`${days}d`] = w;
  }
  // Daily follower_count (API only keeps ~30 days).
  let followerDaily = null;
  const fc = await soft(errors, 'account.follower_count', () =>
    client.get(`${igId}/insights`, { metric: 'follower_count', period: 'day', since: String(unix(now) - 28 * day), until: String(unix(now)) }));
  if (fc?.data?.[0]?.values) followerDaily = fc.data[0].values.map((v) => ({ date: String(v.end_time).slice(0, 10), value: v.value }));
  // Demographics (needs >= 100 followers; otherwise recorded as unsupported).
  const demographics = {};
  for (const metric of ['follower_demographics', 'reached_audience_demographics']) {
    for (const breakdown of DEMOGRAPHIC_BREAKDOWNS) {
      const params = { metric, period: 'lifetime', metric_type: 'total_value', breakdown };
      if (metric === 'reached_audience_demographics') params.timeframe = 'last_30_days';
      const r = await soft(errors, `account.${metric}.${breakdown}`, () => client.get(`${igId}/insights`, params));
      const t = pickTotal(r?.data?.[0]);
      if (t?.breakdown) (demographics[metric] ??= {})[breakdown] = t.breakdown;
    }
  }
  return { profile, windows, followerDaily, demographics };
}

export async function listMedia(client, igId) {
  const out = [];
  let after;
  for (let i = 0; i < 20; i++) {
    const r = await client.get(`${igId}/media`, { fields: 'id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count', limit: '50', ...(after ? { after } : {}) });
    out.push(...(r.data || []));
    after = r.paging?.cursors?.after;
    if (!r.paging?.next || !after) break;
  }
  return out;
}

export async function fetchMediaInsights(client, media, errors) {
  const metrics = {};
  for (const m of MEDIA_METRICS) {
    const r = await soft(errors, `media.${media.id}.${m}`, () => client.get(`${media.id}/insights`, { metric: m }));
    const item = r?.data?.[0];
    if (item?.values?.[0] && 'value' in item.values[0]) metrics[item.name] = item.values[0].value;
    else if (item?.total_value) metrics[item.name] = item.total_value.value;
  }
  return {
    id: media.id, timestamp: media.timestamp, permalink: media.permalink, type: media.media_type,
    caption_head: (media.caption || '').split('\n')[0].slice(0, 60),
    like_count: media.like_count ?? null, comments_count: media.comments_count ?? null,
    metrics,
  };
}

export async function collect({ token, igId, now = new Date(), fetchFn = fetch }) {
  const client = makeClient({ token, fetchFn });
  const errors = [];
  const account = await fetchAccount(client, igId, now, errors);
  const media = await listMedia(client, igId);
  const posts = [];
  for (const m of media) posts.push(await fetchMediaInsights(client, m, errors));
  posts.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  return { fetched_at: now.toISOString(), ig_id: igId, account, posts, errors };
}

const JST = 9 * 3600 * 1000;
const jst = (iso) => (iso ? new Date(new Date(iso).getTime() + JST).toISOString().slice(0, 16).replace('T', ' ') : '-');
const n = (v) => (v === undefined || v === null ? '-' : String(v));

export function renderMarkdown(data) {
  const L = [];
  const a = data.account || {};
  L.push(`# Instagram インサイト (${jst(data.fetched_at)} JST 取得)`, '');
  if (a.profile) L.push(`@${a.profile.username ?? '?'} / フォロワー ${n(a.profile.followers_count)} / フォロー ${n(a.profile.follows_count)} / 投稿 ${n(a.profile.media_count)}`, '');
  L.push('## アカウント', '', '| 指標 | 過去7日 | 過去28日 |', '|---|---|---|');
  const keys = [...new Set(Object.values(a.windows || {}).flatMap((w) => Object.keys(w)))];
  for (const k of keys) L.push(`| ${k} | ${n(a.windows['7d']?.[k])} | ${n(a.windows['28d']?.[k])} |`);
  if (a.followerDaily?.length) {
    const f = a.followerDaily;
    L.push('', `フォロワー増減(日次 follower_count, ${f[0].date}〜${f.at(-1).date}): 合計 ${f.reduce((s, x) => s + (x.value || 0), 0)}`);
  }
  for (const [metric, byB] of Object.entries(a.demographics || {})) {
    L.push('', `### ${metric}`);
    for (const [b, rows] of Object.entries(byB)) L.push(`- ${b}: ` + rows.slice().sort((x, y) => y.value - x.value).slice(0, 8).map((r) => `${r.key}=${r.value}`).join(', '));
  }
  L.push('', '## 投稿ごと', '', '| 投稿日(JST) | 種類 | 冒頭 | リーチ | 表示 | いいね | コメント | 保存 | シェア | 合計やりとり | プロフィール | フォロー | リンク |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const p of data.posts || []) {
    const m = p.metrics || {};
    L.push(`| ${jst(p.timestamp)} | ${p.type} | ${(p.caption_head || '').replace(/\|/g, '/')} | ${n(m.reach)} | ${n(m.views)} | ${n(m.likes ?? p.like_count)} | ${n(m.comments ?? p.comments_count)} | ${n(m.saved)} | ${n(m.shares)} | ${n(m.total_interactions)} | ${n(m.profile_visits)} | ${n(m.follows)} | ${p.permalink ?? '-'} |`);
  }
  if (data.errors?.length) {
    L.push('', '## 取得できなかった項目', '');
    for (const e of data.errors) L.push(`- ${e.target}: [${e.kind}] ${e.message}`);
  }
  return L.join('\n') + '\n';
}

/** Hint text for a fatal error. */
export function fatalHint(e) {
  if (e.kind === 'permission') return 'Missing permission. In the Meta developer dashboard (app "Manook Poster") add instagram_business_manage_insights, regenerate the Instagram token with that permission, and update the IG_ACCESS_TOKEN secret.';
  if (e.kind === 'token') return 'Token invalid or expired. Generate a new Instagram token and update the IG_ACCESS_TOKEN secret.';
  return '';
}
