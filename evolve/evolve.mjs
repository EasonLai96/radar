// 自我迭代：每週一次
//   1. 收集回饋（表情 + 事後熱度）→ 找出判錯的例子
//   2. 叫模型提出修改（評分／預篩提示詞、門檻、信源）
//   3. 用新設定「重評」過去的候選，跟舊設定比：判錯的有沒有變少、你按 👍 的有沒有被誤殺
//   4. 確實變好 → 開 PR 給你合併；沒變好 → 不開，只記錄
// 用法：node evolve/evolve.mjs [--dry]（--dry 只看回饋和提案，不重評、不開 PR）
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { collectFeedback, mistakes } from './feedback.mjs';
import { call, stats } from '../src/llm.mjs';
import { material } from '../src/material.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const DRY = process.argv.includes('--dry');
const { GITHUB_TOKEN, GITHUB_REPOSITORY: REPO = 'EasonLai96/radar', DISCORD_BOT_TOKEN, DISCORD_WEBHOOK_URL } = process.env;
const log = (...a) => console.log(`[evolve ${new Date().toISOString().slice(11, 19)}]`, ...a);
const read = p => fs.readFileSync(ROOT + p, 'utf8');
const MIN_EVIDENCE = 4;       // 判錯例子少於這個數就不動（資料太少，改了只是在追雜訊）
const MAX_REPLAY = 70;        // 重評最多幾則（控制成本）
const ALLOWED = ['prompts/score.md', 'prompts/prefilter.md', 'config.json'];

// ---------- 1. 回饋 ----------
const fb = await collectFeedback({ botToken: DISCORD_BOT_TOKEN, githubToken: GITHUB_TOKEN, log });
const cfg = JSON.parse(read('config.json'));
const mk = mistakes(fb, cfg.threshold);
log(`回饋：共 ${mk.total} 則，有表情 ${mk.withThumbs}｜👎 ${mk.thumbsBad.length}、👍 ${mk.thumbsGood.length}、漏選但後來很熱 ${mk.missedHot.length}、選了但沒人在意 ${mk.pickedCold.length}`);
const evidence = mk.thumbsBad.length * 2 + mk.missedHot.length + mk.pickedCold.length;   // 你的 👎 算兩倍
if (evidence < MIN_EVIDENCE) { log(`判錯例子不夠（${evidence} < ${MIN_EVIDENCE}），這週不改`); writeHistory({ result: 'skip', reason: '回饋不足', evidence }); process.exit(0); }

// ---------- 2. 提案 ----------
const fmt = e => `- [${e.source}] ${e.title}｜當時 ${e.score ?? '—'} 分${e.prefilter === 'BLOCK' ? '（預篩擋掉）' : ''}${e.thumbs ? `｜👍${e.thumbs.up} 👎${e.thumbs.down}` : ''}${e.later ? `｜一週後 ${e.later.kind === 'github' ? `★${e.later.stars}（每天 +${e.later.starsPerDay}）` : `HN ${e.later.points} 分`}` : ''}`;
const history = readHistory();
const SYSTEM = `你負責改進一個 AI 早報的篩選標準。讀者是在手機上用 DSH 寫程式、做 Discord 機器人、網頁小遊戲、AI 繪圖的高中生開發者。

你會看到：目前的評分提示詞、預篩提示詞、設定檔，以及一週的判錯例子。
目標：讓「讀者按 👎 的」分數變低、「漏選但後來很熱，而且讀者會在意的」分數變高，同時**不能誤殺讀者按 👍 的**。

原則：
1. 讀者的 👍/👎 是最可靠的訊號，比熱度重要得多。熱度高不代表讀者在意（例如硬體、政治、企業新聞再熱也不該選）。
2. 優先改評分提示詞的「必須正常給分」「必須壓低」兩段，寫成**可以判斷的具體規則**，不要寫只針對單一 repo 的規則，也不要列舉具體 repo 名稱。
3. 門檻（threshold）一次最多動 ±4，而且只有當判錯的例子都貼著門檻時才動。
4. 信源（config.json 的 sources）：可以新增 RSS 或調整 GitHub 搜尋條件。新增 RSS 只能是你確定存在、與讀者相關的公開網址；不確定就不要加。不准刪掉現有信源，可以把 limit 調低。
5. 不准改：輸出格式（只回 JSON {"attentionScore":N} 那行）、輸入安全那段、五軸與權重表的結構、讀者描述。
6. 改動要小而精準。一次最多 3 處修改。

只輸出 JSON：
{"summary":"一句話說這次改了什麼","rationale":"為什麼（引用哪些例子）","edits":[{"file":"prompts/score.md|prompts/prefilter.md|config.json","search":"原文中逐字一樣且只出現一次的片段","replace":"改後內容"}]}
如果判斷這些例子只是雜訊、不值得改，回 {"summary":"不改","rationale":"...","edits":[]}`;
const user = `## 目前的 prompts/score.md
${read('prompts/score.md')}

## 目前的 prompts/prefilter.md
${read('prompts/prefilter.md')}

## 目前的 config.json
${read('config.json')}

## 讀者按 👎 的（不該選）
${mk.thumbsBad.map(fmt).join('\n') || '（無）'}

## 讀者按 👍 的（選對了，不能誤殺）
${mk.thumbsGood.map(fmt).join('\n') || '（無）'}

## 沒選，但一週後很熱的（可能漏選，但要判斷讀者是否真的在意）
${mk.missedHot.slice(0, 25).map(fmt).join('\n') || '（無）'}

## 選了，但一週後沒人在意的
${mk.pickedCold.slice(0, 15).map(fmt).join('\n') || '（無）'}

## 過去幾次迭代（避免來回改同一件事）
${history.slice(-6).map(h => `- ${h.date}｜${h.result}｜${h.summary || h.reason || ''}`).join('\n') || '（第一次）'}`;

let proposal;
for (let i = 0; i < 3 && !proposal; i++) {
  try {
    const r = await call(cfg.models.write, [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }], { json: true, maxTokens: 6000, timeoutMs: 240000, validate: j => typeof j.summary === 'string' && Array.isArray(j.edits) });
    proposal = r.content; proposal.model = r.route;
  } catch (e) { log('提案失敗：' + e.message.slice(0, 200)); }
}
if (!proposal) { writeHistory({ result: 'error', reason: '叫不到模型' }); process.exit(1); }
log(`提案（${proposal.model}）：${proposal.summary}`);
if (!proposal.edits.length) { writeHistory({ result: 'skip', reason: '模型判斷不需要改', summary: proposal.rationale?.slice(0, 200) }); process.exit(0); }

// ---------- 套用到「暫存副本」，不碰正式檔案 ----------
const before = Object.fromEntries(ALLOWED.map(f => [f, read(f)]));
const after = { ...before };
const problems = [];
for (const e of proposal.edits.slice(0, 3)) {
  if (!ALLOWED.includes(e.file)) { problems.push(`不准改 ${e.file}`); continue; }
  const n = e.search ? after[e.file].split(e.search).length - 1 : 0;
  if (n !== 1) { problems.push(`${e.file} 的 search 片段出現 ${n} 次`); continue; }
  after[e.file] = after[e.file].replace(e.search, () => e.replace);
}
// 護欄：評分提示詞的輸出格式、輸入安全段一定要還在；config 要是合法 JSON 且信源只增不減、門檻只動 ±4
if (!after['prompts/score.md'].includes('只回 JSON：{"attentionScore": 0}')) problems.push('評分輸出格式被改掉了');
if (!after['prompts/score.md'].includes('## 輸入安全')) problems.push('輸入安全段被刪了');
if (!after['prompts/prefilter.md'].includes('只輸出 JSON')) problems.push('預篩輸出格式被改掉了');
let newCfg;
try {
  newCfg = JSON.parse(after['config.json']);
  const oldIds = cfg.sources.map(s => s.id), newIds = newCfg.sources.map(s => s.id);
  if (oldIds.some(id => !newIds.includes(id))) problems.push('刪掉了信源');
  if (Math.abs(newCfg.threshold - cfg.threshold) > 4) problems.push(`門檻一次動太多（${cfg.threshold}→${newCfg.threshold}）`);
  if (JSON.stringify(newCfg.models) !== JSON.stringify(cfg.models)) problems.push('改了模型設定');
  for (const s of newCfg.sources.filter(s => !oldIds.includes(s.id))) {
    if (s.kind === 'rss') {
      try { const r = await fetch(s.url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'radar-evolve' } }); const t = await r.text(); if (!r.ok || !/<(item|entry)[\s>]/.test(t)) problems.push(`新信源 ${s.url} 抓不到內容（HTTP ${r.status}）`); }
      catch (e) { problems.push(`新信源 ${s.url} 連不上`); }
    } else if (s.kind !== 'github_search') problems.push(`不認得的信源類型 ${s.kind}`);
  }
} catch (e) { problems.push('config.json 不是合法 JSON'); }
if (problems.length) { log('提案不合格：' + problems.join('；')); writeHistory({ result: 'rejected', summary: proposal.summary, reason: problems.join('；') }); process.exit(0); }
if (DRY) { log('--dry：不重評、不開 PR'); console.log(JSON.stringify(proposal, null, 1)); process.exit(0); }

// ---------- 3. 重評：用新舊兩套標準評同一批有回饋的候選 ----------
const labeled = Object.values(fb).filter(e => e.verdict);
const audits = loadAudits();
const sample = labeled.filter(e => audits[e.url]).sort((a, b) => (b.verdictBy === 'thumbs') - (a.verdictBy === 'thumbs')).slice(0, MAX_REPLAY);
log(`重評 ${sample.length} 則有回饋的候選（新舊各一次）`);
const scorePrompt = (txt) => txt.replaceAll('{{siteName}}', cfg.siteName);
const prePrompt = (txt) => txt.replaceAll('{{siteName}}', cfg.siteName);
async function judge(e, which) {
  const a = audits[e.url];
  const it = { ...a, sourceName: a.source };
  const P = which === 'new' ? after : before;
  const preChanged = P['prompts/prefilter.md'] !== before['prompts/prefilter.md'];
  if (which === 'new' && preChanged || a.prefilter?.label === undefined) {
    try { const r = await call(cfg.models.prefilter, [{ role: 'system', content: prePrompt(P['prompts/prefilter.md']) }, { role: 'user', content: material(it) }], { json: true, maxTokens: 1500, validate: j => ['PASS', 'BLOCK', 'UNKNOWN'].includes(j.label) }); if (r.content.label === 'BLOCK') return 0; } catch { return null; }
  } else if (a.prefilter?.label === 'BLOCK' && which === 'old') return 0;
  // 兩個模型各評一次取平均（跟正式流程一樣）
  const one = async m => { try { return (await call(cfg.models[m], [{ role: 'system', content: scorePrompt(P['prompts/score.md']) }, { role: 'user', content: material(it) }], { json: true, maxTokens: 3000, validate: j => Number.isInteger(j.attentionScore) })).content.attentionScore; } catch { return null; } };
  const [x, y] = await Promise.all([one('scoreA'), one('scoreB')]);
  const v = [x, y].filter(z => z != null);
  return v.length ? Math.floor(v.reduce((s, z) => s + z, 0) / v.length) : null;
}
const rows = [];
let idx = 0;
await Promise.all(Array.from({ length: 4 }, async () => { while (idx < sample.length) { const e = sample[idx++]; const [o, n] = await Promise.all([judge(e, 'old'), judge(e, 'new')]); rows.push({ e, old: o, new: n }); } }));

// ---------- 評估 ----------
// 好的方向：good/hot 要過門檻、bad/cold 要不過門檻。你的表情權重 3，熱度權重 1。
const thrOld = cfg.threshold, thrNew = newCfg.threshold;
const weight = e => e.verdictBy === 'thumbs' ? 3 : 1;
const want = e => (e.verdict === 'good' || e.verdict === 'hot');
function grade(key, thr) {
  let s = 0, max = 0, wrong = [];
  for (const r of rows) { if (r[key] == null) continue; const ok = (r[key] >= thr) === want(r.e); max += weight(r.e); if (ok) s += weight(r.e); else wrong.push(r.e.title); }
  return { pct: max ? Math.round(100 * s / max) : 0, wrong };
}
const go = grade('old', thrOld), gn = grade('new', thrNew);
const killedGood = rows.filter(r => r.e.verdictBy === 'thumbs' && r.e.verdict === 'good' && r.old != null && r.new != null && r.old >= thrOld && r.new < thrNew).map(r => r.e.title);
log(`重評結果：舊 ${go.pct}% → 新 ${gn.pct}%｜誤殺 👍 ${killedGood.length} 則`);
const better = gn.pct >= go.pct + 3 && killedGood.length === 0;
if (!better) { writeHistory({ result: 'no-gain', summary: proposal.summary, before: go.pct, after: gn.pct, killedGood: killedGood.length }); log('沒有明顯變好，不開 PR'); process.exit(0); }

// ---------- 4. 開 PR ----------
const date = new Date().toISOString().slice(0, 10);
const branch = `evolve/${date}-${crypto.randomBytes(2).toString('hex')}`;
const sh = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' });
sh('checkout', '-q', '-b', branch);
for (const f of ALLOWED) if (after[f] !== before[f]) fs.writeFileSync(ROOT + f, after[f]);
sh('add', ...ALLOWED);
sh('-c', 'user.name=radar-evolve', '-c', 'user.email=radar-evolve@users.noreply.github.com', 'commit', '-qm', `🧬 ${proposal.summary}`.slice(0, 100));
sh('push', '-q', 'origin', branch);

const flips = rows.filter(r => r.old != null && r.new != null && (r.old >= thrOld) !== (r.new >= thrNew));
const body = `## 這次改了什麼
${proposal.summary}

**為什麼：** ${proposal.rationale}

## 驗證（用過去的候選重評）
| | 舊標準 | 新標準 |
|---|---:|---:|
| 判對比例（你的 👍👎 權重 3、熱度權重 1） | **${go.pct}%** | **${gn.pct}%** |
| 門檻 | ${thrOld} | ${thrNew} |
| 誤殺你按 👍 的 | — | ${killedGood.length} 則 |

重評了 ${rows.length} 則（有表情的 ${rows.filter(r => r.e.verdictBy === 'thumbs').length} 則）。

### 會改變入選結果的
${flips.length ? flips.map(r => `- ${r.new >= thrNew ? '➕ 會入選' : '➖ 不再入選'}｜${r.e.title}｜${r.old}→${r.new}｜${r.e.verdictBy === 'thumbs' ? `你按了 ${r.e.verdict === 'good' ? '👍' : '👎'}` : r.e.verdict === 'hot' ? '後來很熱' : '後來沒人在意'}`).join('\n') : '（無）'}

## 怎麼處理
- 看得懂、同意 → **Merge**，明天的早報就用新標準
- 不同意 → **Close**，下週不會再提一樣的東西

<sub>提案模型 ${proposal.model}｜模型呼叫 ${stats.calls} 次</sub>`;
const r = await fetch(`https://api.github.com/repos/${REPO}/pulls`, { method: 'POST', headers: { Authorization: 'Bearer ' + GITHUB_TOKEN, 'User-Agent': 'radar-evolve', Accept: 'application/vnd.github+json' }, body: JSON.stringify({ title: `🧬 ${proposal.summary}`.slice(0, 120), head: branch, base: 'main', body }) });
const pr = await r.json();
if (!r.ok) { log('開 PR 失敗：' + JSON.stringify(pr).slice(0, 300)); process.exit(1); }
log('已開 PR：' + pr.html_url);
sh('checkout', '-q', 'main');
writeHistory({ result: 'pr', summary: proposal.summary, before: go.pct, after: gn.pct, pr: pr.html_url });
if (DISCORD_WEBHOOK_URL) await fetch(DISCORD_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'DSH 雷達', content: `🧬 **雷達想調整選新聞的標準**\n${proposal.summary}\n用過去的資料重評：判對比例 ${go.pct}% → **${gn.pct}%**\n同意就去按 Merge：${pr.html_url}`, allowed_mentions: { parse: [] } }) }).catch(() => {});

// ---------- 工具 ----------
function loadAudits() {
  const out = {};
  for (const f of fs.existsSync(ROOT + 'audit') ? fs.readdirSync(ROOT + 'audit').filter(f => f.endsWith('.json')) : [])
    for (const a of JSON.parse(fs.readFileSync(ROOT + 'audit/' + f, 'utf8'))) if (a.body !== undefined || a.kind) out[a.url] = a;
  return out;
}
function readHistory() { try { return JSON.parse(read('state/evolve-history.json')); } catch { return []; } }
function writeHistory(h) {
  // 只存在記憶體裡的 history 會在下一步被 workflow 的 commit 收進 repo
  const all = readHistory(); all.push({ date: new Date().toISOString().slice(0, 10), ...h });
  fs.writeFileSync(ROOT + 'state/evolve-history.json', JSON.stringify(all.slice(-40), null, 1) + '\n');
}
