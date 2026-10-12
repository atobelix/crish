const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');

const catalog = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'docs/model-capability/surveys/comprehensive-aggregated-models.json'), 'utf8'));

let md = '# 全球主流大模型多源全景调研与核心资产库（2025.06–2026.09 全集）\n\n';
md += '> **核查基准**：2026-09-03\n';
md += '> **涵盖数据源**：\n';
md += '> - **OpenRouter API**：424 个模型底层真实 Wire 参数、四价体系与思考档位（`openrouter-full-models.json`）\n';
md += '> - **ModelCompare**：1,636 个全球规范模型多源比价与参数对比（`modelcompare-full-1636.json`）\n';
md += '> - **Arena Leaderboard**：693 个参赛模型全量 Elo 排名与各项细分榜单（`arena-full-693.json`）\n';
md += '> - **Artificial Analysis**：18 个官方评测 Dataset、智力指数与延迟测速（`artificial-analysis-data.json`）\n';
md += '> - **SenseNova Console**：商汤开放平台日日新 6.8 与 deepseek-v4 实测\n';
md += '> **收录原则**：\n';
md += '> 1. **宁多不少**：涵盖国内外 40+ 家厂商，凡属于 2025 年 6 月至今迭代的前沿模型全面收录；\n';
md += '> 2. **真实时间戳**：OpenRouter 来源严格为秒级时间戳转换的精确 `YYYY-MM-DD`，绝无“初/中/末”推测；\n';
md += '> 3. **四价与思考全貌**：真实呈现输入、输出、缓读、缓写四价体系与真实思考档位，无数据处严格标为 `null`，绝不凭空臆造。\n\n';

md += '## 目录与厂商索引（41 家厂商概览）\n\n';
const vendorList = Object.entries(catalog).sort((a, b) => b[1].length - a[1].length);
md += '| 厂商代号 | 厂商名称 / 研发机构 | 收录模型数 (2025.06 后) | 代表性前沿系列 |\n';
md += '| :--- | :--- | :---: | :--- |\n';
for (const [v, list] of vendorList) {
  const sample = list.slice(0, 3).map(m => m.name.replace(/^(OpenAI|Google|Meta|Anthropic|Z\.ai|Qwen|Tencent):\s*/, '')).join(', ');
  md += `| \`${v}\` | ${v.toUpperCase()} | **${list.length}** | ${sample} |\n`;
}
md += '\n---\n\n';

for (const [v, list] of vendorList) {
  md += `## 厂商：${v.toUpperCase()}（共 ${list.length} 个前沿模型）\n\n`;
  md += '| 模型 ID (Wire Name) | 全称 Display Name | 发布时间 (YYYY-MM-DD) | 上下文 Context | 最大输出 MaxOutput | 四价体系 ($/1M Tokens)<br>[ 输入 / 输出 / 缓读 / 缓写 ] | 思考档位 (Reasoning Efforts) | 智力评分 (AA / Arena) |\n';
  md += '| :--- | :--- | :---: | :---: | :---: | :---: | :--- | :---: |\n';
  for (const m of list) {
    const pStr = `${m.prices.prompt} / ${m.prices.comp} / ${m.prices.cRead} / ${m.prices.cWrite}`;
    let rankStr = '-';
    if (m.aaScore) rankStr = `AA: **${m.aaScore.toFixed(1)}**`;
    if (m.arenaRank !== 'null') rankStr += (rankStr === '-' ? '' : '<br>') + `Arena: #${m.arenaRank} (Code: #${m.arenaCoding})`;
    md += `| \`${m.id}\` | ${m.name} | **${m.exactDate}** | ${m.context} | ${m.maxOutput} | ${pStr} | ${m.reasoning} | ${rankStr} |\n`;
  }
  md += '\n---\n\n';
}

const outPath = path.join(ROOT_DIR, 'docs/model-capability/surveys/01-主流模型多源权威数据全景调研.md');
fs.writeFileSync(outPath, md, 'utf8');
console.log('Successfully updated survey markdown, total vendors:', vendorList.length);
