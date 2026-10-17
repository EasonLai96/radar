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
