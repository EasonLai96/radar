# 📡 DSH 雷達

每天 07:30（台灣時間）自動整理「DSH 與 AI 工具」的新消息，發到 Discord。

流程參考 [AIHOT](https://github.com/KKKKhazix/AIHOT) 的篩選方法，縮成單一 Node 腳本、零套件、跑在 GitHub Actions：

```
信源（GitHub 搜尋 ×3、RSS ×7）
  → 網址去重、灌星與成人內容的機械過濾、最近收錄過的不再出現
  → 預篩（PASS / BLOCK / UNKNOWN）
  → 兩個不同模型各評一次分（0–100，五軸加權），取平均
  → 達門檻的合併同一事件
  → 撰寫標題、摘要、「你可以拿它做什麼」
  → daily/日期.md、latest.json、Discord
```

## 檔案

| 路徑 | 內容 |
|---|---|
| `config.json` | 信源、門檻（`threshold`）、每天最多幾則、各步驟用哪個模型 |
| `models.json` | 中轉站與備援順序 |
| `prompts/` | 預篩、評分、撰寫、合併的提示詞。**改口味改這裡，不用改程式** |
| `daily/` | 每天的早報 |
| `audit/` | 每則候選的預篩結果與兩次分數，用來校準門檻 |
| `state/` | 已收錄網址（14 天內不重複）、判斷快取（重跑不重複花錢） |

## 維修員（自動修復）

「早報」失敗時，`.github/workflows/medic.yml` 會自動啟動 `medic/medic.mjs`：

1. 抓失敗日誌，交給模型判斷是哪一種問題：
   - **程式 bug** → 給最小修改 → **實際重跑一次完整早報**驗證 → 通過才推送（單獨一個 commit，可以 revert）
   - **外部暫時故障**（中轉站、網路）→ 等 8 分鐘重跑
   - **需要人處理**（金鑰過期、權限）→ 在 Discord 通知你
2. 原本是排程那次失敗的，修好後會補發當天早報。
3. 只准改 `src/`、`prompts/`、`config.json`、`models.json`；workflow、`medic/`、`state/` 一律不准動。
4. 修壞了最多再試一輪，還不行就通知你，不會無限循環。

修復模型：owob `deepseek-v4.1-flash` → avianjay Claude → owob Claude（wtf 在 GitHub 機房會被 Cloudflare 擋）。

## 每週健檢

每週一 09:00 自動檢查（`.github/workflows/weekly.yml`），**有問題才發 Discord**：

- 早報最近 3 天有沒有成功（抓到排程被停用、連續失敗）
- 三家中轉站的金鑰還有沒有效
- Discord webhook 還在不在
- `config.json` 的 `reminders` 裡登記的到期日，剩 10 天內開始提醒

早報和維修員用的是 Actions 自動產生的 `GITHUB_TOKEN`，**不會過期**；個人權杖只影響從手機修改 repo。

## 本機執行

```bash
node src/run.mjs --dry        # 只看抓到什麼，不呼叫模型
node src/run.mjs              # 完整跑，不發送
node src/run.mjs --limit 20   # 只處理 20 則
node src/health.mjs           # 測中轉站連線
```

## GitHub Secrets

`WTFISTHIS_API_KEY`、`GPT_API_KEY`、`CLAUDE_API_KEY`、`DISCORD_WEBHOOK_URL`

## 調整口味

1. 看 `audit/` 裡「該選卻沒選」「不該選卻選上」的條目。
2. 先改 `prompts/score.md` 的「必須正常給分」「必須壓低」。
3. 判錯的分數都貼著門檻時，才調 `config.json` 的 `threshold`。

提示詞的版本是內容雜湊：改了提示詞，之後的判斷自動用新版，舊快取不會沿用。
