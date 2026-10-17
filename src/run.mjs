// 早報主流程：抓取 → 去重 → 預篩 → 兩次評分 → 撰寫 → 輸出 → （可選）發 Discord
// 用法：node src/run.mjs [--dry] [--send] [--limit N]
//   --dry   不呼叫模型，只看抓到什麼
//   --send  發到 Discord（需要環境變數 DISCORD_WEBHOOK_URL）
import fs from 'node:fs';
import crypto from 'node:crypto';
import { collect, isSpam } from './sources.mjs';
import { call, stats } from './llm.mjs';
import { render, sendDiscord } from './output.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const args = process.argv.slice(2);
const DRY = args.includes('--dry'), SEND = args.includes('--send');
const LIMIT = +(args[args.indexOf('--limit') + 1] || 0) || null;
const cfg = JSON.parse(fs.readFileSync(ROOT + 'config.json', 'utf8'));
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(ROOT + p, 'utf8')); } catch { return d; } };
const writeJson = (p, v) => fs.writeFileSync(ROOT + p, JSON.stringify(v, null, 1) + '\n');
const prompt = n => fs.readFileSync(ROOT + `prompts/${n}.md`, 'utf8').replaceAll('{{siteName}}', cfg.siteName);
const P = { prefilter: prompt('prefilter'), score: prompt('score'), write: prompt('write'), group: prompt('group') };
// 提示詞版本 = 內容雜湊；改了提示詞，之後的新判斷用新版，舊的快取自動失效（AIHOT 的做法）
const ver = Object.fromEntries(Object.entries(P).map(([k, v]) => [k, crypto.createHash('sha1').update(v).digest('hex').slice(0, 8)]));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

function material(it) {
  const meta = it.kind === 'github' ? `GitHub repo｜★${it.stars}｜語言 ${it.language || '未知'}｜建立 ${it.publishedAt?.slice(0, 10)}${it.topics?.length ? '｜主題 ' + it.topics.slice(0, 6).join(', ') : ''}` : `來源 ${it.sourceName}${it.sourceId === "hn" ? "（Hacker News 首頁熱門，150 分以上）" : ""}｜發布 ${it.publishedAt?.slice(0, 10) || "未知"}`;
  return `<材料>\n標題：${it.title}\n${meta}\n網址：${it.url}\n內文：${it.body || '（無）'}\n</材料>`;
}

const today = new Intl.DateTimeFormat('sv-SE', { timeZone: cfg.timezone }).format(new Date());
const now = Date.now();
const seen = readJson('state/seen.json', {});        // url → 首次收錄日期（避免連續幾天重複出現）
const cache = readJson('state/cache.json', {});      // 判斷快取（回執）：重跑不重複花錢
for (const [u, d] of Object.entries(seen)) if (now - Date.parse(d) > cfg.seenDays * 864e5) delete seen[u];
for (const [k, v] of Object.entries(cache)) if (now - Date.parse(v.at) > 10 * 864e5) delete cache[k];

// 1. 抓取
log('抓取信源…');
const ctx = { since: now - cfg.lookbackHours * 3600e3, githubToken: process.env.GITHUB_TOKEN || (() => { try { return fs.readFileSync('/root/.gh-token', 'utf8').trim(); } catch { return ''; } })() };
const fetched = await collect(cfg, ctx);
const sourceReport = fetched.map(f => ({ id: f.src.id, name: f.src.name, count: f.items.length, error: f.error || null }));
for (const s of sourceReport) log(`  ${s.error ? '❌' : '✅'} ${s.name.padEnd(18)} ${s.count}${s.error ? ' ' + s.error : ''}`);

// 2. 去重 + 機械過濾
const byUrl = new Map(); let spam = 0, old = 0;
for (const it of fetched.flatMap(f => f.items)) {
  if (seen[it.url]) { old++; continue; }
  if (isSpam(it)) { spam++; continue; }
  const prev = byUrl.get(it.url);
  if (prev) { prev.alsoFrom = [...new Set([...(prev.alsoFrom || []), it.sourceName])]; continue; }  // 多個信源都在講 → 熱度訊號
  byUrl.set(it.url, it);
}
// 輪流從各信源取，避免單一大信源（OpenAI、HF）吃掉全部名額
const groups = Object.values(Object.groupBy([...byUrl.values()], x => x.sourceId)).map(g => g.items);
const candidates = [];
for (let r = 0; candidates.length < (LIMIT || cfg.maxCandidates) && groups.some(g => g.length > r); r++) for (const g of groups) if (g[r] && candidates.length < (LIMIT || cfg.maxCandidates)) candidates.push(g[r]);
log(`候選 ${candidates.length}（去重後 ${byUrl.size}，已收錄過 ${old}，灌星過濾 ${spam}）`);

if (DRY) { for (const c of candidates) console.log(`  [${c.sourceName}] ${c.title}${c.stars ? ' ★' + c.stars : ''}`); process.exit(0); }

// 3. 預篩
const cached = (step, it, fn) => async () => {
  const k = `${step}:${ver[step === 'scoreA' || step === 'scoreB' ? 'score' : step]}:${cfg.models[step]}:${it.url}`;
  if (cache[k]) return cache[k].v;
  const v = await fn(); cache[k] = { v, at: new Date().toISOString() }; return v;
};
log('預篩…');
await pool(candidates, 6, async it => {
  try {
    it.prefilter = await cached('prefilter', it, async () => (await call(cfg.models.prefilter, [{ role: 'system', content: P.prefilter }, { role: 'user', content: material(it) }], { json: true, maxTokens: 1500, validate: j => ['PASS', 'BLOCK', 'UNKNOWN'].includes(j.label) })).content)();
  } catch (e) { it.prefilter = { label: 'ERROR', reason: e.message.slice(0, 200) }; }
});
const passed = candidates.filter(c => c.prefilter.label === 'PASS' || c.prefilter.label === 'UNKNOWN');
log(`預篩通過 ${passed.length}/${candidates.length}`);

// 4. 兩次獨立評分（兩個不同模型，壓單次隨機性）
log('評分…');
const okScore = j => Number.isInteger(j.attentionScore) && j.attentionScore >= 0 && j.attentionScore <= 100;
await pool(passed, 5, async it => {
  const one = step => cached(step, it, async () => (await call(cfg.models[step], [{ role: 'system', content: P.score }, { role: 'user', content: material(it) }], { json: true, maxTokens: 3000, validate: okScore })).content.attentionScore)().catch(() => null);
  const [a, b] = await Promise.all([one('scoreA'), one('scoreB')]);
  it.scores = [a, b];
  const valid = it.scores.filter(x => x != null);
  // 只有一次成功時，不放水：要單次就達到門檻 + 5 才算
  it.score = valid.length === 2 ? Math.floor((a + b) / 2) : valid.length === 1 ? valid[0] - 5 : null;
});
let picked = passed.filter(it => it.score != null && it.score >= cfg.threshold).sort((x, y) => y.score - x.score || (y.alsoFrom?.length || 0) - (x.alsoFrom?.length || 0));
log(`達門檻 ${picked.length}（門檻 ${cfg.threshold}）`);

// 4.5 合併同一事件：每組留分數最高的一則（代表），其他來源記進 alsoFrom，也算熱度
if (picked.length > 1) {
  try {
    const list = picked.map((it, i) => `${i}. [${it.sourceName}] ${it.title}｜${(it.body || '').slice(0, 160).replace(/\s+/g, ' ')}`).join('\n');
    const { content } = await call(cfg.models.write, [{ role: 'system', content: P.group }, { role: 'user', content: list }], { json: true, maxTokens: 1500, validate: j => Array.isArray(j.groups) });
    const drop = new Set();
    for (const g of content.groups) {
      const idx = [...new Set(g.filter(i => Number.isInteger(i) && i >= 0 && i < picked.length))].sort((a, b) => a - b);
      if (idx.length < 2) continue;
      const lead = picked[idx[0]];   // 已按分數排序，第一個就是最高分
      for (const i of idx.slice(1)) { drop.add(i); if (picked[i].sourceName !== lead.sourceName) lead.alsoFrom = [...new Set([...(lead.alsoFrom || []), picked[i].sourceName])]; lead.related = [...(lead.related || []), picked[i].url]; }
    }
    if (drop.size) log(`合併同一事件：去掉 ${drop.size} 則重複`);
    for (const i of drop) seen[picked[i].url] = new Date().toISOString();
    picked = picked.filter((_, i) => !drop.has(i));
  } catch (e) { log('合併步驟失敗，略過：' + e.message.slice(0, 120)); }
}
picked = picked.slice(0, cfg.maxItems);
log(`入選 ${picked.length}`);

// 5. 撰寫標題摘要
log('撰寫…');
const okWrite = j => typeof j.title === 'string' && j.title && typeof j.summary === 'string' && typeof j.why === 'string';
await pool(picked, 4, async it => {
  try { it.write = await cached('write', it, async () => (await call(cfg.models.write, [{ role: 'system', content: P.write }, { role: 'user', content: material(it) }], { json: true, maxTokens: 1500, validate: okWrite })).content)(); }
  catch { it.write = { title: it.title, summary: (it.body || '').slice(0, 80), why: '' }; }
});

// 6. 輸出
const report = {
  date: today, generatedAt: new Date().toISOString(), siteName: cfg.siteName, threshold: cfg.threshold, promptVersions: ver,
  items: picked.map(it => ({ title: it.write.title, summary: it.write.summary, why: it.write.why, url: it.url, comments: it.comments, source: it.sourceName, alsoFrom: it.alsoFrom || [], stars: it.stars ?? null, score: it.score, scores: it.scores, originalTitle: it.title, related: it.related || [] })),
  nearMiss: passed.filter(it => it.score != null && it.score < cfg.threshold && it.score >= cfg.threshold - 8).sort((x, y) => y.score - x.score).slice(0, 5).map(it => ({ title: it.title, url: it.url, score: it.score, source: it.sourceName })),
  stats: { sources: sourceReport, candidates: candidates.length, prefilterPass: passed.length, scored: passed.filter(p => p.score != null).length, picked: picked.length, llm: stats },
};
// 完整判斷紀錄：之後校準門檻用（AIHOT：先改標準、再動門檻）
const audit = candidates.map(it => ({ title: it.title, url: it.url, source: it.sourceName, prefilter: it.prefilter, scores: it.scores || null, score: it.score ?? null, picked: picked.includes(it), mergedInto: null }));
fs.mkdirSync(ROOT + 'daily', { recursive: true }); fs.mkdirSync(ROOT + 'audit', { recursive: true });
fs.writeFileSync(ROOT + `daily/${today}.md`, render(report));
writeJson('latest.json', report);
writeJson(`audit/${today}.json`, audit);
for (const it of picked) seen[it.url] = new Date().toISOString();
writeJson('state/seen.json', seen); writeJson('state/cache.json', cache);
log(`寫入 daily/${today}.md｜模型呼叫 ${stats.calls} 次、失敗 ${stats.failures}、tokens ${stats.tokens}`);
log('路線：' + JSON.stringify(stats.byRoute));

if (SEND) {
  const hook = process.env.DISCORD_WEBHOOK_URL;
  if (!hook) { console.error('沒有 DISCORD_WEBHOOK_URL，不發送'); process.exit(1); }
  await sendDiscord(hook, report);
  log('已發送到 Discord');
}
