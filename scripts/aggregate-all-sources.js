const fs = require('fs');
const path = require('path');

// 1. 读取四个全量数据集
const mcModels = JSON.parse(fs.readFileSync('c:/Software/conex/docs/model-capability/surveys/modelcompare-full-1636.json', 'utf8')).models;
const arenaRows = JSON.parse(fs.readFileSync('c:/Software/conex/docs/model-capability/surveys/arena-full-693.json', 'utf8')).rows;
const orModels = JSON.parse(fs.readFileSync('c:/Software/conex/docs/model-capability/surveys/openrouter-full-models.json', 'utf8')).data;
const aaDatasets = JSON.parse(fs.readFileSync('c:/Software/conex/docs/model-capability/surveys/artificial-analysis-data.json', 'utf8')).datasets;

console.log(`Loaded: ModelCompare(${mcModels.length}), Arena(${arenaRows.length}), OpenRouter(${orModels.length}), AA(${aaDatasets.length} datasets)`);

// 提取 AA 智力指数
const aaMap = {};
for (const ds of aaDatasets) {
  if (ds.name && ds.name.includes('Intelligence Index') && Array.isArray(ds.data)) {
    for (const item of ds.data) {
      if (item.label && item.intelligenceIndex) {
        aaMap[item.label.toLowerCase()] = item.intelligenceIndex;
      }
    }
  }
}

// 提取 Arena 排名
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

// 统计 OpenRouter 中 2025-06-01 之后的所有模型 (CUTOFF = 1748736000)
const CUTOFF = 1748736000;
const orPost202506 = orModels.filter(m => m.created && m.created >= CUTOFF);

console.log(`OpenRouter models post 2025-06: ${orPost202506.length}`);

// 按厂商汇总全部模型
const vendorCatalog = {};

// 先填入 OpenRouter 确切发布时间的模型
for (const m of orPost202506) {
  if (m.id.includes(':batch') || m.id.includes(':free')) continue;
  const vendor = m.id.split('/')[0].replace('~', '');
  vendorCatalog[vendor] = vendorCatalog[vendor] || [];
  
  const exactDate = new Date(m.created * 1000).toISOString().split('T')[0];
  const p = m.pricing || {};
  const prompt = p.prompt ? (parseFloat(p.prompt) * 1000000).toFixed(3).replace(/\.?0+$/, '') : '0';
  const comp = p.completion ? (parseFloat(p.completion) * 1000000).toFixed(3).replace(/\.?0+$/, '') : '0';
  const cRead = p.input_cache_read ? (parseFloat(p.input_cache_read) * 1000000).toFixed(3).replace(/\.?0+$/, '') : 'null';
  const cWrite = p.input_cache_write ? (parseFloat(p.input_cache_write) * 1000000).toFixed(3).replace(/\.?0+$/, '') : 'null';
  const efforts = m.reasoning?.supported_efforts ? m.reasoning.supported_efforts.join(', ') : 'null';

  // 尝试匹配 AA 分数
  let aaScore = null;
  for (const [k, v] of Object.entries(aaMap)) {
    if (m.name.toLowerCase().includes(k) || k.includes(m.name.toLowerCase()) || m.id.toLowerCase().includes(k)) {
      aaScore = v;
      break;
    }
  }

  // 尝试匹配 Arena 排名
  let arenaInfo = null;
  for (const [k, v] of Object.entries(arenaMap)) {
    const rawId = m.id.split('/')[1] || m.id;
    if (k.includes(rawId.toLowerCase()) || rawId.toLowerCase().includes(k)) {
      arenaInfo = v;
      break;
    }
  }

  vendorCatalog[vendor].push({
    source: 'OpenRouter API (Verified Timestamp)',
    id: m.id,
    name: m.name,
    exactDate,
    created: m.created,
    context: m.context_length ? m.context_length.toLocaleString() : 'null',
    maxOutput: m.top_provider?.max_completion_tokens ? m.top_provider.max_completion_tokens.toLocaleString() : 'null',
    prices: {
      prompt: '$' + prompt,
      comp: '$' + comp,
      cRead: cRead !== 'null' ? '$' + cRead : 'null',
      cWrite: cWrite !== 'null' ? '$' + cWrite : 'null'
    },
    reasoning: efforts,
    aaScore,
    arenaRank: arenaInfo?.overall || 'null',
    arenaCoding: arenaInfo?.coding || 'null'
  });
}

// 补充 ModelCompare 独有但知名的厂商和现代模型（如 SenseNova, StepFun, Baidu 等）
const extraKnownVendors = ['sensenova', 'baidu', 'StepFun', 'NVIDIA', 'Mistral', 'Cohere', 'xiaomi'];
for (const m of mcModels) {
  const v = m.vendor;
  if (!extraKnownVendors.includes(v)) continue;
  
  // 检查是否已经在 catalog 中
  const exists = Object.values(vendorCatalog).flat().some(item => item.id.includes(m.canonicalId) || item.name.includes(m.displayName));
  if (!exists) {
    const normV = v.toLowerCase().replace(/[\s\.\(\)\/]/g, '-');
    vendorCatalog[normV] = vendorCatalog[normV] || [];
    vendorCatalog[normV].push({
      source: 'ModelCompare (Canonical)',
      id: m.canonicalId,
      name: m.displayName,
      exactDate: '多源收录 (通过 ModelCompare)',
      created: 0,
      context: m.context,
      maxOutput: 'null',
      prices: {
        prompt: m.inputPrice,
        comp: m.outputPrice,
        cRead: 'null',
        cWrite: 'null'
      },
      reasoning: '根据平台标注判定',
      aaScore: null,
      arenaRank: 'null',
      arenaCoding: 'null'
    });
  }
}

// 写入全景聚合 JSON
fs.writeFileSync('c:/Software/conex/docs/model-capability/surveys/comprehensive-aggregated-models.json', JSON.stringify(vendorCatalog, null, 2), 'utf8');

console.log('Saved comprehensive-aggregated-models.json with vendors count:', Object.keys(vendorCatalog).length);

// 统计各厂商模型总数
for (const v in vendorCatalog) {
  console.log(`Vendor [${v}]: ${vendorCatalog[v].length} models`);
}
