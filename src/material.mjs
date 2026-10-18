// 把一則候選組成給模型看的「材料」。run.mjs 和 evolve 重評都用這個，確保兩邊看到的一樣。
export function material(it) {
  const meta = it.kind === 'github'
    ? `GitHub repo｜★${it.stars}｜語言 ${it.language || '未知'}｜建立 ${it.publishedAt?.slice(0, 10)}${it.topics?.length ? '｜主題 ' + it.topics.slice(0, 6).join(', ') : ''}`
    : `來源 ${it.sourceName}${it.sourceId === 'hn' ? '（Hacker News 首頁熱門，150 分以上）' : ''}｜發布 ${it.publishedAt?.slice(0, 10) || '未知'}`;
  return `<材料>\n標題：${it.title}\n${meta}\n網址：${it.url}\n內文：${it.body || '（無）'}\n</材料>`;
}
