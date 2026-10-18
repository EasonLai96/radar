// 產生 Markdown 早報，以及 Discord webhook 訊息
const medal = i => ['🥇', '🥈', '🥉'][i] || `**${i + 1}.**`;
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const WEEK = '日一二三四五六';

export function render(r) {
  const d = new Date(r.date + 'T00:00:00+08:00');
  const lines = [`# ${r.siteName}｜${r.date}（${WEEK[d.getUTCDay()]}）`, ''];
  if (!r.items.length) lines.push('今天沒有達到門檻的消息。', '');
  r.items.forEach((it, i) => {
    lines.push(`## ${i + 1}. ${it.title}`, '', it.summary, '');
    if (it.why) lines.push(`> 💡 ${it.why}`, '');
    lines.push(`[${it.originalTitle}](${it.url})｜${it.source}${it.stars != null ? `｜★${it.stars}` : ''}${it.alsoFrom.length ? `｜也出現在 ${it.alsoFrom.join('、')}` : ''}｜評分 ${it.score}（${it.scores.map(s => s ?? '—').join(' / ')}）`, '');
  });
  if (r.nearMiss.length) {
    lines.push('---', '', '### 差一點入選', '');
    for (const n of r.nearMiss) lines.push(`- [${n.title}](${n.url})｜${n.source}｜${n.score}`);
    lines.push('');
  }
  const s = r.stats;
  lines.push('---', '', `候選 ${s.candidates} → 預篩通過 ${s.prefilterPass} → 入選 ${s.picked}｜門檻 ${r.threshold}｜模型呼叫 ${s.llm.calls} 次（失敗 ${s.llm.failures}）`);
  const bad = s.sources.filter(x => x.error);
  if (bad.length) lines.push('', '⚠️ 抓取失敗：' + bad.map(x => `${x.name}（${x.error}）`).join('、'));
  return lines.join('\n') + '\n';
}

const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function discordPayloads(r) {
  const d = new Date(r.date + 'T00:00:00+08:00');
  const head = `## 📡 ${r.siteName}｜${r.date.slice(5).replace('-', '/')}（${WEEK[d.getUTCDay()]}）\n今天 ${r.items.length} 則${r.items.length ? '' : '，沒有夠份量的消息 😴'}`;
  const embeds = r.items.map((it, i) => ({
    title: cut(`${i + 1}. ${it.title}`, 256),
    url: it.url,
    description: cut(`${it.summary}${it.why ? `\n💡 ${it.why}` : ''}`, 1000),
    color: it.score >= 80 ? 0xf5a524 : it.score >= 72 ? 0x4d6bfe : 0x6b7280,
    footer: { text: cut(`${it.source}${it.stars != null ? ` · ★${it.stars}` : ''} · ${host(it.url)} · ${it.score} 分`, 200) },
  }));
  // 每則新聞單獨一則訊息：表情是按在「訊息」上，一則一個訊息才能知道你在評哪一則
  const out = [{ username: r.siteName, content: head + (embeds.length ? '\n-# 覺得好就按 👍，不想看到這類就按 👎，雷達會照著調整' : ''), embeds: [], allowed_mentions: { parse: [] } }];
  for (const e of embeds) out.push({ username: r.siteName, embeds: [e], allowed_mentions: { parse: [] } });
  return out;
}

// 回傳每則早報條目對應的 Discord 訊息 id（讓之後能讀表情回饋）
export async function sendDiscord(hook, r) {
  const sent = [];
  const payloads = discordPayloads(r);
  for (const [bi, body] of payloads.entries()) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(hook + (hook.includes('?') ? '&' : '?') + 'wait=true', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res.ok) { const m = await res.json().catch(() => ({})); if (bi > 0) sent.push({ messageId: m.id, channelId: m.channel_id, url: r.items[bi - 1].url }); break; }
      if (res.status === 429) { const j = await res.json().catch(() => ({})); await new Promise(z => setTimeout(z, ((j.retry_after || 2) * 1000) + 200)); continue; }
      throw new Error(`Discord ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    await new Promise(z => setTimeout(z, 600));
  }
  return sent;
}
