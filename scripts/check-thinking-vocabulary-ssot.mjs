#!/usr/bin/env node
/**
 * scripts/check-thinking-vocabulary-ssot.mjs
 *
 * 思考档位词表 SSOT 门禁：
 *   内核真源 = crates/agent-provider/src/request/vendor/dialect.rs
 *              （`ReasoningEffort::from_title_case` 的 match 分支 +
 *                `to_title_case` 的返回字面量）
 *   前端镜像 = apps/crish-desktop/src/api/modelsNormalize.ts 的 THINKING_VOCABULARY
 *
 * 断言：前端镜像的**规范拼写集合与顺序** ≡ 内核词表（强度序）。
 *   - 规范拼写 = 每个 from_title_case match 分支的**首个字面量**（TitleCase）。
 *   - to_title_case 的返回字面量必须经同一别名接受集归一到对应档位（顺序一致），
 *     容忍内核历史拼写别名（如 X-High）而仍锁定「一处规范拼写」。
 * 不一致 → 非零退出并打印差异。
 *
 * Run: node scripts/check-thinking-vocabulary-ssot.mjs [--guide <metric>]
 *
 * 纯 node，无第三方依赖。禁手改前端镜像顺序；扩展词表须五处同改（plans/09 §2.2）。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const DIALECT_RS = path.resolve(
  REPO_ROOT,
  'crates/agent-provider/src/request/vendor/dialect.rs'
);
const MIRROR_TS = path.resolve(
  REPO_ROOT,
  'apps/crish-desktop/src/api/modelsNormalize.ts'
);

// ───────────────────── 正确做法指引（--guide） ─────────────────────
// 增量契约：仅在显式 `--guide <metric>` 时生效并立即退出；
// 不触碰任何断言、判定分支与「普通运行」的退出码。
// 指标名 = 本脚本真实的判定标识（内部判定字段 / FAIL 输出中出现的符号）：
//   from_title_case · to_title_case · THINKING_VOCABULARY · kernelCanonical · aliasToCanonical
const GUIDE_INDEX = process.argv.indexOf('--guide');

const GUIDE_TEXT = {
  from_title_case: [
    '违反项：内核真源 dialect.rs 的 from_title_case match 分支无法解析（FAIL：「无法从 dialect.rs 解析 from_title_case match 分支」）。',
    '文件:行号：crates/agent-provider/src/request/vendor/dialect.rs:65-77（pub fn from_title_case 的 match 块）。',
    '当前值/阈值：解析到的分支数必须 >= 1，且 = to_title_case 返回项数 = 前端镜像档位数（当前 7 档：Off/Minimal/Low/Medium/High/XHigh/Max）。',
    '解析口径：每个分支的**首个字面量**即规范拼写（TitleCase），其后的字面量是读边界别名（如 X-High / x-high）。',
    '正确做法（修复破坏解析的写法）：',
    '  ① 分支必须保持单行形态 `"A" | "B" => Some(Self::X),`；改成 if/else、把 `|` 折行、或返回非 Some(Self::..) 都会让解析器取不到分支；',
    '  ② 需要新增档位 → 四处同改：① ReasoningEffort 枚举 ② from_title_case + to_title_case ③ vendor_wire 强度刻度 ④ 前端镜像常量 THINKING_VOCABULARY；不允许只改 yaml 或只改前端；',
    '  ③ 复现：node scripts/check-thinking-vocabulary-ssot.mjs。',
    '参考：docs/model-config-ssot-convergence/plans/09-思考档位统一入口设计修正.md §2.2「词表扩展契约」（第 110 行）。',
  ],
  to_title_case: [
    '违反项：内核 to_title_case 的返回字面量无法解析（FAIL：「无法从 dialect.rs 解析 to_title_case 返回字面量」）。',
    '文件:行号：crates/agent-provider/src/request/vendor/dialect.rs:79-91（pub fn to_title_case）。',
    '当前值/阈值：解析到的返回项数必须 = from_title_case 分支数 = 前端镜像档位数（当前 7）。',
    '解析口径：只识别 `Self::<Variant> => "<字面量>",` 逐行形态；写成 `=> { ... }`、`=> "X".to_string()`、或返回非字面量表达式都会解析失败。',
    '正确做法：',
    '  ① 保持 `Self::X => "规范拼写",` 形态，一字面量一行；',
    '  ② 返回的拼写必须落在 from_title_case 的接受集内，且按强度序与镜像逐项对齐（见 aliasToCanonical 指引）；',
    '  ③ 复现：node scripts/check-thinking-vocabulary-ssot.mjs。',
    '参考：docs/model-config-ssot-convergence/plans/09-思考档位统一入口设计修正.md §2.2（第 110 行）。',
  ],
  THINKING_VOCABULARY: [
    '违反项：前端镜像常量无法解析（FAIL：「无法从 modelsNormalize.ts 解析 THINKING_VOCABULARY 镜像」）。',
    '文件:行号：apps/crish-desktop/src/api/modelsNormalize.ts:86-95（export const THINKING_VOCABULARY = [ ... ] as const;）。',
    '当前值/阈值：解析到的字面量数必须 = 内核档位数（当前 7：Off/Minimal/Low/Medium/High/XHigh/Max），且逐项顺序相等。',
    '解析口径：必须保持 `export const THINKING_VOCABULARY = [ ... ] as const;` 这一单一形态；改名、改导出方式、用变量拼接数组都会解析失败。',
    '正确做法：',
    '  ① 禁止手改前端镜像顺序 —— 镜像只是内核词表的投影（modelsNormalize.ts:78 注释即为此约束）；',
    '  ② 需要新增档位 → 四处同改（枚举 / from_title_case + to_title_case / vendor_wire 强度刻度 / 本常量）；',
    '  ③ 不要在别处再建第二份档位清单（词表唯一权威在内核，另由 check-model-config-ssot.mjs 的 THINKING_LEVEL_IDS 断言守护）；',
    '  ④ 复现：node scripts/check-thinking-vocabulary-ssot.mjs。',
    '参考：docs/model-config-ssot-convergence/plans/09-思考档位统一入口设计修正.md §2.2；modelsNormalize.ts:80-82 的镜像注释。',
  ],
  kernelCanonical: [
    '违反项：内核规范拼写集合/顺序 ≠ 前端镜像（本脚本断言 1；FAIL：「档位数不一致：…」或「第 N 档拼写/顺序不一致：…」）。',
    '文件:行号：内核 crates/agent-provider/src/request/vendor/dialect.rs:65-77（kernelCanonical = 各分支首字面量，按源码序）；',
    '          前端 apps/crish-desktop/src/api/modelsNormalize.ts:86-95（THINKING_VOCABULARY）。',
    '当前值/阈值：两侧长度必须相等，且逐项满足 kernelCanonical[i] === frontend[i]（当前 7 档，顺序即强度序 Off < Minimal < Low < Medium < High < XHigh < Max）。',
    '正确做法：',
    '  ① 先跑 `node scripts/check-thinking-vocabulary-ssot.mjs`，FAIL 逐条打印第几档、两侧分别是什么，照该行定位；',
    '  ② 以**内核为唯一权威**修正前端镜像的拼写与位置（不是反过来改内核去迁就前端）；',
    '  ③ 大小写敏感：规范拼写是 `XHigh`，`Xhigh` 不是接受集成员，`X-High` 只是读边界别名；',
    '  ④ 新增档位 → 四处同改，见 plans/09 §2.2。',
    '参考：docs/model-config-ssot-convergence/plans/09-思考档位统一入口设计修正.md §2.2（第 110 行）。',
  ],
  aliasToCanonical: [
    '违反项：to_title_case 返回值经别名接受集归一后，与镜像档位或顺序不一致（本脚本断言 2；',
    '        FAIL：「to_title_case 返回 "X" 不在 from_title_case 接受集内」或「to_title_case 第 N 项 … 归一到 …，与镜像 … 不一致」）。',
    '文件:行号：dialect.rs:79-91（kernelTitleCase 序列）对照 dialect.rs:65-77（aliasToCanonical：别名 → 该分支首字面量）与 modelsNormalize.ts:86-95。',
    '当前值/阈值：to_title_case 项数 = 镜像档位数，且第 i 项经 aliasToCanonical 归一后必须 === frontend[i]（不一致处必须为 0）。',
    '正确做法：',
    '  ① 报「不在接受集内」→ to_title_case 输出了 from_title_case 未接受的拼写（例：返回 "Xhigh"，而接受集只有 XHigh/xhigh/X-High/x-high）：',
    '     把它改为规范拼写 `Self::XHigh => "XHigh",`；',
    '  ② 报「归一到 X 与镜像 Y 不一致」→ 顺序错位：按强度序重排 to_title_case 的 match 分支（Off → Minimal → Low → Medium → High → XHigh → Max）；',
    '  ③ 纪律：别名只在 from_title_case 的**读边界**接受，to_title_case 必须输出规范拼写、不得输出别名；',
    '  ④ 复现：node scripts/check-thinking-vocabulary-ssot.mjs。',
    '参考：docs/model-config-ssot-convergence/plans/09-思考档位统一入口设计修正.md §2.2（第 110 行）。',
  ],
};

function printGuide(metric) {
  const g = GUIDE_TEXT[metric];
  if (!g) {
    console.error(`[check-thinking-vocabulary-ssot] 未知指标：${metric ?? '(未提供)'}`);
    console.error(`可用：${Object.keys(GUIDE_TEXT).join(', ')}`);
    console.error('  用法：node scripts/check-thinking-vocabulary-ssot.mjs --guide <metric>');
    process.exit(1);
  }
  console.log(`[check-thinking-vocabulary-ssot] 正确做法 · ${metric}\n`);
  for (const l of g) console.log(`  ${l}`);
  process.exit(0);
}

if (GUIDE_INDEX >= 0) printGuide(process.argv[GUIDE_INDEX + 1]);

const errors = [];

function readOrDie(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    errors.push(`读取失败：${path.relative(REPO_ROOT, file)}（${e.message}）`);
    return '';
  }
}

const dialect = readOrDie(DIALECT_RS);
const mirror = readOrDie(MIRROR_TS);

if (errors.length) {
  console.error('❌ 思考档位词表 SSOT 门禁失败 (check-thinking-vocabulary-ssot)\n');
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}

/** 提取内核 from_title_case 的 match 分支：每个分支的字面量数组（按源码序）。 */
function parseKernelArms(src) {
  const start = src.indexOf('pub fn from_title_case');
  const end = src.indexOf('pub fn to_title_case');
  if (start < 0 || end < 0 || end <= start) return null;
  const block = src.slice(start, end);
  const arms = [];
  for (const line of block.split('\n')) {
    // 形如：  "Off" | "off" | "None" | ... => Some(Self::Off),
    const m = line.match(/^\s*((?:"[^"]*"\s*\|\s*)*"[^"]*")\s*=>/);
    if (!m) continue;
    arms.push([...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]));
  }
  return arms.length ? arms : null;
}

/** 提取内核 to_title_case 的返回字面量（按源码序）。 */
function parseKernelTitleCase(src) {
  const start = src.indexOf('pub fn to_title_case');
  const end = src.indexOf('pub fn as_str', start);
  if (start < 0 || end < 0 || end <= start) return null;
  const block = src.slice(start, end);
  const out = [];
  for (const line of block.split('\n')) {
    // 形如：  Self::Off => "Off",
    const m = line.match(/^\s*Self::\w+\s*=>\s*"([^"]*)",/);
    if (m) out.push(m[1]);
  }
  return out.length ? out : null;
}

/** 提取前端镜像 THINKING_VOCABULARY 的字面量数组（按书写序）。 */
function parseMirror(src) {
  const m = src.match(
    /export const THINKING_VOCABULARY\s*=\s*\[([\s\S]*?)\]\s*as const;/
  );
  if (!m) return null;
  const out = [...m[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map(
    (x) => x[1] ?? x[2]
  );
  return out.length ? out : null;
}

const arms = parseKernelArms(dialect);
const kernelTitleCase = parseKernelTitleCase(dialect);
const frontend = parseMirror(mirror);

if (!arms) {
  errors.push('无法从 dialect.rs 解析 from_title_case match 分支');
}
if (!kernelTitleCase) {
  errors.push('无法从 dialect.rs 解析 to_title_case 返回字面量');
}
if (!frontend) {
  errors.push('无法从 modelsNormalize.ts 解析 THINKING_VOCABULARY 镜像');
}

if (errors.length) {
  console.error('❌ 思考档位词表 SSOT 门禁失败 (check-thinking-vocabulary-ssot)\n');
  for (const e of errors) console.error('  - ' + e);
  console.error('\n请检查真源 dialect.rs 与镜像 modelsNormalize.ts 是否可解析。');
  process.exit(1);
}

// 别名接受集：读边界拼写 → 规范档位（每个分支首字面量）
const aliasToCanonical = new Map();
const kernelCanonical = [];
for (const literals of arms) {
  const canonical = literals[0];
  kernelCanonical.push(canonical);
  for (const lit of literals) aliasToCanonical.set(lit, canonical);
}

const fmt = (arr) => arr.map((s) => JSON.stringify(s)).join(', ');

// 断言 1：规范拼写集合与顺序（内核首字面量 ≡ 前端镜像）
if (kernelCanonical.length !== frontend.length) {
  errors.push(
    `档位数不一致：内核 ${kernelCanonical.length} 档 [${fmt(
      kernelCanonical
    )}]，前端镜像 ${frontend.length} 档 [${fmt(frontend)}]`
  );
} else {
  for (let i = 0; i < frontend.length; i += 1) {
    if (kernelCanonical[i] !== frontend[i]) {
      errors.push(
        `第 ${i + 1} 档拼写/顺序不一致：内核 ${JSON.stringify(
          kernelCanonical[i]
        )}，前端镜像 ${JSON.stringify(frontend[i])}`
      );
    }
  }
}

// 断言 2：to_title_case 返回字面量经别名归一后必须归属同一档位且顺序一致
if (kernelTitleCase.length !== frontend.length) {
  errors.push(
    `to_title_case 返回 ${kernelTitleCase.length} 项，与词表 ${frontend.length} 档不一致`
  );
} else {
  for (let i = 0; i < kernelTitleCase.length; i += 1) {
    const lit = kernelTitleCase[i];
    const canonical = aliasToCanonical.get(lit);
    if (canonical === undefined) {
      errors.push(
        `to_title_case 返回 ${JSON.stringify(
          lit
        )} 不在 from_title_case 接受集内`
      );
    } else if (canonical !== frontend[i]) {
      errors.push(
        `to_title_case 第 ${i + 1} 项 ${JSON.stringify(
          lit
        )} 归一到 ${JSON.stringify(canonical)}，与镜像 ${JSON.stringify(
          frontend[i]
        )} 不一致`
      );
    }
  }
}

if (errors.length) {
  console.error('❌ 思考档位词表 SSOT 门禁失败 (check-thinking-vocabulary-ssot)\n');
  for (const e of errors) console.error('  - ' + e);
  console.error(
    '\n真源 = 内核 ReasoningEffort（dialect.rs）；镜像 = modelsNormalize.ts 的 THINKING_VOCABULARY。'
  );
  console.error('禁止手改前端镜像顺序；扩展词表须五处同改（plans/09 §2.2）。');
  process.exit(1);
}

console.log(
  `✅ 思考档位词表 SSOT 门禁通过（内核 ≡ 前端镜像，${frontend.length} 档：${frontend.join(
    ' / '
  )}）`
);
