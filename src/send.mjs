// 把 latest.json 發到 Discord，發成功才把這些條目記進 state/seen.json（14 天內不再出現）
// 用法：node src/send.mjs（需要環境變數 DISCORD_WEBHOOK_URL）
import fs from 'node:fs';
import { sendDiscord } from './output.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

export async function send() {
  const hook = process.env.DISCORD_WEBHOOK_URL;
  if (!hook) throw new Error('沒有 DISCORD_WEBHOOK_URL，不發送');
  const report = JSON.parse(fs.readFileSync(ROOT + 'latest.json', 'utf8'));
  await sendDiscord(hook, report);
  let seen = {};
  try { seen = JSON.parse(fs.readFileSync(ROOT + 'state/seen.json', 'utf8')); } catch {}
  const now = new Date().toISOString();
  for (const it of report.items) { seen[it.url] = now; for (const u of it.related || []) seen[u] = now; }
  fs.writeFileSync(ROOT + 'state/seen.json', JSON.stringify(seen, null, 1) + '\n');
  console.log(`已發送 ${report.items.length} 則到 Discord，記入已收錄`);
  return report.items.length;
}

if (process.argv[1] === new URL(import.meta.url).pathname) await send();
