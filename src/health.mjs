// 中轉站連線測試：node src/health.mjs（在 GitHub Actions 上先跑這個，確認海外機房連得到）
import { health } from './llm.mjs';
const lines = await health();
console.log(lines.join('\n'));
const ok = name => lines.some(l => l.startsWith('✅') && l.includes(` ${name} `));
const missing = ['deepseek', 'glm', 'claude'].filter(n => !ok(n));
if (missing.length) { console.log(`\n❌ 這些模型沒有任何一條路線可用：${missing.join('、')}`); process.exit(1); }
console.log('\n✅ 三個模型都至少有一條路線可用');
