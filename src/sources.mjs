// 信源：GitHub 搜尋 + RSS/Atom。只用 Node 內建 fetch，不裝套件。
const UA = 'radar-bot/0.1 (+https://github.com/EasonLai96/radar)';

const decode = s => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&');
const strip = s => decode(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (block, name) => { const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i')); return m ? m[1] : ''; };

export function normalizeUrl(u) {
  try {
    const x = new URL(u);
    for (const p of [...x.searchParams.keys()]) if (/^(utm_|ref$|source$|fbclid$)/.test(p)) x.searchParams.delete(p);
    x.hash = ''; return x.toString().replace(/\/$/, '');
  } catch { return u; }
}

function parseFeed(xml) {
  const out = [];
  for (const m of xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/g)) {
    const b = m[0];
    let link = strip(tag(b, 'link'));
    if (!link) { const l = b.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/) || b.match(/<link[^>]*href="([^"]+)"/); link = l ? decode(l[1]) : ''; }
    const date = strip(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date'));
    const body = strip(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content:encoded') || tag(b, 'content'));
    // HN 的 RSS 連結指向原文，評論頁在 <comments>
    out.push({ title: strip(tag(b, 'title')), url: link, publishedAt: date ? new Date(date).toISOString() : null, body: body.slice(0, 1500), comments: strip(tag(b, 'comments')) || null });
  }
  return out;
}

async function rss(src, ctx) {
  const r = await fetch(src.url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return parseFeed(await r.text())
    .filter(x => x.url && x.title && (!x.publishedAt || Date.parse(x.publishedAt) >= ctx.since))
    .slice(0, src.limit || 30)
    .map(x => ({ ...x, kind: 'rss' }));
}

async function ghReadme(full, token) {
  try {
    const r = await fetch(`https://api.github.com/repos/${full}/readme`, { headers: { Authorization: token ? 'Bearer ' + token : undefined, 'User-Agent': UA, Accept: 'application/vnd.github.raw' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return '';
    return (await r.text()).replace(/<[^>]+>/g, ' ').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').slice(0, 1800);
  } catch { return ''; }
}

async function githubSearch(src, ctx) {
  const since7d = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const since14d = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
  const q = src.query.replace("{since7d}", since7d).replace("{since14d}", since14d);
  const h = { 'User-Agent': UA, Accept: 'application/vnd.github+json' };
  if (ctx.githubToken) h.Authorization = 'Bearer ' + ctx.githubToken;
  const r = await fetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${src.limit || 20}`, { headers: h, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 100)}`);
  const j = await r.json();
  const items = (j.items || []).filter(x => !x.fork && !x.archived);
  const out = [];
  for (const x of items) {
    out.push({
      kind: 'github', title: x.full_name, url: x.html_url, publishedAt: x.created_at,
      stars: x.stargazers_count, language: x.language, topics: x.topics || [],
      body: `${x.description || ''}\n\nREADME 節錄：${await ghReadme(x.full_name, ctx.githubToken)}`.slice(0, 2200),
    });
  }
  return out;
}

const KINDS = { rss, github_search: githubSearch };

export async function collect(config, ctx) {
  const results = await Promise.all(config.sources.map(async src => {
    try {
      const items = await KINDS[src.kind](src, ctx);
      return { src, items: items.map(it => ({ ...it, sourceId: src.id, sourceName: src.name, url: normalizeUrl(it.url) })) };
    } catch (e) { return { src, items: [], error: e.message }; }
  }));
  return results;
}

// 灌星 / SEO 垃圾的機械規則（AIHOT 的「旧文不刷屏」精神：先用便宜規則擋明顯噪聲）
const NSFW = /\b(nsfw|hentai|porn|nude|18\+|r18|lewd)\b|成人向|色情/i;
const SPAM = /\b(aimbot|auto ?farm|script hub|free robux|god mode|trainer|cheat|crack(ed)?|keygen|unlocker|mod menu|spoofer)\b|best .{0,40} 20\d\d|ultimate .{0,40} 20\d\d/i;
export function isSpam(it) { const t = `${it.title} ${it.body.slice(0, 600)}`; return SPAM.test(t) || NSFW.test(t); }
