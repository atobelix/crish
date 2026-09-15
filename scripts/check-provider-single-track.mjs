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
 *   D1 连通防线：生产代码零引用已退役符号（清单由兼容清册生成）。
 *     实证缺陷：删旧符号留消费调用（E0425 同族）。
 *   D2 构建防线：全量构建单任务档位；构建失败禁止被静默跳过。
 *     实证缺陷：OOM 中断遗留产物损坏假象（E0463），失败被误读为环境问题。
 *   D3 契约防线：read 回执形状守卫（完整树 + revision + credentialStates）
 *     及其负向断言必须齐备。
 *     实证缺陷：mock 旧回执形状，20 个文件陈旧却仍绿跑的假象。
 *   D7 协议防线：规范协议集合外写出即红；旧名 google/interactions 只允许
 *     存在于显式升级边界（modelsLsImport）。
 *     实证缺陷：协议旧名写出风险。
 *   D8 孤岛防线：旧 LS 档案写口不得在岛外复活；localStorage.setItem 写口
 *     必须登记（棘轮）。
 *     实证缺陷：LS 业务写口复活。
 *   D9 思考防线：未声明档位 → 引导态（不 throw 到渲染层、不降级、不出站）；
 *     词表外键 → 显式诊断。
 *     实证缺陷：未声明档位静默降级 / 渲染崩溃。
 *
 * 用法：node scripts/check-provider-single-track.mjs [--guide <metric>]
 * 退出码：0 通过；1 任一断言失败。
 *
 * 纯 Node ESM，无第三方依赖。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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

/// git 查询（stdout trim；任何非零退出 / 非 git 环境 → 空串，调用方按「未命中」处理）
function gitOut(args) {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * 极简 glob 匹配（`**` 跨目录 / `*` 单段 / `{a,b}` 枚举）——只服务 D11⑤ 的
 * 「注册面是否覆盖某文件」判定，不追求通用 glob 语义。
 */
function globMatch(glob, rel) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { out += '[\\s\\S]*'; i++; }
      else out += '[^/]*';
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) { out += '\\{'; continue; }
      out +=
        '(?:' +
        glob
          .slice(i + 1, end)
          .split(',')
          .map((a) => a.replace(/[.+?^$()|\[\]\\]/g, '\\$&'))
          .join('|') +
        ')';
      i = end;
    } else if (/[.+?^$()|\[\]\\]/.test(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`).test(rel);
}

/* ── 正确做法指引（--guide） ──────────────────────────────────── */
// 增量契约：仅在显式 `--guide <metric>` 时生效并立即退出；
// 不触碰任何断言、判定分支与「普通运行」的退出码。
// 指标名 = 本脚本 FAIL 输出中的真实防线标识（D5 / D4 / D6），
// 与 docs/provider-single-track-convergence/02-执行拓扑与防御网方案.md 的 D 线编号一一对应。
const GUIDE_INDEX = process.argv.indexOf('--guide');

const GUIDE_TEXT = {
  D1: [
    '违反项：生产代码仍引用**已退役符号**（FAIL 前缀 D1）——删了旧符号却留下消费调用（E0425 同族）。',
    '文件:行号：FAIL 逐条给出 `<file>:<line>`。扫描范围 = 生产 Rust（crates/**、apps/agent-workbench/src-tauri/src/**，排除 `*_tests.rs` 与 `tests/`，并跳过 `#[cfg(test)]` 区块）+ 生产前端（apps/crish-desktop/src/**，排除 `*.test.ts(x)`）；注释不计。',
    '当前值/阈值：每个退役符号命中数必须 = 0。清单（7 个，由兼容清册生成）：with_store_mut / config_profile_apply / config_get( / lookup_by_model_id / MODEL_SERIES_CACHE_BEHAVIOR / selectEstimatedCost / selectModelGlobally。',
    '正确做法：',
    '  ① 消费点迁到统一配置单轨：配置读写走 `ModelsStore::apply`（CAS 事务）+ `reload_provider`，不要保留旧 store 写口；',
    '  ② 前端模型选择器改用现行权威入口（`modelRefKey` / 目录查询），不要复活跨厂商「首个」选择器；',
    '  ③ 确需保留该符号 → 先在 docs/model-config-ssot-convergence/00-兼容清册.md 登记其性质与边界，再在本脚本 D1_RETIRED 同步（两处必须一致）；',
    '  ④ 复现：node scripts/check-provider-single-track.mjs。',
    '参考：docs/model-config-ssot-convergence/00-兼容清册.md「已删除」表；docs/provider-single-track-convergence/00-执行记录.md R-域实测记录。',
  ],
  D2: [
    '违反项：全量构建未钉单任务档位，或构建失败可被静默跳过（FAIL 前缀 D2）。',
    '文件:行号：FAIL 给出 FULL_CHECK_COMMANDS.md 的具体命令行或 .github/workflows/<wf>:<line>。',
    '当前值/阈值：① FULL_CHECK_COMMANDS.md 中每条全量 cargo 命令（含 `--workspace` / `--manifest-path`）必须带 `-j 1`；② 必须登记 workbench 主二进制 `cargo check --manifest-path`；③ CI 的 cargo 步骤不得 `continue-on-error: true` 或 `|| true`。三项均须为 0 违例。',
    '正确做法：',
    '  ① 全量构建统一写成 `cargo test --workspace -j 1` / `cargo check --manifest-path apps/agent-workbench/src-tauri/Cargo.toml -j 1`——Windows 可提交虚拟内存余量有限，默认并行编译曾 OOM 中断并留下「产物损坏」假象（E0463），失败会被误读为环境问题；',
    '  ② 不要用 `continue-on-error` / `|| true` 让构建步骤「软失败」——报错必须拦住；',
    '  ③ 主二进制构建不可从清单里删掉（那是唯一能发现「删旧符号留消费调用」的编译面）；',
    '  ④ 复现：node scripts/check-provider-single-track.mjs。',
    '参考：docs/provider-single-track-convergence/02-执行拓扑与防御网方案.md D2 行。',
  ],
  D3: [
    '违反项：read 回执形状守卫缺失/被弱化，或缺负向断言（FAIL 前缀 D3）。',
    '文件:行号：apps/crish-desktop/src/api/modelsCatalogIpc.ts（守卫 `isSnapshot`）与 apps/crish-desktop/src/api/modelsCatalogIpc.test.ts（负向断言）。',
    '当前值/阈值：① `isSnapshot` 必须强制 `revision` 非空、`credentialStates` 为对象、`credentialStates[*].hasKey` 为 boolean；② 负向断言必须覆盖 4 类：空 revision / credentialStates 缺失 / 旧 `tree` 投影 / hasKey 非布尔。',
    '正确做法：',
    '  ① 回执 = 规范树（path + revision + content + template + credentialStates），**不再有 `tree` 旧投影**；有损投影必须被拒（`CONTRACT_MISMATCH`），不得「补字段装成成功」；',
    '  ② 新增拒绝路径时同步补负向断言——守卫的拒绝分支必须有测试钉死，否则可被静默弱化；',
    '  ③ mock 请走统一回执工厂——唯一真源 = apps/crish-desktop/src/test-utils/modelsCatalogSnapshot.ts 的 `catalogSnapshot`（默认值只在该处定义，差异经 overrides 显式传入）；调用侧至多保留一层薄包装补「本文件特有的默认参数」，不得再自行拼装回执字段。此前 `modelsCatalogIpc.test.ts` 与 `modelsCatalogStore.test.ts` 各有一份本地 `snapshot()` 且默认值发散（template / parseError / apiKeyLast4），已于 2026-09-15 收敛；',
    '  ④ 复现：node scripts/check-provider-single-track.mjs。',
    '参考：docs/provider-single-track-convergence/02-执行拓扑与防御网方案.md D3 行。',
  ],
  D7: [
    '违反项：规范协议集合被绕过 / 旧协议名泄漏到升级边界之外（FAIL 前缀 D7）。',
    '文件:行号：apps/crish-desktop/src/api/modelsNormalize.ts（集合与归一）、apps/crish-desktop/src/api/modelsLsImport.ts（唯一允许的升级边界）；越界命中由 FAIL 列出。',
    '当前值/阈值：① CANONICAL_PROTOCOLS 必须存在且不含 `google/interactions`；② normalizeProtocol 必须以 CANONICAL_PROTOCOLS 收口；③ 生产代码中 `google/interactions` 只允许出现在 modelsLsImport.ts。',
    '正确做法：',
    '  ① 运行时与写出统一用规范名 `google/generate-content`；旧名 `google/interactions` 只在**读侧升级边界**（modelsLsImport 的别名映射）出现一次；',
    '  ② 任何新增协议先加进 PROTOCOLS / CANONICAL_PROTOCOLS，再经 normalizeProtocol 归一——不要就地写字面量；',
    '  ③ 别名映射不得散落到运行时：`google/interactions` 出现在 modelsLsImport.ts 之外即红；',
    '  ④ 复现：node scripts/check-provider-single-track.mjs。',
    '参考：docs/provider-single-track-convergence/02-执行拓扑与防御网方案.md D7 行。',
  ],
  D8: [
    '违反项：旧 LS 档案写口复活（岛外**新增**写调用），或新增未登记的 localStorage.setItem 写口（FAIL 前缀 D8）。',
    '文件:行号：FAIL 逐条给出 `<file>:<line> <symbol>`。扫描 = apps/crish-desktop/src 生产 ts/tsx（排除 *.test.*，注释不计），符号 = saveProfiles / saveProfileKey / setActiveModelId。',
    '当前值/阈值：① 岛外新增写调用必须 = 0（岛内 = 登记债务，脚本 WARN）；② 带 localStorage.setItem 的文件必须全部登记在 D8_SETITEM_FILES（当前 32 个）。',
    '正确做法：',
    '  ① 业务写口走统一配置单轨：Rust `ModelsStore`（CAS 事务）+ 前端 `modelsCatalog*`；旧 LS 档案只允许**读侧导入**（迁移/兼容读取）；',
    '  ② 需要新增 localStorage 键空间 → 在 D8_SETITEM_FILES 登记文件并说明键的用途与生命周期；',
    '  ③ 岛内债务收敛：逐项把写调用迁出，收敛后从 D8_ISLAND / D8_KNOWN_DEBT 删除对应条目（棘轮只降不升）；',
    '  ④ 复现：node scripts/check-provider-single-track.mjs（WARN 行会列出全部现存债务点位）。',
    '参考：docs/provider-single-track-convergence/02-执行拓扑与防御网方案.md D8 行。',
  ],
  D9: [
    '违反项：思考档位未声明时降级/出站，或词表外档位被静默忽略（FAIL 前缀 D9）。',
    '文件:行号：apps/crish-desktop/src/api/modelsCatalogLive.ts（resolveThinkingHandoff）、apps/crish-desktop/src/api/modelsCatalogLive.test.ts（三条路径断言）。',
    '当前值/阈值：① 模型未声明档位且未选择 → 必须返回引导态 `supported: false`（不 throw 到渲染层、不降级、不出站）；② 请求词表外的档位 → 必须**显式诊断**（throw 且消息含档位名），不得静默忽略；③ 上述两条 + 命中路径都必须有断言钉死。',
    '正确做法：',
    '  ① 未声明档位 = 引导态：让 UI 引导用户去声明，不要偷偷发一个默认 thinking 出去；',
    '  ② 词表外档位 = 显式诊断：静默忽略会让用户以为档位已生效（实际按默认发），属于「不出站但骗人」；',
    '  ③ 新增分支必须同时补断言——拒绝路径与引导路径都要钉死，否则守卫可被静默弱化；',
    '  ④ 复现：node scripts/check-provider-single-track.mjs。',
    '参考：docs/provider-single-track-convergence/02-执行拓扑与防御网方案.md D9 行。',
  ],
  D10: [
    '违反项：Token 域聚合入口 `check-tokens-all.mjs` 清单里列出的子门禁脚本不存在（FAIL 前缀 D10）——子门禁被删/改名而清单未同步，聚合入口**静默少跑一项**，样式防线无声缩水。',
    '文件:行号：scripts/check-tokens-all.mjs 的清单数组（形如 `[\'标签\', \'scripts/x.mjs\', [...]]`）。',
    '当前值/阈值：清单列出的全部子门禁脚本必须存在（当前 14 项）。',
    '正确做法：',
    '  ① D10 的**扫描面由既有 Token 域门禁承担**——裸 Hex / 假 token fallback → `check-color-ssot.mjs`；未定义 `var()` → `check-token-consistency.mjs`；token 定义唯一化与 module.css 交叉校验 → `check-token-ssot.mjs`；布局 / 几何 / 文字色 / 线宽 / 图标 / 输入四态 / tooltip / md 样式 / CSS 编码各有专职门禁。本战役**不重复造扫描逻辑**（重复门禁属反过度设计红线）；',
    '  ② 本防线只守**间接引用链的存在性**：D12 覆盖 `package.json` 与 `FULL_CHECK_COMMANDS.md` 的**直接**引用，覆盖不到聚合入口内部清单；',
    '  ③ 删除或改名任何子门禁，必须同步聚合入口清单——否则聚合入口不报错、只是少跑一项；',
    '  ④ 新增样式类断言前先查既有门禁是否已覆盖，确认缺口后再新建；',
    '  ⑤ 复现：node scripts/check-provider-single-track.mjs。',
    '参考：scripts/check-tokens-all.mjs 头部「为什么需要它」；docs/provider-single-track-convergence/02-执行拓扑与防御网方案.md D10 行。',
  ],
  D11: [
    '违反项：命令注册面漂移（FAIL 前缀 D11）——① manifest 声明面与 main.rs `command_registry!` 实装面不一致；② 前端注册表（tauri-command-registry.ts）与 manifest 不齐；③ 前端内置快照（commandManifest.ts）与 manifest 不齐；④ 任一侧重复登记；⑤ **既有断链门禁失守**——`apps/crish-desktop/src/api/transport/command-contract-drift.test.ts` 不存在 / 缺「断言一（零断链）」「断言二（零幽灵）」/ 未由 vitest 入口注册覆盖。',
    '文件:行号：四方权威 —— apps/agent-workbench/src-tauri/src/command_manifest.rs（`entry("name","family","surface",registered)`）/ apps/agent-workbench/src-tauri/src/main.rs（`command_registry![("name", path), ...]`）/ apps/agent-workbench/src/core/tauri-command-registry.ts（`command: ...`）/ apps/crish-desktop/src/api/transport/commandManifest.ts（`entry("name", ...)`）；⑤ 判据来源 = apps/crish-desktop/src/api/transport/command-contract-drift.test.ts + vitest.config.ts 的 include + package.json 的 vitest 入口。',
    '当前值/阈值：四方命令名集合必须两两相等（当前 142 条），且各侧内部无重名；⑤ 既有门禁必须存在、两条断言齐备、且其路径被 vitest include glob 覆盖（解析不到即显式 FAIL，防正则失配假绿）。',
    '正确做法：',
    '  ① 改注册面（新增 / 退役 / 改名）必须**四处同步**：main.rs 宏 + command_manifest.rs 条目 + 前端注册表 + 前端内置快照；',
    '  ② wire 键 = manifest 登记名；函数名与 wire 键不一致必须显式 `#[tauri::command(rename = "...")]`，禁止函数名隐式成为 wire 键；',
    '  ③ 退役命令四处同时删——实证漂移形态之一就是「旧命令族只删一侧、另一侧仍留」（2026-09-15：前端注册表缺 15 条，含 auth_* / note_document_* / prefs_* / workbench_window_ready）；',
    '  ④ 条数注释与测试锁定值必须随批次更新——陈旧条数（如「73 = 69 + 4」）会让读者误判对齐状态；',
    '  ⑤ **前端调用面 ⊆ manifest 的扫描面由既有门禁承担，本脚本不重复造**（重复门禁属反过度设计红线）：该方向已由 command-contract-drift.test.ts 的「断言一（零断链）」+「断言二（零幽灵）」+ 动态拼接面覆盖。本防线只守其**存在性与注册**（同 D10 模式）。实证 2026-09-15：本脚本此前自建一份同向扫描 + 债务棘轮，两处豁免口径不同 → 结论互相打架——本脚本只红在「注释里的 `invoke(\'X\'` 示例」假阳性上，而真断链 `catalog_get` / `catalog_refresh` 被棘轮登记为「已知债务」，修掉假阳性后会**转绿并掩盖真缺陷**。自建扫描与棘轮表已整体删除；',
    '  ⑥ 真断链的修法：改前端调用名 / 或补 Rust 注册（rename），**不得**把它登记成「已知债务」绕过；',
    '  ⑦ 复现：node scripts/check-provider-single-track.mjs（⑤ 为静态判据）；真断链详情跑 `cd apps/crish-desktop && npx vitest run src/api/transport/command-contract-drift.test.ts`。',
    '参考：command_manifest.rs 模块头「维护规则」；docs/provider-single-track-convergence/02-执行拓扑与防御网方案.md D11 行。',
  ],
  D12: [
    '违反项：① 门禁清单引用了**不存在**的脚本（package.json / FULL_CHECK_COMMANDS.md 与磁盘不一致，干净检出后门禁直接断裂）；② 门禁脚本被 `.gitignore` **永久排除**（存在但永远进不了库的幽灵脚本）。',
    '文件:行号：FAIL 逐条给出相对仓库根的脚本路径；判据来源 = package.json `scripts` 的引用 + FULL_CHECK_COMMANDS.md 反引号内命令 + 本脚本自身。',
    '当前值/阈值：两条判据均须为 0 违例。「未跟踪但未被忽略」= 待提交的正常开发态，不算违规（新脚本先写后提交）。',
    '正确做法：',
    '  ① 门禁脚本是**资产**：`.gitignore` 的 `/scripts/**/*.mjs` 是全局忽略规则，每个守卫脚本必须**逐条** `!scripts/<name>.mjs` 显式放行——不得依赖「已被 git 跟踪」的间接兜底（`git commit --only` 用临时索引，跟踪状态丢失时会被判忽略）；',
    '  ② 被 package.json / FULL_CHECK_COMMANDS.md 引用的脚本若不打算入库（本机专用脚手架），应从引用处摘除，而不是留在清单里指向一个干净检出后不存在的文件；',
    '  ③ 新增门禁脚本时三处同步：写脚本 → 补 `.gitignore` 放行 → 在 FULL_CHECK_COMMANDS.md 注册；',
    '  ④ 复现：node scripts/check-provider-single-track.mjs。',
    '参考：.gitignore 的「守卫脚本显式放行补齐（2026-09-14）」段；docs/provider-single-track-convergence/02-执行拓扑与防御网方案.md D12 行。',
  ],
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
  // ② settingsObjectId 函数体内不得出现 `::` 模板拼接。
  //    作用域必须**按声明处的函数体**取（自 `export function settingsObjectId`
  //    后首个 `{` 起做括号配平）。此前写作
  //    `src.split('settingsObjectId')[1]?.split('}')[0]`，有两处假绿：
  //      ① 锚点落在**文件头注释**上（首个 `settingsObjectId` 出现在模块注释里），
  //         而首个 `}` 落在 import 块 → 扫描面根本不含函数体；
  //      ② 即便锚点正确，`${a}::${b}` 的首个 `}` 落在模板内插里，会正好截掉
  //         `::`，把「回退到 :: 拼接」判成通过。
  let settingsObjectIdBody = '';
  const settingsObjectIdAt = src.search(/export function settingsObjectId/);
  if (settingsObjectIdAt !== -1) {
    const braceAt = src.indexOf('{', settingsObjectIdAt);
    if (braceAt !== -1) {
      let depth = 0;
      for (let i = braceAt; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) {
          settingsObjectIdBody = src.slice(braceAt, i + 1);
          break;
        }
      }
    }
  }
  if (/\$\{[^}]+\}::\$\{/.test(settingsObjectIdBody)) {
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

/* ── D1 连通防线（生产代码零引用已退役符号） ───────────────────── */

// 权威清单来源（清单由兼容清册生成，不得在此凭空增删）：
//   ① docs/model-config-ssot-convergence/00-兼容清册.md「已删除」表（α3 / α4 / α6）
//   ② docs/provider-single-track-convergence/00-执行记录.md R-域实测记录
//      （统一配置单轨后 config_get / config_profile_apply / with_store_mut 消费面零残留）
const D1_RETIRED = [
  { symbol: 'with_store_mut', kind: 'rust', note: '旧统一配置 store 写口（已由 ModelsStore::apply CAS 事务取代）' },
  { symbol: 'config_profile_apply', kind: 'rust', note: '旧供应商配置写入命令（已退役）' },
  { symbol: 'config_get(', kind: 'rust', note: '旧配置读取命令（已退役）' },
  { symbol: 'lookup_by_model_id', kind: 'rust', note: '跨厂商首个模型查询（α4 已删除）' },
  { symbol: 'MODEL_SERIES_CACHE_BEHAVIOR', kind: 'rust', note: '系列缓存行为表（α6 已删除）' },
  { symbol: 'selectEstimatedCost', kind: 'ts', note: 'gravestone 选择器（α3 已删除）' },
  { symbol: 'selectModelGlobally', kind: 'ts', note: '跨厂商首模型选择器（α3 已删除）' },
];

/** 去掉行/块注释（保留换行以维持行号）。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

/**
 * 标记 `#[cfg(test)]` 覆盖的行号（1-based）。判定 = 从该属性后的第一个 `{`
 * 起做括号配平；`#[cfg(test)] mod x;`（无花括号）只覆盖其自身行。
 */
function cfgTestLines(src) {
  const masked = stripComments(src);
  const lines = masked.split('\n');
  const covered = new Set();
  const re = /#\[cfg\(test\)\]/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    const startLine = masked.slice(0, m.index).split('\n').length;
    const braceAt = masked.indexOf('{', m.index);
    const semiAt = masked.indexOf(';', m.index);
    if (braceAt === -1 || (semiAt !== -1 && semiAt < braceAt)) {
      covered.add(startLine);
      continue;
    }
    let depth = 0;
    let end = braceAt;
    for (let i = braceAt; i < masked.length; i++) {
      if (masked[i] === '{') depth++;
      else if (masked[i] === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    const endLine = masked.slice(0, end).split('\n').length;
    for (let l = startLine; l <= endLine; l++) covered.add(l);
  }
  return covered;
}

{
  const targets = [
    ...walk(path.join(REPO_ROOT, 'crates'), (name) => name.endsWith('.rs')),
    ...walk(path.join(REPO_ROOT, 'apps/agent-workbench/src-tauri/src'), (name) => name.endsWith('.rs')),
  ];
  let scanned = 0;
  for (const file of targets) {
    const rel = path.relative(REPO_ROOT, file).replaceAll('\\', '/');
    // 测试文件整体排除：`*_tests.rs` 与 `tests/` 目录
    if (/_tests\.rs$/.test(rel) || /\/tests\//.test(rel)) continue;
    const raw = fs.readFileSync(file, 'utf8');
    const masked = stripComments(raw);
    const testLines = cfgTestLines(raw);
    scanned++;
    const lines = masked.split('\n');
    lines.forEach((line, index) => {
      const lineNo = index + 1;
      if (testLines.has(lineNo)) return; // #[cfg(test)] 内允许（测试专用符号）
      for (const { symbol, note } of D1_RETIRED) {
        // 符号一律**转义后按词边界**匹配：
        //   ① 含 `(` 的符号（config_get(）此前用 `line.includes(symbol)` 子串匹配，
        //      `foo_config_get(` 会被误报（误报会让防线失去可信度）；
        //   ② 不含 `(` 的符号此前未转义正则（Rust 分支）——退役符号若含元字符即失配假绿。
        const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = symbol.endsWith('(')
          ? new RegExp(`\\b${escaped}`)
          : new RegExp(`\\b${escaped}\\b`);
        if (!re.test(line)) continue;
        fail(
          `D1: ${rel}:${lineNo} 生产代码仍引用已退役符号 \`${symbol}\`（${note}）。` +
            ` 消费面必须已迁到统一配置单轨；若确需保留请先在兼容清册登记并说明边界。`
        );
      }
    });
  }
  ok(`D1: 生产 Rust 代码退役符号连通扫描完成（${scanned} 个文件 / ${D1_RETIRED.length} 个退役符号）`);
}

{
  const files = walk(path.join(REPO_ROOT, 'apps/crish-desktop/src'), (name) =>
    /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)
  );
  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file).replaceAll('\\', '/');
    const masked = stripComments(fs.readFileSync(file, 'utf8'));
    masked.split('\n').forEach((line, index) => {
      for (const { symbol, kind, note } of D1_RETIRED) {
        if (kind !== 'ts') continue;
        // 与 Rust 分支统一：转义后按词边界匹配（未转义时退役符号含元字符即失配假绿）
        const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (!new RegExp(`\\b${escaped}\\b`).test(line)) continue;
        fail(
          `D1: ${rel}:${index + 1} 生产代码仍引用已退役符号 \`${symbol}\`（${note}）。`
        );
      }
    });
  }
  ok('D1: 生产前端代码退役选择器扫描完成');
}

/* ── D2 构建防线（全量构建单任务档位 + 禁止静默跳过） ───────────── */

{
  // ① 全量 cargo 命令必须显式单任务档位：Windows 可提交虚拟内存余量有限，
  //    默认并行编译曾 OOM 中断并留下「产物损坏」假象（E0463）。
  const full = read('FULL_CHECK_COMMANDS.md');
  // 只取反引号内的命令本体——行内说明文字可能提到「-j 1 必带」，
  // 若扫整行会把「命令本身没钉」的缺陷盖成通过（假阴性）。
  // 逐行 matchAll（非 match）：一行内可能出现**多条**反引号命令，
  // 只取首条会让后面的未钉命令静默漏检。
  const cargoCmds = [];
  for (const l of full.split('\n')) {
    for (const m of l.matchAll(/`([^`]*cargo\s+(?:test|check|build)\s[^`]*)`/g)) {
      if (/--workspace|--manifest-path/.test(m[1])) cargoCmds.push({ line: l.trim(), cmd: m[1] });
    }
  }
  const unpinned = cargoCmds.filter(({ cmd }) => !/-j\s*1\b/.test(cmd) && !/--jobs\s*1\b/.test(cmd));
  if (cargoCmds.length === 0) {
    fail('D2: FULL_CHECK_COMMANDS.md 未登记任何全量 cargo 命令——主二进制检查被静默移除');
  } else if (unpinned.length > 0) {
    fail(
      `D2: FULL_CHECK_COMMANDS.md 有 ${unpinned.length} 条全量 cargo 命令未钉单任务档位（-j 1）——` +
        ` 默认并行编译在页面文件余量不足时 OOM 中断，失败会被误读为「产物损坏」。首条：${unpinned[0].line}`
    );
  } else {
    ok(`D2: 全量 cargo 命令全部钉单任务档位（${cargoCmds.length} 条）`);
  }

  // ② 主二进制构建/检查必须仍被登记（防止「静默跳过主二进制检查」）
  if (/cargo\s+check\s+--manifest-path\s+apps\/agent-workbench\/src-tauri\/Cargo\.toml/.test(full)) {
    ok('D2: workbench 主二进制静态检查已登记');
  } else {
    fail('D2: FULL_CHECK_COMMANDS.md 缺少 workbench 主二进制 `cargo check --manifest-path`——构建失败可被静默跳过');
  }

  // ③ CI 工作流的 cargo 步骤不得 continue-on-error / `|| true`（失败必须 fail）
  const wfDir = path.join(REPO_ROOT, '.github/workflows');
  if (fs.existsSync(wfDir)) {
    const wfs = fs.readdirSync(wfDir).filter((n) => n.endsWith('.yml'));
    let steps = 0;
    for (const wf of wfs) {
      const lines = fs.readFileSync(path.join(wfDir, wf), 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (!/run:\s*cargo\s/.test(line)) return;
        steps++;
        const window = lines.slice(Math.max(0, index - 6), index + 7).join('\n');
        if (/continue-on-error:\s*true/.test(window)) {
          fail(`D2: .github/workflows/${wf}:${index + 1} 的 cargo 步骤被 continue-on-error 静默跳过`);
        }
        if (/\|\|\s*true/.test(line)) {
          fail(`D2: .github/workflows/${wf}:${index + 1} 的 cargo 步骤带 \`|| true\`——构建失败被吞`);
        }
      });
    }
    ok(`D2: CI cargo 步骤静默跳过扫描完成（${wfs.length} 个工作流 / ${steps} 个 cargo 步骤）`);
  }
}

/* ── D3 契约防线（read 回执形状：完整树 + revision + credentialStates） ── */

{
  const rel = 'apps/crish-desktop/src/api/modelsCatalogIpc.ts';
  const src = read(rel);

  // ① 回执守卫必须存在，且强制 revision 与 credentialStates
  if (!/function isSnapshot\(/.test(src)) {
    fail(`D3: ${rel} 缺少 isSnapshot 回执守卫——有损旧投影可被当成成功回执`);
  } else {
    if (!/typeof value\.revision !== 'string' \|\| !value\.revision/.test(src)) {
      fail(`D3: ${rel} 的 isSnapshot 未强制 revision 非空——revision 缺失会被放行`);
    }
    if (!/!object\(value\.credentialStates\)/.test(src)) {
      fail(`D3: ${rel} 的 isSnapshot 未强制 credentialStates——凭据态缺失会被放行`);
    }
    if (!/hasKey !== 'boolean'/.test(src)) {
      fail(`D3: ${rel} 的 isSnapshot 未校验 credentialStates[*].hasKey 为 boolean`);
    }
    ok('D3: isSnapshot 强制 revision / credentialStates / hasKey');
  }

  // ② 负向断言必须覆盖：空 revision、credentialStates 缺失、旧 tree 投影
  const testRel = 'apps/crish-desktop/src/api/modelsCatalogIpc.test.ts';
  const testSrc = read(testRel);
  const negatives = [
    { name: '空 revision', re: /revision:\s*''/ },
    { name: 'credentialStates 缺失', re: /credentialStates:\s*undefined/ },
    { name: '旧 tree 投影', re: /tree:\s*(\{\s*version|\bnull\b)/ },
    { name: 'hasKey 非布尔', re: /hasKey:\s*'yes'/ },
  ];
  const missing = negatives.filter((n) => !n.re.test(testSrc));
  if (missing.length > 0) {
    fail(
      `D3: ${testRel} 缺少负向断言：${missing.map((n) => n.name).join(' / ')}——` +
        ` 回执守卫的拒绝路径必须被钉死，否则守卫可被静默弱化`
    );
  } else {
    ok('D3: 回执守卫负向断言齐备（4 类）');
  }

  // ③ 回执 mock 工厂唯一性（2026-09-15 已收敛：唯一真源 =
  // apps/crish-desktop/src/test-utils/modelsCatalogSnapshot.ts 的 catalogSnapshot）
  const factories = [
    'apps/crish-desktop/src/api/modelsCatalogIpc.test.ts',
    'apps/crish-desktop/src/api/modelsCatalogStore.test.ts',
  ].filter((p) => /function snapshot\(/.test(read(p)));
  if (factories.length > 1) {
    console.warn(
      `WARN  D3: read 回执 mock 工厂存在 ${factories.length} 份独立定义（${factories.join(' / ')}）——` +
        ` 二者默认值已发散（template / parseError / apiKeyLast4 不一致）。` +
        ` 权威要求「唯一 mock 工厂」，收敛为共享 helper 后本告警应消失。`
    );
  } else {
    ok('D3: read 回执 mock 工厂唯一');
  }
}

/* ── D7 协议防线（规范协议集合外写出即红） ─────────────────────── */

{
  const rel = 'apps/crish-desktop/src/api/modelsNormalize.ts';
  const src = read(rel);

  // ① 规范集合必须存在，且**不含**只读边界旧名
  if (!/export const CANONICAL_PROTOCOLS/.test(src)) {
    fail(`D7: ${rel} 缺少 CANONICAL_PROTOCOLS——运行时/写出的规范协议集合无单一真源`);
  } else if (/CANONICAL_PROTOCOLS[\s\S]{0,400}google\/interactions/.test(src)) {
    fail(`D7: ${rel} 的规范协议集合混入旧名 google/interactions——旧名只允许存在于显式升级边界`);
  } else {
    ok('D7: 规范协议集合存在且不含旧名 google/interactions');
  }

  // ② 归一入口必须拒绝集合外取值（返回 undefined 而非原样透传）
  if (/export function normalizeProtocol[\s\S]{0,240}CANONICAL_PROTOCOLS\.has\(raw\)/.test(src)) {
    ok('D7: normalizeProtocol 只放行规范集合内的协议');
  } else {
    fail(`D7: ${rel} 的 normalizeProtocol 未以 CANONICAL_PROTOCOLS 收口——集合外取值可被原样透传写出`);
  }

  // ③ 旧名只允许出现在显式升级边界 modelsLsImport.ts（+ 测试）
  const BOUNDARY = 'apps/crish-desktop/src/api/modelsLsImport.ts';
  const offenders = [];
  for (const file of walk(path.join(REPO_ROOT, 'apps/crish-desktop/src'), (name) =>
    /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)
  )) {
    const r = path.relative(REPO_ROOT, file).replaceAll('\\', '/');
    if (r === BOUNDARY) continue;
    if (/google\/interactions/.test(stripComments(fs.readFileSync(file, 'utf8')))) offenders.push(r);
  }
  if (offenders.length > 0) {
    fail(
      `D7: 旧协议名 google/interactions 出现在升级边界之外：${offenders.join(' / ')}——` +
        ` 别名映射只允许存在于 modelsLsImport.ts（显式升级边界），运行时与写出必须用 google/generate-content`
    );
  } else {
    ok('D7: 旧协议名仅存在于显式升级边界 modelsLsImport.ts');
  }
}

/* ── D8 孤岛防线（LS 业务写口不得复活） ────────────────────────── */

// 登记为「旧 LS 档案岛」的文件域（迁移未收口 ⇒ 现状债务，非豁免新增）。
// 权威目标 = 岛内写调用归零（本表随迁移收口逐项删除）。
const D8_ISLAND = [
  'apps/crish-desktop/src/api/provider-profiles/',
  'apps/crish-desktop/src/api/providerProfiles.ts',
  // OAuth token 调度器：**生产活跃**（bootstrap-full.ts:37-43 拉起
  // initOAuthTokenScheduler），岛内合法写口——token 刷新成功后必须回写
  // profile.oauthToken / hasKey（oauthTokenManager.ts:106-109）。
  // 2026-09-15 更正：此前注释误标「无生产引用方（死岛），待清退」，
  // 若据此清退会**删掉活的 OAuth 刷新链路**（脚本自述与事实不符的失真登记）。
  'apps/crish-desktop/src/api/oauthTokenManager.ts',
];
const D8_SYMBOLS = ['saveProfiles', 'saveProfileKey', 'setActiveModelId'];

// 岛外**已知债务**（2026-09-15 实测）：新设置 UI 与首启向导仍直接调用旧岛写入方
// `saveProfileKey`（其实现内部 `saveProfiles(list)` 写 LS + 走旧同步路径）。
// 这是迁移未收口的事实，不是豁免新增——新增站点（不在本表）一律硬失败。
const D8_KNOWN_DEBT = new Map([
  ['apps/crish-desktop/src/components/settings-models/useModelProfilesState.ts', '设置 UI 保存密钥仍走旧岛 saveProfileKey'],
  ['apps/crish-desktop/src/components/useFirstRunWizard.ts', '首启向导保存密钥仍走旧岛 saveProfileKey'],
]);

{
  const inIsland = (rel) => D8_ISLAND.some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p));
  const outside = [];
  const islandHits = [];
  const debtHits = [];
  for (const file of walk(path.join(REPO_ROOT, 'apps/crish-desktop/src'), (name) =>
    /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)
  )) {
    const rel = path.relative(REPO_ROOT, file).replaceAll('\\', '/');
    const masked = stripComments(fs.readFileSync(file, 'utf8'));
    masked.split('\n').forEach((line, index) => {
      for (const symbol of D8_SYMBOLS) {
        if (!new RegExp(`\\b${symbol}\\s*\\(`).test(line)) continue;
        const at = `${rel}:${index + 1}`;
        if (inIsland(rel)) islandHits.push(`${at} ${symbol}`);
        else if (D8_KNOWN_DEBT.has(rel)) debtHits.push(`${at} ${symbol}`);
        else outside.push(`${at} ${symbol}`);
      }
    });
  }
  if (outside.length > 0) {
    fail(
      `D8: 旧 LS 档案写口在岛外**新增**（${outside.length} 处，未登记）：${outside.slice(0, 5).join(' / ')}` +
        `${outside.length > 5 ? ' …' : ''}—— 业务写口必须走统一配置单轨（ModelsStore / modelsCatalog*），` +
        ` 旧 LS 档案只允许读侧导入。`
    );
  } else {
    ok('D8: 旧 LS 档案写口在岛外零新增');
  }
  if (islandHits.length > 0) {
    console.warn(
      `WARN  D8: 旧 LS 档案岛内仍有 ${islandHits.length} 处写调用（登记债务，目标 = 0）：` +
        `${islandHits.slice(0, 4).join(' / ')}${islandHits.length > 4 ? ' …' : ''}。` +
        ` 迁移收口时逐项删除本脚本 D8_ISLAND 条目。`
    );
  }
  if (debtHits.length > 0) {
    console.warn(
      `WARN  D8: 岛外已知债务 ${debtHits.length} 处（登记于 D8_KNOWN_DEBT，目标 = 0）：` +
        `${debtHits.join(' / ')}。 收敛方向 = 设置 UI / 首启向导改调统一单轨的密钥写入，` +
        ` 收敛后从 D8_KNOWN_DEBT 删除对应条目。`
    );
  }

  // localStorage.setItem 键空间白名单（棘轮：新增写文件必须显式登记）
  const D8_SETITEM_FILES = new Set([
    'apps/crish-desktop/src/api/SessionRuntimeRegistry.ts',
    'apps/crish-desktop/src/api/agentProfiles.ts',
    'apps/crish-desktop/src/api/beforeunloadFlush.ts',
    'apps/crish-desktop/src/api/cache/runtimeCache.ts',
    'apps/crish-desktop/src/api/clientApiSettings.ts',
    'apps/crish-desktop/src/api/engineConfigIO.ts',
    'apps/crish-desktop/src/api/extensionCatalog.ts',
    'apps/crish-desktop/src/api/import/importRootSettings.ts',
    'apps/crish-desktop/src/api/localStorageApi.ts',
    'apps/crish-desktop/src/api/modelCatalogMeta.ts',
    'apps/crish-desktop/src/api/modelPricingSource.ts',
    'apps/crish-desktop/src/api/modelsLsImport.ts',
    'apps/crish-desktop/src/api/previewBrowserStore.ts',
    'apps/crish-desktop/src/api/pricingStore.ts',
    'apps/crish-desktop/src/api/projectStore.ts',
    'apps/crish-desktop/src/api/provider-profiles/contextStatePending.ts',
    'apps/crish-desktop/src/api/provider-profiles/migrateLegacyProfiles.ts',
    'apps/crish-desktop/src/api/provider-profiles/profileActiveSelection.ts',
    'apps/crish-desktop/src/api/provider-profiles/profileStorePersistence.ts',
    'apps/crish-desktop/src/api/session-persistence/sessionLocalStorage.ts',
    'apps/crish-desktop/src/api/session-persistence/sessionQuota.ts',
    'apps/crish-desktop/src/api/session-persistence/sessionRustDbFallback.ts',
    'apps/crish-desktop/src/api/session-persistence/sessionShellKeyMigration.ts',
    'apps/crish-desktop/src/api/shellWindowScope.ts',
    'apps/crish-desktop/src/api/skillsApiFs.ts',
    'apps/crish-desktop/src/api/skillsApiHelpers.ts',
    'apps/crish-desktop/src/api/themeStore.ts',
    'apps/crish-desktop/src/api/updateStore.ts',
    'apps/crish-desktop/src/api/usageStore.ts',
    'apps/crish-desktop/src/app/hydrateWorkspaceShell.ts',
    'apps/crish-desktop/src/services/TelemetryService.ts',
    'apps/crish-desktop/src/services/startup/startupMetrics.ts',
    'apps/crish-desktop/src/utils/layoutSerializer.ts',
  ]);
  const newWriters = [];
  for (const file of walk(path.join(REPO_ROOT, 'apps/crish-desktop/src'), (name) =>
    /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)
  )) {
    const rel = path.relative(REPO_ROOT, file).replaceAll('\\', '/');
    if (D8_SETITEM_FILES.has(rel)) continue;
    if (/localStorage\.setItem\s*\(/.test(stripComments(fs.readFileSync(file, 'utf8')))) {
      newWriters.push(rel);
    }
  }
  if (newWriters.length > 0) {
    fail(
      `D8: 新增 localStorage.setItem 写口未登记：${newWriters.join(' / ')}——` +
        ` localStorage 键空间必须显式登记（白名单在 check-provider-single-track.mjs 的 D8_SETITEM_FILES）`
    );
  } else {
    ok(`D8: localStorage.setItem 键空间白名单核验完成（${D8_SETITEM_FILES.size} 个登记文件）`);
  }
}

/* ── D9 思考防线（未声明档位不降级不出站；词表外键显式诊断） ─────── */

{
  const rel = 'apps/crish-desktop/src/api/modelsCatalogLive.ts';
  const src = read(rel);
  const body = src.split('export function resolveThinkingHandoff')[1] ?? '';

  // ① 未声明档位 + 无选择 → 引导态（supported: false），不得 throw
  if (!/if \(!model \|\| options\.length === 0\)/.test(body)) {
    fail(`D9: ${rel} 的 resolveThinkingHandoff 未识别「模型未声明思考档位」分支`);
  } else if (!/supported:\s*false/.test(body)) {
    fail(`D9: ${rel} 未声明档位时未返回引导态（supported: false）——可能降级或出站`);
  } else {
    ok('D9: 未声明档位返回引导态（supported: false，不降级不出站）');
  }

  // ② 词表外键 → 显式诊断（throw 且消息指明档位），不得静默忽略
  if (/if \(selectedTitle && !option\)\s*throw new Error\(/.test(body)) {
    ok('D9: 词表外档位 → 显式诊断（throw，消息含档位名）');
  } else {
    fail(`D9: ${rel} 对词表外的思考档位未显式诊断——静默忽略会让用户以为档位已生效`);
  }

  // ③ 负向断言必须钉死三条路径（引导态 / 词表外 / 已声明档位命中）
  const testRel = 'apps/crish-desktop/src/api/modelsCatalogLive.test.ts';
  const testSrc = read(testRel);
  const needed = [
    { name: '未声明档位 → supported:false', re: /resolveThinkingHandoff\([^)]*null\)[\s\S]{0,200}supported:\s*false/ },
    { name: '词表外键 → throw', re: /expect\(\(\) => resolveThinkingHandoff\([^)]*\)\)\.toThrow\(/ },
  ];
  const missing = needed.filter((n) => !n.re.test(testSrc));
  if (missing.length > 0) {
    fail(`D9: ${testRel} 缺少负向断言：${missing.map((n) => n.name).join(' / ')}`);
  } else {
    ok('D9: 思考交接三条路径均有断言钉死');
  }
}

/* ── D10 样式防线（既有 Token 域门禁的间接引用存在性） ───────────── */

{
  // D10 的**扫描面**由既有 Token 域门禁承担，本战役**不重复造扫描逻辑**
  // （否则就是重复门禁，属反过度设计红线）：
  //   裸 Hex / 假 token fallback        → scripts/check-color-ssot.mjs
  //   未定义 var() / 三项一致性指标     → scripts/check-token-consistency.mjs
  //   定义唯一化 + module.css 交叉校验  → scripts/check-token-ssot.mjs
  //   布局 / 几何 / 文字色 / 线宽 / 图标 / 输入四态 / tooltip / md 样式 / CSS 编码
  //                                     → 见聚合入口清单
  // 本防线只守**间接引用链的存在性**：D12 覆盖 package.json 与
  // FULL_CHECK_COMMANDS.md 的**直接**引用，覆盖不到聚合入口内部的清单——
  // 子门禁被删/改名而清单未同步时，聚合入口会**静默少跑一项**（门禁面悄悄缩水）。
  const aggregatorRel = 'scripts/check-tokens-all.mjs';
  const listed = [
    ...read(aggregatorRel).matchAll(
      /\[\s*'[^']+'\s*,\s*'(scripts\/[\w./-]+\.(?:mjs|js|cjs|ps1))'/g,
    ),
  ].map((m) => m[1]);

  if (listed.length === 0) {
    fail(
      `D10: 未能从 ${aggregatorRel} 解析出子门禁清单——` +
        ` 清单形态变更时本防线会假绿，请同步正则（当前正则假设 ['标签', 'scripts/x.mjs', [...]]）`
    );
  } else {
    const absent = listed.filter((rel) => !fs.existsSync(path.join(REPO_ROOT, rel)));
    if (absent.length > 0) {
      fail(
        `D10: Token 域聚合入口 ${aggregatorRel} 列出的子门禁不存在：${absent.join(' / ')}——` +
          ` 删除或改名子门禁时必须同步清单，否则聚合入口静默少跑一项（样式防线无声缩水）`
      );
    } else {
      ok(
        `D10: Token 域聚合入口 ${listed.length} 项子门禁全部存在（样式扫描面由既有门禁承担，不重复造）`
      );
    }
  }
}

/* ── D11 注册防线（四方命令集合对齐；Rust 声明面与实装面一致） ───── */

{
  // 四方权威（全部可静态解析，无需构建产物）：
  //   A 声明面 = command_manifest.rs 的 entry("name","family","surface",registered)
  //   B 实装面 = main.rs 的 command_registry![("name", path), ...]（wire 键字面量）
  //   C 前端注册表 = tauri-command-registry.ts 的 command: '...'
  //   D 前端内置快照 = crish-desktop commandManifest.ts 的 entry('name', ...)
  // 缺陷形态：删命令漏改一处 / 新增命令只登记一侧 / 条数注释与实况脱节。
  const manifestRel = 'apps/agent-workbench/src-tauri/src/command_manifest.rs';
  const mainRel = 'apps/agent-workbench/src-tauri/src/main.rs';
  const registryRel = 'apps/agent-workbench/src/core/tauri-command-registry.ts';
  const snapshotRel = 'apps/crish-desktop/src/api/transport/commandManifest.ts';

  const manifestEntries = [
    ...read(manifestRel).matchAll(
      /\bentry\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*(true|false)/g,
    ),
  ].map((m) => ({ name: m[1], registered: m[4] === 'true' }));

  const mainSrc = read(mainRel);
  const macroStart = mainSrc.indexOf('command_registry![');
  const macroTail = macroStart === -1 ? '' : mainSrc.slice(macroStart);
  const macroEnd = macroTail.indexOf('\n];');
  const macroBody = macroEnd === -1 ? macroTail : macroTail.slice(0, macroEnd);
  const wiredNames = [...macroBody.matchAll(/\(\s*"([^"]+)"\s*,/g)].map((m) => m[1]);

  const registryNames = [...read(registryRel).matchAll(/command:\s*'([^']+)'/g)].map((m) => m[1]);
  const snapshotNames = [...read(snapshotRel).matchAll(/\bentry\('([^']+)'/g)].map((m) => m[1]);

  const uniq = (list) => [...new Set(list)];
  const diff = (a, b) => {
    const other = new Set(b);
    return uniq(a).filter((x) => !other.has(x));
  };

  const manifestNames = manifestEntries.map((e) => e.name);
  const manifestRegistered = manifestEntries.filter((e) => e.registered).map((e) => e.name);

  // ① 声明面（registered=true）↔ 实装面：任一方向缺失都是「登记与实际脱节」
  const declaredNotWired = diff(manifestRegistered, wiredNames);
  const wiredNotDeclared = diff(wiredNames, manifestRegistered);
  if (declaredNotWired.length > 0 || wiredNotDeclared.length > 0) {
    fail(
      `D11: manifest 声明面与 main.rs command_registry! 实装面不一致——` +
        ` 声明未实装：${declaredNotWired.join(' / ') || '（无）'}；` +
        ` 实装未声明：${wiredNotDeclared.join(' / ') || '（无）'}。` +
        ` 改注册面必须同步 command_manifest.rs 条目与 registered 标志`
    );
  } else {
    ok(`D11: manifest 声明面与 main.rs command_registry! 实装面一致（${uniq(wiredNames).length} 条）`);
  }

  // ② 前端注册表全量对齐（双向）
  const feMissing = diff(manifestNames, registryNames);
  const feExtra = diff(registryNames, manifestNames);
  if (feMissing.length > 0 || feExtra.length > 0) {
    fail(
      `D11: ${registryRel} 与 manifest 不一致——` +
        ` 前端缺登记：${feMissing.join(' / ') || '（无）'}；` +
        ` 前端多登记：${feExtra.join(' / ') || '（无）'}。` +
        ` 该文件头部声明与 manifest / 内置快照「三方对齐」，缺一即漂移`
    );
  } else {
    ok(`D11: 前端注册表与 manifest 全量对齐（${uniq(registryNames).length} 条）`);
  }

  // ③ 前端内置快照全量对齐（双向）
  const snapMissing = diff(manifestNames, snapshotNames);
  const snapExtra = diff(snapshotNames, manifestNames);
  if (snapMissing.length > 0 || snapExtra.length > 0) {
    fail(
      `D11: ${snapshotRel} 与 manifest 不一致——` +
        ` 快照缺登记：${snapMissing.join(' / ') || '（无）'}；` +
        ` 快照多登记：${snapExtra.join(' / ') || '（无）'}`
    );
  } else {
    ok(`D11: 前端内置快照与 manifest 全量对齐（${uniq(snapshotNames).length} 条）`);
  }

  // ④ 四方各自无重名（重复登记会让条数公式与运行时对照同时失真）
  const dupReports = [];
  for (const [label, list] of [
    ['manifest', manifestNames],
    ['main.rs 实装面', wiredNames],
    ['前端注册表', registryNames],
    ['前端内置快照', snapshotNames],
  ]) {
    const seen = new Set();
    const dups = new Set();
    for (const n of list) {
      if (seen.has(n)) dups.add(n);
      seen.add(n);
    }
    if (dups.size > 0) dupReports.push(`${label}: ${[...dups].join(' / ')}`);
  }
  if (dupReports.length > 0) {
    fail(`D11: 命令重复登记——${dupReports.join('；')}`);
  } else {
    ok('D11: 四方命令名各自唯一（无重复登记）');
  }

  // ⑤ 前端调用面 ⊆ manifest（**退役命令漏改调用点的唯一自动捕获面**）
  //    —— 由既有门禁承担，本脚本**不重复造扫描逻辑**（同 D10 模式）。
  //
  // D1 用**标识符**匹配退役符号，抓不到以**字符串字面量**出现的命令名。
  // 同一方向（前端 invoke 字面量 ⊆ Rust 权威集）的扫描已由既有门禁
  // apps/crish-desktop/src/api/transport/command-contract-drift.test.ts 的
  // 「断言一（零断链）」承担，且覆盖面更全（另有「断言二（零幽灵）」与动态拼接面）。
  //
  // 实证 2026-09-15：本脚本此前自建一份同向扫描 + D11_RETIRED_CALL_DEBT 棘轮，
  // 与既有门禁**豁免口径不同** → 两处结论互相打架：本脚本只红在「注释里的
  // `invoke('X'` 示例」这一假阳性上，而真断链 `catalog_get` / `catalog_refresh`
  // 被棘轮登记成「已知债务」，修掉假阳性后本脚本会**转绿并掩盖真缺陷**。
  // 重复门禁属反过度设计红线：删除自建扫描与棘轮，只守既有门禁的**存在性与注册**。
  //
  // 解析不到即**显式 FAIL**（防正则失配假绿）。
  const driftRel = 'apps/crish-desktop/src/api/transport/command-contract-drift.test.ts';
  if (!fs.existsSync(path.join(REPO_ROOT, driftRel))) {
    fail(
      `D11: 既有命令断链门禁 ${driftRel} 不存在——` +
        ` 前端调用面 ⊆ manifest 的唯一自动捕获面被删/改名，退役命令漏改调用点将无门禁可拦`
    );
  } else {
    const driftSrc = read(driftRel);
    const missingAssertions = [
      { name: '断言一（零断链：前端 invoke 字面量 ⊆ Rust 注册键集）', re: /断言一（零断链）/ },
      { name: '断言二（零幽灵：注册键集 ⊆ 前端字面量 ∪ 显式豁免集）', re: /断言二（零幽灵）/ },
    ].filter((a) => !a.re.test(driftSrc));
    if (missingAssertions.length > 0) {
      fail(
        `D11: ${driftRel} 缺少${missingAssertions.map((a) => a.name).join(' / ')}——` +
          ` 命令契约门禁被弱化/改名后，本防线的「已委托既有门禁」会变成空头承诺`
      );
    } else {
      // 注册入口：必须由 package.json 的 vitest 全量入口承载，且在
      // FULL_CHECK_COMMANDS.md 登记；同时 vitest 的 include 必须**覆盖该文件**
      // （存在但从不执行 = 幽灵门禁，等于没有门禁）。
      const pkgScripts = JSON.parse(read('package.json')).scripts ?? {};
      const fullDoc = read('FULL_CHECK_COMMANDS.md');
      const vitestEntries = Object.entries(pkgScripts).filter(([, cmd]) =>
        /^vitest\s+run\b/.test(String(cmd).trim())
      );
      const registeredEntry = vitestEntries.find(([name]) =>
        fullDoc.includes(`npm run ${name}`)
      );
      const includeGlobs = [
        ...read('vitest.config.ts').matchAll(/include:\s*\[([\s\S]*?)\]/g),
      ].flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((g) => g[1]));

      if (!registeredEntry || includeGlobs.length === 0) {
        fail(
          `D11: 未能解析既有门禁的注册入口（package.json vitest 入口：` +
            `${vitestEntries.map(([n]) => n).join(' / ') || '（无）'}；` +
            `其中登记在 FULL_CHECK_COMMANDS.md 的：${registeredEntry?.[0] ?? '（无）'}；` +
            `vitest include glob：${includeGlobs.length} 条）——` +
            ` 注册面形态变更时本防线会假绿，请同步正则`
        );
      } else if (!includeGlobs.some((g) => g.includes('.test.') && globMatch(g, driftRel))) {
        fail(
          `D11: ${driftRel} 未被 vitest 入口 \`npm run ${registeredEntry[0]}\` 的 include 覆盖——` +
            ` 存在但从不执行的幽灵门禁等于没有门禁`
        );
      } else {
        ok(
          `D11: 前端调用面断链守卫委托既有门禁 ${driftRel}（断言一/断言二齐备，` +
            `经 \`npm run ${registeredEntry[0]}\` 注册并覆盖；本脚本不重复造扫描）`
        );
      }
    }
  }
}

/* ── D12 资产防线（门禁脚本必须可入库；干净检出可执行） ─────────── */

{
  // 门禁资产 = package.json `scripts` 引用的脚本 + FULL_CHECK_COMMANDS.md
  // 注册的命令 + 本防御网脚本自身。两条判据：
  //   ① 路径存在——干净检出后门禁不得因缺文件而断（硬红）；
  //   ② 未被 .gitignore 永久排除——「存在但永远进不了库」的幽灵脚本（硬红）。
  // 未跟踪但未被忽略 = 待提交的正常开发态，不算违规（新脚本先写后提交）。
  const SCRIPT_REF = /(?:^|[\s`'"])(scripts\/[\w./-]+\.(?:mjs|js|cjs|ps1))/g;
  const referenced = new Set();

  const pkg = JSON.parse(read('package.json'));
  for (const cmd of Object.values(pkg.scripts ?? {})) {
    for (const m of String(cmd).matchAll(SCRIPT_REF)) referenced.add(m[1]);
  }
  for (const m of read('FULL_CHECK_COMMANDS.md').matchAll(/`([^`\n]+)`/g)) {
    for (const r of m[1].matchAll(SCRIPT_REF)) referenced.add(r[1]);
  }
  referenced.add('scripts/check-provider-single-track.mjs');

  const inGitRepo = gitOut(['rev-parse', '--is-inside-work-tree']) === 'true';
  const missing = [];
  const ghosts = [];
  for (const rel of [...referenced].sort()) {
    if (!fs.existsSync(path.join(REPO_ROOT, rel))) {
      missing.push(rel);
      continue;
    }
    // 幽灵判据 = 「git 未跟踪」且「被忽略规则命中」：两者同时成立才永远入不了库。
    const tracked = gitOut(['ls-files', '--error-unmatch', '--', rel]) !== '';
    const ignored = gitOut(['check-ignore', '--', rel]) !== '';
    if (inGitRepo && !tracked && ignored) ghosts.push(rel);
  }

  if (missing.length > 0) {
    fail(
      `D12: 门禁清单引用了不存在的脚本：${missing.join(' / ')}——` +
        ` 干净检出后门禁直接断裂（package.json / FULL_CHECK_COMMANDS.md 与磁盘不一致）`
    );
  } else {
    ok(`D12: 门禁脚本引用全部存在（${referenced.size} 个）`);
  }

  if (!inGitRepo) {
    ok('D12: 非 git 工作区，跳过可入库性核验');
  } else if (ghosts.length > 0) {
    fail(
      `D12: 门禁脚本被 .gitignore 永久排除（存在但入不了库）：${ghosts.join(' / ')}——` +
        ` 需在 .gitignore 补 \`!<path>\` 显式放行，或从 package.json / FULL_CHECK_COMMANDS.md 摘除引用`
    );
  } else {
    ok('D12: 门禁脚本均可入库（无被忽略的幽灵脚本）');
  }
}

/* ── 出口 ────────────────────────────────────────────────────── */

if (failures.length > 0) {
  console.error(`\ncheck-provider-single-track：${failures.length} 条断言失败`);
  process.exit(1);
}
console.log('\ncheck-provider-single-track：全部通过');
