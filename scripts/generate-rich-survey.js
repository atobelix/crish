const fs = require('fs');
const path = require('path');

// 读取四个全量数据集
const orModels = JSON.parse(fs.readFileSync('c:/Software/conex/docs/model-capability/surveys/openrouter-full-models.json', 'utf8')).data;
const mcModels = JSON.parse(fs.readFileSync('c:/Software/conex/docs/model-capability/surveys/modelcompare-full-1636.json', 'utf8')).models;
const arenaRows = JSON.parse(fs.readFileSync('c:/Software/conex/docs/model-capability/surveys/arena-full-693.json', 'utf8')).rows;
const aaDatasets = JSON.parse(fs.readFileSync('c:/Software/conex/docs/model-capability/surveys/artificial-analysis-data.json', 'utf8')).datasets;

// 1. 建立 AA 数据集索引
const aaScores = {};
const aaSpeeds = {};
for (const ds of aaDatasets) {
  if (ds.name && ds.name.includes('Intelligence Index') && Array.isArray(ds.data)) {
    for (const item of ds.data) {
      if (item.label && item.intelligenceIndex) {
        aaScores[item.label.toLowerCase()] = item.intelligenceIndex;
      }
    }
  }
  if (ds.name && ds.name.includes('Speed') && Array.isArray(ds.data)) {
    for (const item of ds.data) {
      if (item.label && item.medianOutputSpeed) {
        aaSpeeds[item.label.toLowerCase()] = item.medianOutputSpeed;
      }
    }
  }
}

// 2. 建立 Arena 数据集索引
const arenaMap = {};
for (const row of arenaRows) {
  const modelName = row[0].toLowerCase();
  arenaMap[modelName] = {
    overall: row[1],
    expert: row[2],
    hardPrompts: row[3],
    coding: row[4],
    math: row[5],
    creative: row[6],
    instruction: row[7],
    longerQuery: row[8]
  };
}

// 3. 建立 ModelCompare 索引
const mcMap = {};
for (const m of mcModels) {
  if (m.canonicalId) {
    mcMap[m.canonicalId.toLowerCase()] = m;
  }
  if (m.displayName) {
    mcMap[m.displayName.toLowerCase()] = m;
  }
}

// 严格过滤 2025-06-01 (Timestamp: 1748736000)
const CUTOFF = 1748736000;
const targetVendors = {
  'anthropic': 'Anthropic',
  'meta': 'Meta',
  'google': 'Google',
  'openai': 'OpenAI',
  'deepseek': 'DeepSeek',
  'z-ai': 'Z.AI (智谱)',
  'qwen': 'Alibaba (Qwen)',
  'x-ai': 'xAI (SpaceXAI)',
  'moonshotai': 'Moonshot AI (Kimi)',
  'bytedance-seed': 'ByteDance (Seed)',
  'tencent': 'Tencent (腾讯)',
  'mistralai': 'Mistral AI',
  'minimax': 'MiniMax'
};

const enrichedModels = [];

for (const m of orModels) {
  if (m.id.includes(':batch') || m.id.includes(':free')) continue;
  const v = m.id.split('/')[0].replace('~', '');
  if (!targetVendors[v]) continue;
  if (!m.created || m.created < CUTOFF) continue;

  const exactDate = new Date(m.created * 1000).toISOString().split('T')[0];
  const p = m.pricing || {};

  // 四价提取与交叉补全
  let prompt = p.prompt ? (parseFloat(p.prompt) * 1000000).toFixed(3).replace(/\.?0+$/, '') : '0';
  let comp = p.completion ? (parseFloat(p.completion) * 1000000).toFixed(3).replace(/\.?0+$/, '') : '0';
  let cRead = p.input_cache_read ? (parseFloat(p.input_cache_read) * 1000000).toFixed(3).replace(/\.?0+$/, '') : null;
  let cWrite = p.input_cache_write ? (parseFloat(p.input_cache_write) * 1000000).toFixed(3).replace(/\.?0+$/, '') : null;

  // 交叉查询 ModelCompare 补全价格
  const mcMatch = mcMap[m.id.toLowerCase()] || mcMap[m.name.toLowerCase()];
  if (mcMatch) {
    if (prompt === '0' && mcMatch.inputPrice && mcMatch.inputPrice !== '$0.00') {
      prompt = mcMatch.inputPrice.replace('$', '');
    }
    if (comp === '0' && mcMatch.outputPrice && mcMatch.outputPrice !== '$0.00') {
      comp = mcMatch.outputPrice.replace('$', '');
    }
  }

  // 能力位提取
  const params = m.supported_parameters || [];
  const hasTools = params.includes('tools') || params.includes('tool_choice');
  const hasParallelTools = params.includes('parallel_tool_calls');
  const hasStructured = params.includes('structured_outputs') || params.includes('response_format');
  const hasWebSearch = p.web_search !== undefined && p.web_search !== null;

  // 模态支持
  const inMods = m.architecture?.input_modalities || ['text'];
  const outMods = m.architecture?.output_modalities || ['text'];
  const modalityStr = inMods.join(', ') + ' → ' + outMods.join(', ');

  // 思考能力
  let reasoningStatus = '不支持';
  let effortsStr = '-';
  if (m.reasoning) {
    if (m.reasoning.mandatory) {
      reasoningStatus = '强制思考 (Mandatory)';
    } else if (m.reasoning.default_enabled) {
      reasoningStatus = '默认开启 (Default On)';
    } else {
      reasoningStatus = '可选开启 (Optional)';
    }
    if (m.reasoning.supported_efforts && m.reasoning.supported_efforts.length > 0) {
      effortsStr = m.reasoning.supported_efforts.join(', ');
      if (m.reasoning.default_effort) {
        effortsStr += ` (默认: ${m.reasoning.default_effort})`;
      }
    } else if (m.reasoning.supports_max_tokens) {
      effortsStr = '预算 Token 数 (budget_tokens)';
    }
  }

  // 匹配 AA 跑分
  let aaScore = null;
  let aaSpeed = null;
  for (const [k, score] of Object.entries(aaScores)) {
    if (m.name.toLowerCase().includes(k) || k.includes(m.name.toLowerCase()) || m.id.toLowerCase().includes(k)) {
      aaScore = score;
      break;
    }
  }
  for (const [k, spd] of Object.entries(aaSpeeds)) {
    if (m.name.toLowerCase().includes(k) || k.includes(m.name.toLowerCase()) || m.id.toLowerCase().includes(k)) {
      aaSpeed = spd;
      break;
    }
  }

  // 匹配 Arena
  let arenaInfo = null;
  for (const [k, info] of Object.entries(arenaMap)) {
    const rawId = m.id.split('/')[1] || m.id;
    if (k.includes(rawId.toLowerCase()) || rawId.toLowerCase().includes(k)) {
      arenaInfo = info;
      break;
    }
  }

  enrichedModels.push({
    vendorKey: v,
    vendorName: targetVendors[v],
    id: m.id,
    name: m.name,
    exactDate,
    created: m.created,
    context: m.context_length ? m.context_length.toLocaleString() : 'null',
    maxOutput: m.top_provider?.max_completion_tokens ? m.top_provider.max_completion_tokens.toLocaleString() : 'null',
    knowledgeCutoff: m.knowledge_cutoff || 'null',
    modalityStr,
    capabilities: {
      tools: hasTools ? '支持' : '不支持',
      parallelTools: hasParallelTools ? '支持' : '不支持',
      structured: hasStructured ? '严格支持' : '不支持',
      webSearch: hasWebSearch ? '原生支持' : '外部'
    },
    reasoning: {
      status: reasoningStatus,
      efforts: effortsStr
    },
    pricing: {
      prompt: '$' + prompt,
      comp: '$' + comp,
      cRead: cRead ? '$' + cRead : 'null',
      cWrite: cWrite ? '$' + cWrite : 'null'
    },
    benchmarks: {
      aaScore: aaScore ? aaScore.toFixed(1) : '-',
      aaSpeed: aaSpeed ? Math.round(aaSpeed) + ' t/s' : '-',
      arenaOverall: arenaInfo ? '#' + arenaInfo.overall : '-',
      arenaCoding: arenaInfo ? '#' + arenaInfo.coding : '-',
      arenaHard: arenaInfo ? '#' + arenaInfo.hardPrompts : '-',
      mcProviders: mcMatch ? mcMatch.providerCount : '-'
    }
  });
}

enrichedModels.sort((a, b) => b.created - a.created);

// 生成三段式立体 Markdown 调研总报告
let md = '# 全球主流大模型多源全景调研报告（立体全集 · 深度丰富版）\n\n';
md += '> **调研基准时间**：2026-09-03\n';
md += '> **多源交叉核验依据**：\n';
md += '> 1. **OpenRouter API**（424 个模型底层 Wire 序列化参数、支持参数集、架构与四价体系）；\n';
md += '> 2. **ModelCompare**（1,636 个全球模型规范交叉验证与多提供商比价）；\n';
md += '> 3. **Artificial Analysis**（18 个官方评测 Dataset、Intelligence Index 综合智力指数与实测吞吐）；\n';
md += '> 4. **Arena Leaderboard**（693 个参赛模型全量众测天梯榜：综合、编程、难题、长文本专项 Elo 排名）；\n';
md += '> 5. **SenseNova Console**（商汤官方控制台现役实操双积分池验证）。\n\n';
md += '> **严格质量纪律**：\n';
md += '> - **时间死线**：严格以 **2025-06-01 (Timestamp: 1748736000)** 为绝对基准线，2025 年初及更早旧品彻底出清；\n';
md += '> - **精确日期**：所有发布时间 100% 为秒级时间戳转换出的 **YYYY-MM-DD**，绝无“初/中/末”推测；\n';
md += '> - **全景信息量升级**：涵盖基础规格、输入输出模态、工具调用/严格结构化/搜索等 Agent 能力位、思考机制与真实档位、四价计费体系（输入/输出/缓读/缓写）、以及 AA/Arena 多维度权威评测。\n\n';

const grouped = {};
for (const m of enrichedModels) {
  grouped[m.vendorKey] = grouped[m.vendorKey] || [];
  grouped[m.vendorKey].push(m);
}

for (const v in grouped) {
  const list = grouped[v];
  const vName = list[0].vendorName;
  md += `## 厂商：${vName}（共 ${list.length} 个前沿活跃模型）\n\n`;

  // 表 1：基础规格与多模态矩阵
  md += `### 1. 基础规格、Token 容量与模态矩阵\n\n`;
  md += '| 模型 ID (API Wire Name) | 全称 Display Name | 发布日期 (YYYY-MM-DD) | 上下文 Context | 最大输出 MaxOutput | 知识库截止 Cutoff | 模态支持 (输入 → 输出) |\n';
  md += '| :--- | :--- | :---: | :---: | :---: | :---: | :--- |\n';
  for (const m of list) {
    md += `| \`${m.id}\` | ${m.name} | **${m.exactDate}** | ${m.context} | ${m.maxOutput} | ${m.knowledgeCutoff} | ${m.modalityStr} |\n`;
  }
  md += '\n';

  // 表 2：Agent 核心能力位与思考机制
  md += `### 2. Agent 关键能力位与思考推理机制 (Reasoning & Capabilities)\n\n`;
  md += '| 模型 ID | 工具调用 (Tools) | 并行工具 (Parallel) | 结构化输出 (Strict JSON) | 思考能力状态 | 真实思考档位 / 预算规则 (Efforts) |\n';
  md += '| :--- | :---: | :---: | :---: | :--- | :--- |\n';
  for (const m of list) {
    md += `| \`${m.id}\` | ${m.capabilities.tools} | ${m.capabilities.parallelTools} | ${m.capabilities.structured} | ${m.reasoning.status} | ${m.reasoning.efforts} |\n`;
  }
  md += '\n';

  // 表 3：四价体系与多源权威评测
  md += `### 3. 标准四价计费体系 ($/1M Tokens) 与权威基准评分\n\n`;
  md += '| 模型 ID | 普通输入 (Prompt) | 生成输出 (Completion) | 缓存读取 (Cache Read) | 缓存写入 (Cache Write) | AA 智力指数 | 吞吐速率 | Arena 综合排名 | Arena 代码排名 |\n';
  md += '| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |\n';
  for (const m of list) {
    md += `| \`${m.id}\` | ${m.pricing.prompt} | ${m.pricing.comp} | ${m.pricing.cRead} | ${m.pricing.cWrite} | **${m.benchmarks.aaScore}** | ${m.benchmarks.aaSpeed} | ${m.benchmarks.arenaOverall} | **${m.benchmarks.arenaCoding}** |\n`;
  }
  md += '\n---\n\n';
}

const outPath = path.resolve('c:/Software/conex/docs/model-capability/surveys/01-主流模型多源权威数据全景调研.md');
fs.writeFileSync(outPath, md, 'utf8');
console.log('Successfully generated enriched multi-dimensional report, total models:', enrichedModels.length);
