// 多中轉站路由（改自 curate/router.mjs）：前一條失敗自動換下一條。
import fs from 'node:fs';
const cfg = JSON.parse(fs.readFileSync(new URL('../models.json', import.meta.url), 'utf8'));
let localCreds = null;
function key(ref) {
  if (process.env[ref]) return process.env[ref].trim();
  if (localCreds === null) { try { localCreds = fs.readFileSync('/root/.dsh/.credentials.yaml', 'utf8'); } catch { localCreds = ''; } }
  return (localCreds.match(new RegExp(`^\\s+${ref}:\\s*["']?([^"'\\n]+)`, 'm')) || [])[1]?.trim();
}
const cooldown = new Map();
export const stats = { calls: 0, failures: 0, byRoute: {}, tokens: 0 };

function parseJson(s) {
  const t = s.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*?```(?:json)?\s*/, m => (m.includes('```') ? '' : m)).replace(/\s*```[\s\S]*$/, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('回應裡找不到 JSON');
  return JSON.parse(t.slice(a, b + 1));
}

export async function call(name, messages, { maxTokens = 2048, timeoutMs = 90000, json = false, validate } = {}) {
  const routes = cfg.models[name];
  if (!routes) throw new Error(`未知模型：${name}`);
  const errors = [];
  for (const rt of routes) {
    const id = `${rt.relay}:${rt.model}`;
    if ((cooldown.get(id) || 0) > Date.now()) { errors.push(`${id} 冷卻中`); continue; }
    const relay = cfg.relays[rt.relay];
    const k = key(relay.keyRef);
    if (!k) { errors.push(`${id} 沒有金鑰 ${relay.keyRef}`); continue; }
    stats.calls++;
    try {
      const r = await fetch(relay.base + '/chat/completions', {
        method: 'POST', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + k },
        body: JSON.stringify({ model: rt.model, messages, max_tokens: maxTokens }),
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status} ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
      const j = JSON.parse(text);
      let content = j.choices?.[0]?.message?.content ?? '';
      if (!content.trim()) throw new Error('空回應');
      if (json) { content = parseJson(content); if (validate && !validate(content)) throw new Error('JSON 欄位不合格：' + JSON.stringify(content).slice(0, 100)); }
      stats.byRoute[id] = (stats.byRoute[id] || 0) + 1;
      stats.tokens += j.usage?.total_tokens || 0;
      return { content, route: id };
    } catch (e) {
      stats.failures++;
      errors.push(`${id} → ${e.message}`);
      // 格式錯誤不冷卻（下次可能就好）；連線／HTTP 錯誤冷卻 5 分鐘
      if (!/JSON|欄位/.test(e.message)) cooldown.set(id, Date.now() + 5 * 60_000);
    }
  }
  throw new Error(`${name} 全部路線失敗：` + errors.join('｜'));
}

export async function health() {
  const out = [];
  for (const [name, routes] of Object.entries(cfg.models)) for (const rt of routes) {
    const relay = cfg.relays[rt.relay]; const k = key(relay.keyRef); const t0 = Date.now();
    if (!k) { out.push(`⚪ ${name} ${rt.relay}:${rt.model} 沒有金鑰`); continue; }
    try {
      const r = await fetch(relay.base + '/chat/completions', { method: 'POST', signal: AbortSignal.timeout(45000),
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + k },
        body: JSON.stringify({ model: rt.model, messages: [{ role: 'user', content: '只回 OK' }], max_tokens: 16 }) });
      const t = await r.text();
      out.push(`${r.ok ? '✅' : '❌'} ${name} ${rt.relay}:${rt.model} ${r.status} ${Date.now() - t0}ms${r.ok ? '' : ' ' + t.slice(0, 80).replace(/\s+/g, ' ')}`);
    } catch (e) { out.push(`❌ ${name} ${rt.relay}:${rt.model} ${e.message}`); }
  }
  return out;
}
