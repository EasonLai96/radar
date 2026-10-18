// 收集回饋：① 你在 Discord 按的 👍/👎 ② 事後熱度（一週後回頭看 repo 星數漲多少、HN 分數多高）
// 結果寫進 state/feedback.json，每則以 url 為鍵，可以重複跑（會更新）。
import fs from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (p, d) => { try { return JSON.parse(fs.readFileSync(ROOT + p, 'utf8')); } catch { return d; } };
const DAY = 864e5;
const UA = 'radar-evolve/0.1';

export async function collectFeedback({ botToken, githubToken, log = console.log }) {
  const fb = read('state/feedback.json', {});
  const msgs = read('state/messages.json', {});

  // ① 表情：👍 +1、👎 −1；只算真人（排除 bot 自己）
  if (botToken) {
    const H = { Authorization: 'Bot ' + botToken, 'User-Agent': 'DiscordBot (radar, 0.1)' };
    let me = null;
    try { me = (await (await fetch('https://discord.com/api/v10/users/@me', { headers: H })).json()).id; } catch {}
    let n = 0;
    for (const [id, m] of Object.entries(msgs)) {
      if (Date.now() - Date.parse(m.date) > 30 * DAY) continue;
      const r = await fetch(`https://discord.com/api/v10/channels/${m.channelId}/messages/${id}`, { headers: H });
      if (r.status === 429) { await new Promise(z => setTimeout(z, 2000)); continue; }
      if (!r.ok) continue;
      const j = await r.json();
      let up = 0, down = 0;
      for (const re of j.reactions || []) {
        const c = re.count - (re.me ? 1 : 0);
        if (['👍', '❤️', '🔥', '⭐'].includes(re.emoji.name)) up += c;
        if (['👎', '💩', '😴'].includes(re.emoji.name)) down += c;
      }
      const e = fb[m.url] ||= { url: m.url, title: m.title, source: m.source, date: m.date, score: m.score, picked: true };
      e.thumbs = { up, down };
      n++;
      await new Promise(z => setTimeout(z, 250));
    }
    log(`表情回饋：讀了 ${n} 則訊息`);
  } else log('沒有 DISCORD_BOT_TOKEN，略過表情回饋');

  // ② 事後熱度：看 7–21 天前的候選（不管有沒有入選），GitHub 看星數成長，HN 看最終分數
  const audits = fs.existsSync(ROOT + 'audit') ? fs.readdirSync(ROOT + 'audit').filter(f => f.endsWith('.json')) : [];
  const GH = { 'User-Agent': UA, Accept: 'application/vnd.github+json', ...(githubToken ? { Authorization: 'Bearer ' + githubToken } : {}) };
  let checked = 0;
  for (const f of audits) {
    const date = f.slice(0, 10), age = (Date.now() - Date.parse(date)) / DAY;
    if (age < 7 || age > 21) continue;
    for (const a of JSON.parse(fs.readFileSync(ROOT + 'audit/' + f, 'utf8'))) {
      const e = fb[a.url] ||= { url: a.url, title: a.title, source: a.source, date, score: a.score, picked: a.picked };
      e.prefilter = a.prefilter?.label; e.picked = e.picked || a.picked;
      if (e.later && e.later.checkedAt && Date.now() - Date.parse(e.later.checkedAt) < 6 * DAY) continue;
      try {
        const gh = a.url.match(/^https:\/\/github\.com\/([^/]+\/[^/#?]+)$/);
        if (gh) {
          const r = await fetch(`https://api.github.com/repos/${gh[1]}`, { headers: GH });
          if (r.ok) { const j = await r.json(); const ageDays = Math.max(1, (Date.now() - Date.parse(j.created_at)) / DAY); e.later = { kind: 'github', stars: j.stargazers_count, starsPerDay: Math.round(j.stargazers_count / ageDays), checkedAt: new Date().toISOString() }; checked++; }
        } else if (a.source === 'Hacker News') {
          const q = await fetch(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(a.title)}&tags=story&hitsPerPage=1`, { headers: { 'User-Agent': UA } });
          const h = (await q.json()).hits?.[0];
          if (h) { e.later = { kind: 'hn', points: h.points, comments: h.num_comments, checkedAt: new Date().toISOString() }; checked++; }
        }
      } catch {}
    }
  }
  log(`事後熱度：查了 ${checked} 則`);

  // 合成一個「該選程度」的標籤：表情最優先，沒表情才看熱度
  for (const e of Object.values(fb)) {
    const t = e.thumbs;
    if (t && (t.up || t.down)) e.verdict = t.up > t.down ? 'good' : t.down > t.up ? 'bad' : null, e.verdictBy = 'thumbs';
    else if (e.later) {
      const hot = e.later.kind === 'github' ? e.later.starsPerDay >= 150 : e.later.points >= 400;
      const cold = e.later.kind === 'github' ? e.later.starsPerDay < 15 : e.later.points < 180;
      e.verdict = hot ? 'hot' : cold ? 'cold' : null; e.verdictBy = 'heat';
    }
  }
  for (const [u, e] of Object.entries(fb)) if (Date.now() - Date.parse(e.date) > 90 * DAY) delete fb[u];
  fs.writeFileSync(ROOT + 'state/feedback.json', JSON.stringify(fb, null, 1) + '\n');
  return fb;
}

// 從回饋挑出「判錯」的例子，給 evolve 看
export function mistakes(fb, threshold) {
  const all = Object.values(fb);
  const thumbsBad = all.filter(e => e.verdictBy === 'thumbs' && e.verdict === 'bad');           // 你按 👎 的（選錯）
  const thumbsGood = all.filter(e => e.verdictBy === 'thumbs' && e.verdict === 'good');         // 你按 👍 的（選對，要保住）
  const missedHot = all.filter(e => !e.picked && e.verdict === 'hot');                         // 沒選但後來很熱（含預篩擋掉的）
  const pickedCold = all.filter(e => e.picked && e.verdict === 'cold' && e.verdictBy === 'heat'); // 選了但沒人在意
  return { thumbsBad, thumbsGood, missedHot, pickedCold, total: all.length, withThumbs: all.filter(e => e.verdictBy === 'thumbs').length, threshold };
}
