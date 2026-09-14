#!/usr/bin/env node
/**
 * scripts/check-provider-single-track.mjs
 *
 * 「供应商配置与请求链单轨收敛」战役防御网（D 线）——从实测缺陷生长：
 *
 *   D5 身份键防线：模型身份键唯一权威 = modelRefKey（JSON 二元组）。
 *     实证缺陷：settingsObjectId 曾用 `${profileId}::${model}` 拼接，与
 *     编辑会话 open/commit 键（modelRefKey）双轨，外部变更失效错位。
 *   D4 夹具防线：测试树夹具（ModelSpec/ProviderSpec 对象）禁止旧契约
 *     字段（capabilities）与明文凭据（apiKey 字面量）。判别特征：与
 *     modalities/protocol 同对象的 capabilities/apiKey 即树夹具（LS meta
 *     形状无 modalities/protocol，不受此限）。
 *   D6 字典防线（字典部分）：退役别名不得回潮（deepseek/deepseek-chat）。
 *
 * 本脚本只断言「缺陷不复发」，不断言期望实现——注入自检见脚本尾部注释。
 *
 * 用法：node scripts/check-provider-single-track.mjs [--guide <metric>]
 * 退出码：0 通过；1 任一断言失败。
 *
 * 纯 Node ESM，无第三方依赖。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const failures = [];
const ok = (message) => console.log(`  ok  ${message}`);
const fail = (message) => {
  failures.push(message);
  console.error(`FAIL  ${message}`);
};

function walk(dir, predicate, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'target' || entry.name === '.git') continue;
      walk(full, predicate, out);
    } else if (predicate(entry.name, full)) {
      out.push(full);
    }
  }
  return out;
}

function read(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

/* ── 正确做法指引（--guide） ──────────────────────────────────── */
// 增量契约：仅在显式 `--guide <metric>` 时生效并立即退出；
// 不触碰任何断言、判定分支与「普通运行」的退出码。
// 指标名 = 本脚本 FAIL 输出中的真实防线标识（D5 / D4 / D6），
// 与 docs/provider-single-track-convergence/02-执行拓扑与防御网方案.md 的 D 线编号一一对应。
const GUIDE_INDEX = process.argv.indexOf('--guide');

const GUIDE_TEXT = {
  D5: [
    '违反项：身份键 `::` 拼接回潮 —— ① settingsObjectId 未委派 modelRefKey；② settingsObjectId 仍含 `${..}::${..}` 模板拼接；③ 生产代码出现未白名单登记的 `::` 拼接键空间（FAIL 前缀 D5）。',
    '文件:行号：FAIL 逐条给出 —— 生产代码扫描打印 `<file>:<line>`；settingsObjectId 检查打印 apps/crish-desktop/src/components/settings-models/modelProfilesHelpers.ts。',
    '当前值/阈值：命中数必须 = 0（D5_WHITELIST 已登记 9 个合法键空间：LS meta / 会话导入源键 / 窗口 scoped LS / 流式批键 / workflow 载荷签名）。',
    '正确做法：',
    '  ① 模型身份键唯一权威 = modelRefKey（JSON 二元组，避免身份含分隔符时碰撞），定义在 apps/crish-desktop/src/api/modelsCatalogTypes.ts:27；',
    '     可复制形态：',
    '       import { modelRefKey } from "<…>/api/modelsCatalogTypes";',
    '       const key = modelRefKey({ providerId, modelId });   // 不要写 `${providerId}::${modelId}`',
    '  ② settingsObjectId 必须委托它，例：export function settingsObjectId(ref: ModelRef) { return modelRefKey(ref); }',
    '  ③ 确属**新键空间**（非模型身份，如会话/批处理键）→ 在本脚本 D5_WHITELIST 追加一行，并说明它与身份键的边界；',
    '  ④ 复现：node scripts/check-provider-single-track.mjs（输出即含 file:line）。',
    '参考：docs/provider-single-track-convergence/02-执行拓扑与防御网方案.md D5 行（第 100 行）。',
  ],
  D4: [
    '违反项：测试树夹具携带旧契约字段或明文凭据（FAIL 前缀 D4）—— ① `capabilities: {` 与 `modalities:` 同对象（8 行窗口）；② `apiKey: "<非空字面量>"` 与 `protocol:` 同对象（窗口含 hasKey: 的 LS 凭据壳不判定）。',
    '文件:行号：FAIL 逐条给出 `<file>:<line>`；扫描 apps/crish-desktop/src 下 *.test.ts(x)，其中 apiKey 规则只对含 workbench_read_models_yaml 的 mock 文件生效。',
    '当前值/阈值：命中数必须 = 0。',
    '正确做法：',
    '  ① 删除 capabilities，能力信息写入替代真源 supportsTools / modalities / thinking（三者即能力唯一真源）；',
    '  ② 明文 apiKey 改为 apiKeyRef + credentialStates（hasKey 壳）；明文只允许存在于 LS 凭据壳形状或显式负向断言中；',
    '  ③ 测试夹具请用统一 mock 工厂构造完整回执树（tree + revision + credentialStates），不要手写字面量对象；',
    '  ④ 复现：node scripts/check-provider-single-track.mjs。',
    '参考：docs/provider-single-track-convergence/02-执行拓扑与防御网方案.md D4 行（第 99 行）。',
  ],
  D6: [
    '违反项：基线字典回潮退役别名（FAIL 前缀 D6）。',
    '文件:行号：apps/crish-desktop/src/services/modelsAutofillBaselineData.json（命中的别名名由 FAIL 输出给出）。',
    '当前值/阈值：本脚本 `retired` 清单命中数必须 = 0；当前清单：deepseek/deepseek-chat。',
    '正确做法：',
    '  ① 从该 json 中删除对应条目（形如 `"id": "deepseek/deepseek-chat"`），退役别名不得再映射窗口 / 能力；',
    '  ② 不要用模糊匹配「绕过」—— 退役别名复活会污染 contextLength 推断（曾误配 128000）；',
    '  ③ 确需该厂商模型 → 以现行规范 id 新增条目，并保持与内核接受集一致；',
    '  ④ 复现：node scripts/check-provider-single-track.mjs。',
    '参考：docs/provider-single-track-convergence/02-执行拓扑与防御网方案.md D6 行（第 101 行）。',
  ],
};

function printGuide(metric) {
  const g = GUIDE_TEXT[metric];
  if (!g) {
    console.error(`[check-provider-single-track] 未知指标：${metric ?? '(未提供)'}`);
    console.error(`可用：${Object.keys(GUIDE_TEXT).join(', ')}`);
    console.error('  用法：node scripts/check-provider-single-track.mjs --guide <metric>');
    process.exit(1);
  }
  console.log(`[check-provider-single-track] 正确做法 · ${metric}\n`);
  for (const l of g) console.log(`  ${l}`);
  process.exit(0);
}

if (GUIDE_INDEX >= 0) printGuide(process.argv[GUIDE_INDEX + 1]);

/* ── D5 身份键防线 ─────────────────────────────────────────────── */

// 1) settingsObjectId 必须委派 modelRefKey，不得回退 `::` 模板拼接
{
  const rel = 'apps/crish-desktop/src/components/settings-models/modelProfilesHelpers.ts';
  const src = read(rel);
  if (/export function settingsObjectId[^}]*modelRefKey\(/.test(src)) {
    ok('D5: settingsObjectId 委派 modelRefKey（JSON 二元组）');
  } else {
    fail(`D5: ${rel} 的 settingsObjectId 未委派 modelRefKey——身份键双轨回潮`);
  }
  if (/\$\{[^}]+\}::\$\{/.test(src.split('settingsObjectId')[1]?.split('}')[0] ?? '')) {
    fail(`D5: ${rel} settingsObjectId 仍存在 :: 模板拼接`);
  }
}

// 2) 生产代码 `::` 拼接键空间白名单（清单锁定：新键空间必须显式登记并
//    评审其与身份键的边界；未登记命中 = 红）。
const D5_WHITELIST = new Map([
  ['apps/crish-desktop/src/api/modelCatalogMeta.ts', 'LS meta 键空间（profileId::model，localStorage 元数据）'],
  ['apps/crish-desktop/src/api/modelCatalogPure.ts', 'LS meta 键空间（纯函数面）'],
  ['apps/crish-desktop/src/api/modelsLsImport.ts', 'LS meta 读侧（一次性导入边界）'],
  ['apps/crish-desktop/src/api/import/types.ts', '会话导入源键（source::sourceSessionId）'],
  ['apps/crish-desktop/src/api/session-persistence/sessionLocalStorage.ts', '会话导入源键（持久化）'],
  ['apps/crish-desktop/src/api/shellWindowScope.ts', '窗口 scoped localStorage 键'],
  ['apps/crish-desktop/src/api/streamTextBatcher.ts', '流式批键（sessionId::messageId[::toolId]，非模型身份）'],
  ['apps/crish-desktop/src/store/streamingStore.ts', '流式批键镜像（streamBatchKey 同形契约）'],
  ['apps/crish-desktop/src/api/workflow-api/workflowConfirmSignatures.ts', 'workflow 载荷签名（多字段拼接摘要，非身份）'],
]);
{
  const srcDir = path.join(REPO_ROOT, 'apps/crish-desktop/src');
  const files = walk(srcDir, (name) => /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name));
  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file).replaceAll('\\', '/');
    if (D5_WHITELIST.has(rel)) continue;
    const src = fs.readFileSync(file, 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, index) => {
      if (/\$\{[^}]+\}::\$\{/.test(line) && !line.trim().startsWith('*') && !line.trim().startsWith('//')) {
        fail(
          `D5: ${rel}:${index + 1} 出现新的 :: 拼接键空间（未白名单登记）。` +
            ` 模型身份必须用 modelRefKey；确属新键空间请在 check-provider-single-track.mjs 的 D5_WHITELIST 登记并说明与身份键的边界。`
        );
      }
    });
  }
  ok(`D5: 生产代码 :: 拼接键空间白名单核验完成（${D5_WHITELIST.size} 个登记键空间）`);
}

/* ── D4 夹具防线 ─────────────────────────────────────────────── */

const testDirs = ['apps/crish-desktop/src'];
{
  const files = walk(path.join(REPO_ROOT, 'apps/crish-desktop/src'), (name) =>
    /\.test\.(ts|tsx)$/.test(name)
  );
  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file).replaceAll('\\', '/');
    const src = fs.readFileSync(file, 'utf8');
    const lines = src.split('\n');

    // 规则 C：capabilities: { 与 modalities: 共现（8 行窗口）→ 树夹具旧字段
    lines.forEach((line, index) => {
      if (/capabilities:\s*\{/.test(line)) {
        const window = lines.slice(index, index + 9).join('\n');
        if (/modalities:/.test(window)) {
          fail(
            `D4: ${rel}:${index + 1} 树夹具含旧字段 capabilities（与 modalities 同对象）。` +
              ` 能力唯一真源 = supportsTools / modalities / thinking，请迁移后重跑。`
          );
        }
      }
    });

    // 规则 D：apiKey: '<非空字面量>' 与 protocol: 共现（8 行窗口）→ 明文凭据混入树夹具。
    // 仅对 mock 统一配置树回执的测试文件生效（树夹具必然出现在 read mock 文件中）；
    // 窗口含 hasKey 的对象是 LS 凭据壳形状（合法 LS meta），排除。
    if (/workbench_read_models_yaml/.test(src)) {
      lines.forEach((line, index) => {
        if (/apiKey:\s*['"][^'"]+['"]/.test(line)) {
          const window = lines.slice(Math.max(0, index - 4), index + 9).join('\n');
          if (/protocol:/.test(window) && !/hasKey:/.test(window)) {
            fail(
              `D4: ${rel}:${index + 1} 树夹具混入明文 apiKey（与 protocol 同对象）。` +
                ` 凭据 = apiKeyRef + credentialStates（hasKey），明文只允许存在于 LS 凭据壳（hasKey）形状或显式负向断言。`
            );
          }
        }
      });
    }
  }
  ok('D4: 测试树夹具旧字段 / 明文凭据共现扫描完成');
}

/* ── D6 字典防线（退役别名部分） ─────────────────────────────── */

{
  const rel = 'apps/crish-desktop/src/services/modelsAutofillBaselineData.json';
  const src = read(rel);
  const retired = ['deepseek/deepseek-chat'];
  for (const alias of retired) {
    if (src.includes(`"id": "${alias}"`)) {
      fail(`D6: 基线字典回潮退役别名 ${alias}（该别名不得再映射窗口/能力）`);
    }
  }
  ok('D6: 退役别名清单核验完成');
}

/* ── 出口 ────────────────────────────────────────────────────── */

if (failures.length > 0) {
  console.error(`\ncheck-provider-single-track：${failures.length} 条断言失败`);
  process.exit(1);
}
console.log('\ncheck-provider-single-track：全部通过');
