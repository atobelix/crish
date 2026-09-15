#!/usr/bin/env node
/**
 * scripts/check-model-config-ssot.mjs
 *
 * 「思考档位 = 封闭词表（权威 = 内核）+ 每模型可配置」战役的**总门禁**。
 *
 * 设计依据：
 *   - docs/model-config-ssot-convergence/plans/09-思考档位统一入口设计修正.md §1.3 / §9 / §10
 *   - docs/model-config-ssot-convergence/plans/08-防回归门禁与负向断言.md §2
 *
 * 本脚本聚合本战役的负向断言，并**委派**两条独立门禁：
 *   1) 词表唯一权威：生产代码中 `THINKING_LEVEL_IDS` 出现次数 = 0
 *   2) 词表外键零容忍：字典数据所有 `thinking` 键落在内核接受集内
 *   3) 委派 scripts/check-thinking-vocabulary-ssot.mjs（前端镜像 ≡ 内核词表）
 *   4) 委派 scripts/check-source-assets-tracked.mjs（源码 import 的 .json 必须入库）
 *
 * 用法：node scripts/check-model-config-ssot.mjs [--guide <metric>]
 * 退出码：0 全部通过；1 任一断言失败（含子门禁未就绪 / 子门禁失败）。
 *
 * 纯 Node ESM，无第三方依赖。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

/** 词表外键零容忍：内核 from_title_case 接受集（crates/agent-provider/src/request/vendor/dialect.rs:63-74） */
const THINKING_ACCEPT = new Set([
  'Off', 'off',
  'None', 'none',
  'Disabled', 'disabled',
  'Minimal', 'minimal',
  'Low', 'low',
  'Medium', 'medium',
  'High', 'high',
  'XHigh', 'xhigh',
  'X-High', 'x-high',
  'Max', 'max',
]);

const DATA_FILE_REL = 'apps/crish-desktop/src/services/modelsAutofillBaselineData.json';
const DELEGATES = [
  { script: 'scripts/check-thinking-vocabulary-ssot.mjs', title: '前端词表镜像 ≡ 内核词表' },
  { script: 'scripts/check-source-assets-tracked.mjs', title: '源码 import 的 .json 已入库' },
];

const SOURCE_EXTS = /\.(ts|tsx|mts|cts)$/;
const TEST_RE = /\.(test|spec)\./;

// ───────────────────────────── 工具 ─────────────────────────────

function toPosix(p) {
  return p.split(path.sep).join('/');
}

/** 递归收集源码文件（排除 node_modules / dist / 测试文件）。 */
function collectSourceFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      collectSourceFiles(full, out);
    } else if (SOURCE_EXTS.test(entry.name) && !TEST_RE.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 注释行判定口径（用于「词表唯一权威」断言）：
 *   1. trim 后以 `*` / `//` / `/*` 开头 → 整行视为注释，跳过；
 *   2. 否则剥离行尾 `//` 注释（`//` 前一个字符非 `:`，避免误伤 `https://`）后再检测。
 * 说明：不处理块注释跨行的中间行（那些行通常以 `*` 开头，已被规则 1 覆盖）。
 */
function stripCommentLine(rawLine) {
  const trimmed = rawLine.trim();
  if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return null;
  return rawLine.replace(/(^|[^:])\/\/.*$/, '$1');
}

function lineOf(bufferLines, re, usedIdx, startAt = 0) {
  for (let i = startAt; i < bufferLines.length; i++) {
    if (usedIdx.has(i)) continue;
    if (re.test(bufferLines[i])) {
      usedIdx.add(i);
      return i + 1;
    }
  }
  return null;
}

// ───────────────────────────── 断言 1：词表唯一权威 ─────────────────────────────

function checkVocabularyUniqueness() {
  const roots = [path.join(REPO_ROOT, 'apps', 'crish-desktop', 'src')];
  const packagesDir = path.join(REPO_ROOT, 'packages');
  if (fs.existsSync(packagesDir)) {
    for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(path.join(packagesDir, entry.name, 'src'));
    }
  }

  const hits = [];
  for (const root of roots) {
    for (const file of collectSourceFiles(root)) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        const code = stripCommentLine(line);
        if (code && code.includes('THINKING_LEVEL_IDS')) {
          hits.push({ file: toPosix(path.relative(REPO_ROOT, file)), line: i + 1 });
        }
      });
    }
  }

  return {
    name: '词表唯一权威（生产代码 THINKING_LEVEL_IDS = 0）',
    ok: hits.length === 0,
    detail: hits.length
      ? hits.map((h) => `${h.file}:${h.line}  出现 THINKING_LEVEL_IDS（词表唯一权威 = 内核，前端不得自造第二份清单）`)
      : ['生产代码（排除 *.test.*）非注释行中 THINKING_LEVEL_IDS 出现 0 次'],
    fix: '删除该符号；档位语言只经内核 from_title_case/to_title_case 与前端唯一镜像常量（THINKING_LEVELS）表达。',
  };
}

// ───────────────────────────── 断言 2：词表外键零容忍 ─────────────────────────────

function checkThinkingKeysInVocabulary() {
  const abs = path.join(REPO_ROOT, DATA_FILE_REL);
  if (!fs.existsSync(abs)) {
    return {
      name: '词表外键零容忍（字典 thinking 键 ⊆ 内核接受集）',
      ok: false,
      detail: [`数据文件不存在：${DATA_FILE_REL}`],
      fix: `确认 ${DATA_FILE_REL} 存在且被 git 跟踪。`,
    };
  }

  const raw = fs.readFileSync(abs, 'utf8');
  const bufferLines = raw.split(/\r?\n/);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      name: '词表外键零容忍（字典 thinking 键 ⊆ 内核接受集）',
      ok: false,
      detail: [`${DATA_FILE_REL} 不是合法 JSON：${err.message}`],
      fix: '修复 JSON 语法。',
    };
  }

  const violations = [];
  let totalKeys = 0;

  const walk = (node, trail) => {
    if (!node || typeof node !== 'object') return;
    if (node.thinking && typeof node.thinking === 'object' && !Array.isArray(node.thinking)) {
      for (const key of Object.keys(node.thinking)) {
        totalKeys++;
        if (!THINKING_ACCEPT.has(key)) {
          violations.push({ path: trail || '(root)', key });
        }
      }
    }
    for (const [k, v] of Object.entries(node)) walk(v, trail ? `${trail}/${k}` : k);
  };
  walk(parsed, '');

  const usedIdx = new Set();
  const detail = violations.map((v) => {
    const line = lineOf(bufferLines, new RegExp(`"${v.key.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}"\\s*:`), usedIdx);
    const loc = line ? `${DATA_FILE_REL}:${line}` : DATA_FILE_REL;
    return `${loc}  词表外键 "${v.key}"（模型 ${v.path}）不受支持；可用集合：Off / Minimal / Low / Medium / High / XHigh / Max（含别名 None/Disabled/X-High 与大小写变体）`;
  });

  return {
    name: '词表外键零容忍（字典 thinking 键 ⊆ 内核接受集）',
    ok: violations.length === 0,
    detail: violations.length
      ? detail
      : [`${DATA_FILE_REL} 共 ${totalKeys} 个 thinking 键，全部落在内核接受集内`],
    fix: `把越界键改为规范拼写（最常见：Xhigh → XHigh），见 ${DATA_FILE_REL}。`,
  };
}

// ───────────────────────────── 断言 3/4：委派子门禁 ─────────────────────────────

function runDelegate({ script, title }) {
  const abs = path.join(REPO_ROOT, script);
  const name = `委派：${title}（${script}）`;
  if (!fs.existsSync(abs)) {
    return {
      name,
      ok: false,
      detail: [`子门禁脚本尚未就绪：${script} 不存在（应由并行 Agent 创建）`],
      fix: `等待 ${script} 落地后重跑；本聚合门禁在子门禁缺失时明确失败，不静默放过。`,
    };
  }
  const res = spawnSync(process.execPath, [abs], { cwd: REPO_ROOT, encoding: 'utf8' });
  const out = `${res.stdout || ''}${res.stderr || ''}`.trimEnd();
  if (res.status === 0) {
    return { name, ok: true, detail: out ? out.split(/\r?\n/).map((l) => `    ${l}`) : ['子门禁通过'] };
  }
  return {
    name,
    ok: false,
    detail: [`子门禁退出码 ${res.status ?? '(signal ' + res.signal + ')'}`, ...(out ? out.split(/\r?\n/).map((l) => `    ${l}`) : [])],
    fix: `先单独修复 ${script} 报告的违规，再重跑本门禁。`,
  };
}

// ───────────────────────────── 正确做法指引（--guide） ─────────────────────────────
// 增量契约：仅在显式 `--guide` 时生效并立即退出，不触碰任何断言、委派与普通运行退出码。
// 指标名 = 本脚本真实的断言标识（FAIL 输出 / 源码中实际使用的符号与子门禁名）：
//   THINKING_LEVEL_IDS · THINKING_ACCEPT · check-thinking-vocabulary-ssot · check-source-assets-tracked
const GUIDE_TEXT = {
  THINKING_LEVEL_IDS: [
    '违反项：生产代码非注释行出现符号 THINKING_LEVEL_IDS（本脚本断言 1「词表唯一权威」）。',
    '文件:行号：门禁 FAIL 明细逐条打印 `<file>:<line>  出现 THINKING_LEVEL_IDS`，直接照该行定位。',
    '扫描范围：apps/crish-desktop/src 与 packages/*/src，排除 *.test.* / *.spec.*；整行注释与行尾 // 注释不计数。',
    '当前值/阈值：命中数必须 = 0（零容忍，不读基线）。',
    '正确做法：',
    '  ① 删除该符号与其自造清单定义；档位语言只经内核 crates/agent-provider/src/request/vendor/dialect.rs:36-47 的',
    '     from_title_case / to_title_case，以及前端唯一镜像常量 THINKING_VOCABULARY',
    '     （apps/crish-desktop/src/api/modelsNormalize.ts:86；门禁既有提示文案称其为 THINKING_LEVELS）；',
    '  ② 确需扩展词表 → 四处同改：① ThinkingIntensity/ReasoningEffort 枚举 ② from_title_case + to_title_case',
    '     ③ vendor_wire 强度刻度 ④ 前端镜像常量；不允许只改 yaml 或只改前端；',
    '  ③ 复现：node scripts/check-model-config-ssot.mjs。',
    '参考：docs/model-config-ssot-convergence/plans/09-思考档位统一入口设计修正.md §2.2「词表扩展契约」。',
  ],
  THINKING_ACCEPT: [
    '违反项：字典数据里的 thinking 键落在内核接受集之外（本脚本断言 2「词表外键零容忍」，判定常量 THINKING_ACCEPT）。',
    '文件:行号：门禁 FAIL 明细逐条打印 `<DATA_FILE_REL>:<line>  词表外键 "<key>"（模型 <path>）不受支持`。',
    `数据文件：${DATA_FILE_REL}（模型路径 <path> 形如 providers/<id>/models/<model>）。`,
    '当前值/阈值：越界键数必须 = 0。接受集 = 内核 from_title_case，权威定义',
    '  crates/agent-provider/src/request/vendor/dialect.rs:63-74：Off / Minimal / Low / Medium / High / XHigh / Max',
    '  （含别名 None / Disabled / X-High 与大小写变体）。',
    '正确做法：',
    '  ① 把越界键改写为规范拼写 —— 最常见的是 `"Xhigh"` → `"XHigh"`（大小写敏感）；',
    '  ② 复现并只看这一项：node scripts/check-model-config-ssot.mjs，读输出中「词表外键零容忍」段落；',
    '  ③ 改完确认该 json 仍被 git 跟踪（由子门禁 check-source-assets-tracked 守护，见其 --guide）；',
    '  ④ 禁止「在前端补别名」绕过 —— 接受集唯一权威在内核，前端不得扩展词表。',
    '参考：docs/model-config-ssot-convergence/plans/03-字典越界清除与热路径fail-closed.md、plans/09 §1.2。',
  ],
  'check-thinking-vocabulary-ssot': [
    '违反项：委派子门禁 1 失败 —— 前端镜像词表 ≠ 内核词表（规范拼写集合或顺序不一致），或子门禁脚本不存在。',
    '文件:行号：内核真源 crates/agent-provider/src/request/vendor/dialect.rs；前端镜像 apps/crish-desktop/src/api/modelsNormalize.ts:86 THINKING_VOCABULARY。',
    '当前值/阈值：两侧规范拼写集合与顺序必须完全一致（7 档：Off / Minimal / Low / Medium / High / XHigh / Max）。',
    '正确做法（先跑子门禁，看它的差异输出）：',
    '  ① 单独运行：node scripts/check-thinking-vocabulary-ssot.mjs  → 它逐条打印哪一档多了 / 少了 / 顺序不同；',
    '  ② 按差异修正，但**禁止手改前端镜像顺序**：改词表须四处同改（枚举 / from_title_case + to_title_case',
    '     / vendor_wire 强度刻度 / 前端镜像常量），见 plans/09 §2.2「词表扩展契约」；',
    '  ③ 若子门禁报「读取失败」→ 检查上述两个文件是否存在于该路径（缺文件即 exit 1）；',
    '  ④ 修完复跑聚合门禁：node scripts/check-model-config-ssot.mjs。',
    '参考：docs/model-config-ssot-convergence/plans/09-思考档位统一入口设计修正.md §2.2；本脚本 DELEGATES 第 1 项。',
  ],
  'check-source-assets-tracked': [
    '违反项：委派子门禁 2 失败 —— 源码 `import` 的相对路径 .json 未被 git 跟踪（他人 clone / CI checkout 后断裂），',
    '  或子门禁脚本不存在。',
    '文件:行号：子门禁输出逐条给出「<json 路径> ← <引用点 file:line>」；本战役实例为',
    `  ${DATA_FILE_REL} ← apps/crish-desktop/src/services/modelsAutofillBaseline.ts:19。`,
    '当前值/阈值：未跟踪的 json 数必须 = 0。注意「import 指向的 .json 不存在」是**告警**（import 断裂），不计入未入库判定。',
    '正确做法（先跑子门禁，看它的清单输出）：',
    '  ① 单独运行：node scripts/check-source-assets-tracked.mjs --list  → 打印全部「源码 → json」引用清单，',
    '     确认到底哪一条未跟踪；',
    '  ② 优先修法：在 .gitignore 追加目录级放行 `!apps/**/src/**/*.json`、`!packages/**/src/**/*.json`；',
    '     若该 json 确属临时/生成物 → 改为运行时生成，不要用静态 import 引用；',
    '  ③ 验证：git ls-files --error-unmatch <file> 应命中；git status 应能看到该文件；',
    '  ④ 修完复跑聚合门禁：node scripts/check-model-config-ssot.mjs。',
    '参考：docs/model-config-ssot-convergence/plans/09-思考档位统一入口设计修正.md §5.4、docs/model-config-ssot-convergence/00-兼容清册.md F 节。',
  ],
};

function printGuide(metric) {
  const g = GUIDE_TEXT[metric];
  if (!g) {
    console.error(`[check-model-config-ssot] 未知指标：${metric ?? '(未提供)'}`);
    console.error(`可用：${Object.keys(GUIDE_TEXT).join(', ')}`);
    console.error('  用法：node scripts/check-model-config-ssot.mjs --guide <metric>');
    process.exit(1);
  }
  console.log(`[check-model-config-ssot] 正确做法 · ${metric}\n`);
  for (const l of g) console.log(`  ${l}`);
  process.exit(0);
}

const guideRequested = process.argv.includes('--guide');
if (guideRequested) {
  const idx = process.argv.indexOf('--guide');
  printGuide(process.argv[idx + 1] ?? null);
}

// ───────────────────────────── 主流程 ─────────────────────────────

const assertions = [
  checkVocabularyUniqueness(),
  checkThinkingKeysInVocabulary(),
  ...DELEGATES.map(runDelegate),
];

const failed = assertions.filter((a) => !a.ok);

console.log('=== 模型配置 SSOT 总门禁（check-model-config-ssot）===\n');
for (const a of assertions) {
  console.log(`${a.ok ? '✅ 通过' : '❌ 失败'}  ${a.name}`);
  for (const d of a.detail) console.log(`    - ${d}`);
  if (!a.ok && a.fix) console.log(`    ↳ 修复提示：${a.fix}`);
  console.log('');
}

if (failed.length) {
  console.error(`❌ 总门禁失败：${failed.length}/${assertions.length} 项未通过。`);
  console.error('   运行 `node scripts/check-model-config-ssot.mjs` 复现，按上方「修复提示」逐项收敛。');
  process.exit(1);
}

console.log(`✅ 总门禁通过：${assertions.length}/${assertions.length} 项全部通过。`);
