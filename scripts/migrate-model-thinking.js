/**
 * scripts/migrate-model-thinking.js
 * 模型能力单源战役（v2）：把 MODEL_SERIES_CAPABILITIES 猜测表知识迁移进
 * catalog.json 条目数据（thinkingTiers / thinkingFormat / thinkingBudgetDefault）。
 *
 * 语义（对齐 crates/agent-provider/src/request/vendor_capability.rs 退役前口径）：
 * - 最长前缀命中；未命中 → NO_THINKING（不写思考字段）；
 * - thinkingTiers：档位 → wire 拼写（同规范名；adaptive 系含 max/xhigh）；
 * - thinkingFormat：ReasoningFormat 变体字符串（
 *   reasoning_effort | thinking_budget | thinking_adaptive | thinking_level | none）；
 * - thinkingBudgetDefault：Anthropic 系档位默认预算（medium 档 2048；
 *   adaptive 系 thinking_budget 不适用 → 不写）。
 *
 * 幂等：重复运行以同源前缀表重算，仅覆盖匹配条目的 thinking* 字段，其余字段不动。
 *
 * 用法：node scripts/migrate-model-thinking.js
 */
const fs = require('fs');
const path = require('path');

const CATALOG_PATH = path.resolve(__dirname, '../crates/agent-provider/src/models/catalog.json');

// ── 猜测表知识（v2 迁移源；退役后此处与 Rust 表同源冻结） ────────────────
// 每条：[前缀, format, [档位...]]
const SERIES = [
  // OpenAI
  ['gpt-5.', 'reasoning_effort', ['minimal', 'low', 'medium', 'high']],
  ['gpt-5', 'reasoning_effort', ['minimal', 'low', 'medium', 'high']],
  ['o4-', 'reasoning_effort', ['minimal', 'low', 'medium', 'high']],
  ['o3-', 'reasoning_effort', ['minimal', 'low', 'medium', 'high']],
  ['o3', 'reasoning_effort', ['minimal', 'low', 'medium', 'high']],
  ['o1-', 'reasoning_effort', ['low', 'medium', 'high']],
  ['o1', 'reasoning_effort', ['low', 'medium', 'high']],
  // Anthropic 新代际自适应
  ['claude-opus-4-7', 'thinking_adaptive', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-opus-4-8', 'thinking_adaptive', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-opus-5', 'thinking_adaptive', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-sonnet-5', 'thinking_adaptive', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-fable-5', 'thinking_adaptive', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-mythos-5', 'thinking_adaptive', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-4-7', 'thinking_adaptive', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-4-8', 'thinking_adaptive', ['low', 'medium', 'high', 'xhigh', 'max']],
  // Anthropic 旧代际
  ['claude-opus-4', 'thinking_budget', ['minimal', 'low', 'medium', 'high', 'xhigh']],
  ['claude-sonnet-4', 'thinking_budget', ['minimal', 'low', 'medium', 'high', 'xhigh']],
  ['claude-4', 'thinking_budget', ['minimal', 'low', 'medium', 'high', 'xhigh']],
  ['claude-3-7', 'thinking_budget', ['minimal', 'low', 'medium', 'high']],
  // Gemini
  ['gemini-3', 'thinking_level', ['minimal', 'low', 'medium', 'high']],
  ['gemini-2.5', 'thinking_level', ['minimal', 'low', 'medium', 'high']],
  // DeepSeek
  ['deepseek-reasoner', 'reasoning_effort', ['low', 'medium', 'high']],
  ['deepseek-v4', 'reasoning_effort', ['low', 'medium', 'high']],
  ['deepseek-r1', 'reasoning_effort', ['low', 'medium', 'high']],
  // Qwen / GLM / Kimi
  ['qwen3', 'reasoning_effort', ['low', 'medium', 'high']],
  ['qwen-3', 'reasoning_effort', ['low', 'medium', 'high']],
  ['glm-5', 'reasoning_effort', ['low', 'medium', 'high']],
  ['kimi-2.5', 'reasoning_effort', ['low', 'medium', 'high']],
];

/** 最长前缀命中（对齐 infer_thinking_capability；未命中 → null） */
function matchSeries(model) {
  const lower = String(model || '').toLowerCase();
  let best = null;
  for (const [prefix, format, levels] of SERIES) {
    if (lower.startsWith(prefix) && (!best || prefix.length > best[0].length)) {
      best = [prefix, format, levels];
    }
  }
  return best;
}

/** Anthropic thinking_budget 默认预算（medium 档） */
const BUDGET_DEFAULT = 2048;

function main() {
  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const entries = catalog.entries || {};
  let updated = 0;
  let untouched = 0;

  for (const key of Object.keys(entries)) {
    const entry = entries[key];
    const hit = matchSeries(entry.model || key.split('::')[1] || '');
    if (!hit) {
      // 未命中 → 不写思考字段（保守默认；保留可能存在的既有 thinking 字段仅当显式）
      untouched++;
      continue;
    }
    const [, format, levels] = hit;
    const tiers = {};
    for (const level of levels) tiers[level] = level;

    entry.thinkingTiers = tiers;
    entry.thinkingFormat = format;
    if (format === 'thinking_budget') {
      entry.thinkingBudgetDefault = BUDGET_DEFAULT;
    } else {
      delete entry.thinkingBudgetDefault;
    }
    updated++;
  }

  fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
  console.log(`[migrate-model-thinking] 更新 ${updated} 条 / 未命中 ${untouched} 条 → ${CATALOG_PATH}`);
}

main();
