// 每週健檢：檢查會讓早報壞掉、但要等到出事才會發現的東西。有問題才發 Discord。
// 檢查項目：早報最近有沒有成功、各中轉站金鑰還有沒有效、Discord webhook 還在不在、手動登記的到期日
import fs from 'node:fs';

const { GITHUB_TOKEN, GITHUB_REPOSITORY: REPO, DISCORD_WEBHOOK_URL, FORCE_NOTIFY } = process.env;
const API = `https://api.github.com/repos/${REPO}`;
const cfg = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const models = JSON.parse(fs.readFileSync(new URL('../models.json', import.meta.url), 'utf8'));
const DAY = 864e5;
const problems = [], ok = [];

// 1. 早報最近 3 天有沒有成功跑過（抓到排程被停用、連續失敗、維修員也修不好的情況）
try {
  const j = await (await fetch(`${API}/actions/workflows/daily.yml/runs?per_page=30`, { headers: { Authorization: 'Bearer ' + GITHUB_TOKEN, 'User-Agent': 'radar-weekly' } })).json();
  const runs = (j.workflow_runs || []).filter(r => r.status === 'completed');
  const lastOk = runs.find(r => r.conclusion === 'success');
  const age = lastOk ? (Date.now() - Date.parse(lastOk.created_at)) / DAY : Infinity;
  const fails = runs.filter(r => r.conclusion === 'failure' && Date.now() - Date.parse(r.created_at) < 7 * DAY).length;
  if (age > 3) problems.push(`📭 早報已經 ${lastOk ? Math.floor(age) + ' 天' : '很久'}沒有成功跑過${fails ? `（這週失敗 ${fails} 次）` : '，可能排程被 GitHub 停用了'}：https://github.com/${REPO}/actions`);
  else ok.push(`早報最近一次成功：${lastOk.created_at.slice(0, 10)}${fails ? `（這週失敗 ${fails} 次，已被維修員處理）` : ''}`);
} catch (e) { problems.push('查不到早報執行紀錄：' + e.message); }

// 2. 中轉站金鑰：每個中轉站只要有一條路線能用就算正常；401/403（非 Cloudflare 驗證頁）代表金鑰失效
for (const [relay, { base, keyRef }] of Object.entries(models.relays)) {
  const key = process.env[keyRef];
  if (!key) { problems.push(`🔑 ${relay}：GitHub Secrets 裡沒有 ${keyRef}`); continue; }
  const routes = Object.values(models.models).flat().filter(r => r.relay === relay).map(r => r.model);
  let result = null;
  for (const model of [...new Set(routes)]) {
    try {
      const r = await fetch(base + '/chat/completions', { method: 'POST', signal: AbortSignal.timeout(45000), headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify({ model, messages: [{ role: 'user', content: '只回 OK' }], max_tokens: 16 }) });
      const t = await r.text();
      if (r.ok) { result = { ok: true, model }; break; }
      if (/Just a moment|challenge-platform/.test(t)) { result = { blocked: true }; break; }   // Cloudflare 擋機房 IP，不是金鑰問題
      result = { status: r.status, body: t.slice(0, 80).replace(/\s+/g, ' ') };
    } catch (e) { result = { error: e.message }; }
  }
  if (result?.ok) ok.push(`${relay} 正常（${result.model}）`);
  else if (result?.blocked) ok.push(`${relay} 在 GitHub 上被 Cloudflare 擋（預期中，早報會改走其他站）`);
  else if (result?.status === 401 || result?.status === 403) problems.push(`🔑 **${relay} 的金鑰失效**（HTTP ${result.status}）：請換新的 ${keyRef}，再跟 AI 說幫你更新 GitHub Secrets`);
  else problems.push(`⚠️ ${relay} 所有路線都不能用：${result?.status ? 'HTTP ' + result.status + ' ' + result.body : result?.error || '未知'}`);
}

// 2.5 Discord bot（讀表情用）還有沒有效
if (process.env.DISCORD_BOT_TOKEN) {
  try {
    const r = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: 'Bot ' + process.env.DISCORD_BOT_TOKEN, 'User-Agent': 'DiscordBot (radar, 0.1)' } });
    if (r.ok) ok.push(`Discord bot 正常（${(await r.json()).username}）`);
    else problems.push(`🤖 **Discord bot token 失效**（HTTP ${r.status}），讀不到你的 👍👎，自我迭代只剩熱度可看。請重設 token 後跟 AI 說幫你更新`);
  } catch (e) { problems.push('Discord bot 檢查失敗：' + e.message); }
} else problems.push('🤖 GitHub Secrets 裡沒有 DISCORD_BOT_TOKEN，自我迭代讀不到你的 👍👎');

// 3. Discord webhook 還在不在（GET 只讀資訊，不會發訊息）
try {
  const r = await fetch(DISCORD_WEBHOOK_URL);
  if (r.ok) ok.push(`Discord webhook 正常（「${(await r.json()).name}」）`);
  else problems.push(`🔗 Discord webhook 失效（HTTP ${r.status}），可能被刪了。這則提醒也發不出去，所以你是在 Actions 頁面看到這行的。`);
} catch (e) { problems.push('Discord webhook 檢查失敗：' + e.message); }

// 4. 手動登記的到期日（config.json 的 reminders），剩 10 天內開始提醒
for (const r of cfg.reminders || []) {
  const left = Math.ceil((Date.parse(r.expires + 'T00:00:00+08:00') - Date.now()) / DAY);
  if (left <= 10) problems.push(`⏰ **${r.name}** ${left > 0 ? `還剩 ${left} 天（${r.expires} 到期）` : `已經在 ${r.expires} 過期`}${r.renew ? `\n　重新產生：${r.renew}` : ''}`);
  else ok.push(`${r.name}：${r.expires} 到期，還剩 ${left} 天`);
}

console.log('正常：\n  ' + ok.join('\n  '));
console.log('問題：\n  ' + (problems.join('\n  ') || '無'));

if (problems.length || FORCE_NOTIFY === 'true') {
  const content = problems.length
    ? `🩺 **DSH 雷達每週健檢：有 ${problems.length} 件事要你處理**\n\n${problems.join('\n\n')}`
    : `🩺 **DSH 雷達每週健檢：一切正常**（測試通知）\n\n${ok.map(s => '✅ ' + s).join('\n')}`;
  const r = await fetch(DISCORD_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'DSH 雷達維修員', content: content.slice(0, 1900), allowed_mentions: { parse: [] } }) }).catch(() => null);
  console.log('Discord 通知：', r?.ok ? '已發送' : '發送失敗');
}
if (problems.length) process.exit(1);   // 讓 Actions 頁面也顯示紅色
