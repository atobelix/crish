/**
 * 命令契约漂移总门禁（T-F 06 T5.1，对齐 04 方案步骤 6）。
 *
 * 断言一（零断链）：每个前端 invoke 字面量 ∈ Rust 注册键集（main.rs
 * command_registry! 注册宏；rename 后 wire 键 = 宏名 = manifest 名）。
 * 断言二（零幽灵）：注册键集 ⊆ 前端 invoke 字面量 ∪ 显式豁免集。
 *
 * ── 断言一当前状态：**红**，且不得「修绿」────────────────────────────
 * 断链集 = `catalog_get` / `catalog_refresh`（真缺陷）：Rust 侧
 * `catalog_commands.rs` 已物理删除、`main.rs` 无注册，而前端消费面仍在调
 * （`modelCatalogIpc.ts:107` / `:236`、`thinkingGear.ts:208`）。
 * 由 04 方案**阶段 3**（Rust 注册内置目录读面 + 前端改调）修复。
 * **严禁**用「加豁免 / 改前端调用名」把它变绿——那正是本门禁要拦的作弊面；
 * 新增断链（超出已知两条）由下方「已知断链棘轮」断言单独拦截。
 *
 * 抽取面：
 * - Rust 真源：`main.rs` 注册宏 `("name", path)` 元组 + `command_manifest.rs`
 *   registered=true 条目（对齐 commandManifest.test.ts 的 locateRepoRoot +
 *   extractRustManifestNames 先例；读失败 fail 不 skip + 哨兵计数防摆设化）；
 * - 前端：扫描 `apps/crish-desktop/src` 生产文件（排除 `*.test.ts`、
 *   `test-setup*`、`generated/`），正则匹配 `invoke('X'` / `invokeTyped('X'` /
 *   `invokeResult('X'` / `transport.request('X'` /
 *   `transport.send('X'` 的字符串字面量（含跨行参数形态：调用名在下一行）；
 *   **注释先剥离**（块注释 + 行注释），故注释里的 `invoke('X'` 示例不产生
 *   假阳性（04 方案阶段 2 假阳性根因 ①；口径同
 *   `scripts/check-provider-single-track.mjs` 的 stripComments）；
 * - 动态拼接：当前启动链路无 `invoke(\`...\`)` 模板串，断言 0 个动态拼接
 *   （出现动态拼接需显式登记白名单，04 ⑥-7 风险）。
 *
 * 豁免面（04 方案阶段 2 根因 ④「豁免掩盖」→ 逐条复核后**三分**）：
 * - `JUSTIFIED_EXEMPTIONS`（A 类）：确证「非注册未消费」的正当豁免，
 *   每条必须带 `reason`（证据）+ `expiry`（可判定的到期条件）；
 * - `DRIFT_DEBT`（B 类·幽灵侧）：**真漂移**（Rust 有注册 + 前端生产代码零消费），
 *   显式登记为「目标 0 的债务」，**不再静默豁免**；每条带证据 / 责任方 /
 *   到期条件，并由「债务棘轮」断言锁上限（只降不升）。
 *   退役受制于四方对齐（`main.rs` + `command_manifest.rs` + 实现文件 +
 *   `commandManifest.ts` + `tauri-command-registry.ts` ≥ 5 文件，D11 防线
 *   双向全量对齐）——**超出本测试文件域**，故如实登记而非擅自删；
 * - `ENGINE_API_DEBT`（B 类·断链侧）：`config_get` / `config_update`。
 *   **原理由「引擎 REST、非 Tauri 命令」经复核不成立**（`transport.request`
 *   恒路由 Tauri IPC；`command_manifest.rs:326` 记载该族已退役）⇒ 实为真断链，
 *   同样登记为「目标 0 的债务」并锁上限。原「无条件套用」已收紧为
 *   「只在 `transport.*` 形态生效」，封死「塞进豁免表即变绿」的作弊面。
 *
 * 有效性自证：临时改一个前端调用名 / 加一条 Rust 注册 → 断言立即红；
 * 把真 Tauri 命令名塞进豁免表 → 断言一不变绿（作用域收紧 + 债务自证）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MAIN_RS_REL = 'apps/agent-workbench/src-tauri/src/main.rs';
const MANIFEST_RS_REL =
  'apps/agent-workbench/src-tauri/src/command_manifest.rs';
const FRONTEND_ROOT_REL = 'apps/crish-desktop/src';

function locateRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (existsSync(join(dir, MAIN_RS_REL))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `无法定位仓库根：上溯未找到 ${MAIN_RS_REL}（起始于 ${dir}）`
      );
    }
    dir = parent;
  }
}

/** 从 main.rs command_registry! 抽取注册键（`("name", path)` 元组） */
function extractRegistryNames(): string[] {
  const file = join(locateRepoRoot(), MAIN_RS_REL);
  if (!existsSync(file)) {
    throw new Error(`Rust 真源缺失：${file}（契约门禁必须 fail，不得 skip）`);
  }
  const src = readFileSync(file, 'utf8');
  // 注册宏条目：先去注释，再精确截取 command_registry![ ... ]; 宏体
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const macroMatch = stripped.match(/command_registry!\s*\[([\s\S]*?)\];/);
  if (!macroMatch?.[1]) {
    throw new Error('未在 main.rs 中找到 command_registry! 宏调用块');
  }
  const macroBody = macroMatch[1];
  const re = /\(\s*"([a-z][a-z0-9_-]*)",/g;
  const names: string[] = [];
  for (const m of macroBody.matchAll(re)) {
    if (m[1] !== undefined) names.push(m[1]);
  }
  return names;
}

/** 从 command_manifest.rs 抽取 registered=true 条目 */
function extractManifestRegisteredNames(): string[] {
  const file = join(locateRepoRoot(), MANIFEST_RS_REL);
  if (!existsSync(file)) {
    throw new Error(`Rust 真源缺失：${file}（契约门禁必须 fail，不得 skip）`);
  }
  const src = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  // 尾逗号可选：多行缩进排版会带尾逗号（漏配会把该条静默挤出清单）
  const re = /entry\(\s*"([^"]+)",\s*"[^"]+",\s*"[^"]+",\s*true\s*,?\s*\)/g;
  const names: string[] = [];
  for (const m of src.matchAll(re)) {
    if (m[1] !== undefined) names.push(m[1]);
  }
  return names;
}

/** 递归收集前端生产文件（排除测试 / test-setup / generated） */
function collectFrontendFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSorted(dir)) {
    const full = join(dir, name);
    if (!existsSync(full)) continue;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (name === 'generated') continue;
      out.push(...collectFrontendFiles(full));
    } else if (
      /\.(ts|tsx|js|jsx)$/.test(name) &&
      !/\.test\./.test(name) &&
      !name.startsWith('test-setup') &&
      !name.startsWith('test-utils')
    ) {
      out.push(full);
    }
  }
  return out;
}

import { readdirSync, statSync } from 'node:fs';
function readdirSorted(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/**
 * 从前端生产代码抽取 invoke 字面量，并按**调用形态**分桶。
 *
 * 算法：定位调用名（invoke/invokeTyped/invokeResult/tryInvokeTauri/
 * transport.request/send/call）→ 取其后第一个 `(` → 括号内第一个命令名字面量。
 * 这样泛型（`invokeResult<{ status: 'ok' }>`）内的字符串不会误配为命令名，
 * 跨行调用（调用名与命令名不同行）同样覆盖。
 *
 * 分桶（04 方案阶段 2 根因 ④：引擎 REST 豁免不得无条件套用）：
 * - `transportNames`：经 `transport.request/send/call`（引擎 REST 面）形态
 *   出现的命令名——**只有该形态**才可能适用 `ENGINE_API_EXEMPTIONS`；
 * - `invokeFormNames`：经 `invoke*` / `callSnapshot` / `const X = 'cmd'`
 *   常量面出现的命令名——这些是**真 Tauri 调用**，豁免一律不适用
 *   （封死「把真 Tauri 命令名塞进豁免表即变绿」的作弊空间）；
 * - `names`：两者并集（断言一/二的既有口径，不缩水）。
 *
 * 附加面：`const X = 'cmd'` 常量定义（间接调用——消费方以常量名 invoke，
 * 如 BROWSER_START_CMD / FLOW_SNAPSHOT_CMD，04 ⑥-7 动态拼接白名单的同类）。
 * 动态拼接模板串（`invoke(` 后跟 ` 或 ${）单独计数。
 */
function extractFrontendInvokeNames(): {
  names: string[];
  transportNames: string[];
  invokeFormNames: string[];
  dynamicTemplates: number;
} {
  const names = new Set<string>();
  const transportNames = new Set<string>();
  const invokeFormNames = new Set<string>();
  let dynamicTemplates = 0;
  const callRe =
    // `callSnapshot` = modelsCatalogIpc 的命令调用薄封装（`callSnapshot('cmd', args, ...)`）。
    // 漏掉它会把「经该封装调用」的命令误判为幽灵命令（实证 2026-09-15：
    // workbench_read_models_yaml / workbench_apply_models_config 已被消费却仍报幽灵）。
    /\b(invoke|invokeTyped|invokeResult|tryInvokeTauri|callSnapshot|(?:getTransport\(\)|transport)\.(?:request|send|call))\b(?!\s*,)/g;
  const cmdRe = /'([a-z][a-z0-9_-]*)'/g;
  // 命令形态前缀：抽取到的字面量必须是命令名形态（tauriInvoke.ts 内部
  // `invoke(cmd, args)` 变量参数调用、`status: 'ok'` 等通用字符串不是命令）
  const COMMAND_PREFIX_RE =
    /^(core_|workbench_|config_|provider_|multi_device_|browser_|note_|usage_|auth_|prefs_|list_|get_|load_|save_|set_|import_|cleanup_|touch_|upsert_|trash_|catalog_|create-|update-|delete-|list-|trigger-|computer_|kill_|resume_)/;
  // 引擎 REST 形态（`transport.request(` / `transport.send(` / `transport.call(` /
  // `getTransport().request(` …）——`ENGINE_API_DEBT` 豁免的唯一作用域
  // （该豁免为「目标 0 的债务」而非正当豁免，见其块注释）
  const TRANSPORT_FORM_RE = /^(?:getTransport\(\)|transport)\./;
  const constRe = /\bconst\s+[A-Z][A-Z0-9_]*\s*=\s*'([a-z][a-z0-9_-]*)'/g;
  const templateRe =
    /\b(invoke|invokeTyped|invokeResult|transport\.request|transport\.send)\s*\(\s*`/g;
  for (const file of collectFrontendFiles(
    join(locateRepoRoot(), FRONTEND_ROOT_REL)
  )) {
    const src = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(src)) !== null) {
      // import 标识符（`import { invokeTyped } from '...'`）不是调用点：
      // 以行级排除（行内含 import 声明）
      const lineStart = src.lastIndexOf('\n', m.index) + 1;
      const lineEnd = src.indexOf('\n', m.index);
      const line = src.slice(lineStart, lineEnd < 0 ? src.length : lineEnd);
      if (/^\s*import\b/.test(line)) continue;
      const openParen = src.indexOf('(', m.index + m[0].length);
      if (openParen < 0) continue;
      // 校验调用名 → `(` 之间只允许类型片段（泛型/空白/类型字符，
      // 含数组 `[]`、字面量类型 `'ok'` 与类型分隔 `;`）；
      // import 标识符（`invokeTyped } from '...';` / 多行 import 的
      // `invokeTyped,` / `invokeTyped }`）不是调用点——`from` 拦截
      const between = src.slice(m.index + m[0].length, openParen);
      if (
        !/^[\s<>{}?:,|&'"[\]\w;]*$/.test(between) ||
        /\bfrom\b/.test(between)
      ) {
        continue;
      }
      // 括号内 200 字符内找第一个命令名字面量（命令名通常是第一个参数）；
      // 非命令形态（变量参数 `invoke(cmd, args)` / `status: 'ok'`）过滤
      const window = src.slice(openParen + 1, openParen + 1 + 200);
      const cmd = cmdRe.exec(window);
      cmdRe.lastIndex = 0;
      if (cmd?.[1] !== undefined && COMMAND_PREFIX_RE.test(cmd[1])) {
        names.add(cmd[1]);
        if (TRANSPORT_FORM_RE.test(m[0])) transportNames.add(cmd[1]);
        else invokeFormNames.add(cmd[1]);
      }
    }
    // 常量间接调用面（`const BROWSER_START_CMD = 'browser_start'`）：
    // 常量名 invoke 属真 Tauri 调用形态，不计入 transportNames
    let cm: RegExpExecArray | null;
    while ((cm = constRe.exec(src)) !== null) {
      if (cm[1] !== undefined && COMMAND_PREFIX_RE.test(cm[1])) {
        names.add(cm[1]);
        invokeFormNames.add(cm[1]);
      }
    }
    dynamicTemplates += src.match(templateRe)?.length ?? 0;
  }
  return {
    names: [...names].sort(),
    transportNames: [...transportNames].sort(),
    invokeFormNames: [...invokeFormNames].sort(),
    dynamicTemplates,
  };
}

/** 引擎 REST 豁免债务：`config_get` / `config_update`。目标 = 0。 */
interface EngineApiDebt {
  readonly command: string;
  /** 证据：为何本条被豁免、以及豁免是否成立（须可复核） */
  readonly evidence: string;
  readonly owner: string;
  readonly expiry: string;
}

/**
 * 引擎 REST 豁免债务表（04 方案阶段 2 根因 ④ 的收紧 + 如实登记对象）。
 *
 * **原注释（2026-09-15 前）自述**：「引擎侧 REST API（经 `transport.request`
 * 调用）不是 Tauri 命令」。**该理由经复核不成立**（2026-09-15 实证）：
 * 1. `transport.request` **恒路由到 Tauri IPC**：`transport/index.ts:4`
 *    「Tauri IPC 为唯一路径，无 WS 回退」；`tauriTransport.ts:215-224`
 *    `request()` → `resolveTauriCommand(type)` → 未注册即抛
 *    `Tauri command not available`；
 * 2. `resolveTauriCommand` 的真源 = 运行时 `core_list_commands` 清单
 *    （`commandManifest.ts:283` `isRegisteredCommand`），而
 *    `command_manifest.rs:326` 明确记载「单轨收敛**退役**
 *    `config_get`/`update`/`profile_apply` 旧命令族」；
 * 3. ⇒ `loadEngineConfig()`（`engineConfigIO.ts:99-100`）恒抛并被 catch
 *    吞成 `null`；`updateEngineConfig()`（`:127`）恒返回 `{ok:false}`。
 *    **即两条真断链**（消费了但没有注册），而非正当豁免。
 *
 * 处置：**优先 ①（删除前端死调用或改经引擎 REST HTTP 面消费）不在本测试
 * 文件域**（`engineConfigIO.ts` / 引擎 REST 面属他人文件域），故按战役规则
 * ②登记为**目标 0 的债务**：作用域收紧为「只在 `transport.*` 形态生效」
 * （封死 `invoke(` 形态的豁免作弊面），并由债务上限棘轮锁定（只降不升）。
 */
const ENGINE_API_DEBT: readonly EngineApiDebt[] = [
  {
    command: 'config_get',
    evidence:
      '前端消费：`engineConfigIO.ts:99-100` `transport.request(\'config_get\')`；' +
      'Rust 侧**已退役**（`command_manifest.rs:326` 记载退役；注册面无此键）。' +
      'REST 孪生 `GET /v1/settings` 存在于 `server/backend.rs:205` / ' +
      '`server/core_backend.rs:759`，但前端未经 HTTP 面消费 ⇒ 该调用恒抛。',
    owner: '引擎配置读面（P2-8 补读面 / R1-04 引擎 REST 面）',
    expiry:
      '前端改经引擎 REST HTTP 面消费（或删除 `loadEngineConfig` 死调用）后' +
      '删除本条；届时 `config_get` 不再是前端调用名，断言一自然不含它。',
  },
  {
    command: 'config_update',
    evidence:
      '前端消费：`engineConfigIO.ts:127` `transport.request(\'config_update\')`；' +
      'Rust 侧**已退役**（`command_manifest.rs:326`；注册面无此键）。' +
      'REST 孪生 `PUT /v1/settings` 存在于 `server/backend.rs:217` ⇒ 同 `config_get`，' +
      '当前经 Tauri IPC 恒抛，`updateEngineConfig` 恒返回 `{ok:false}`。',
    owner: '引擎配置写面（R1-04 引擎 REST 面）',
    expiry:
      '前端改经引擎 REST HTTP 面消费（或删除 `updateEngineConfig` 死调用）后删除本条。',
  },
];

/** 断言一使用的豁免键集（= 引擎 REST 债务，作用域见断言一） */
const ENGINE_API_EXEMPTIONS: ReadonlySet<string> = new Set(
  ENGINE_API_DEBT.map((d) => d.command)
);

/** 引擎 REST 债务上限棘轮（目标 0）：只降不升。 */
const ENGINE_API_DEBT_CEILING = 2;

/** 正当豁免（A 类）：确证「非注册未消费」。每条必须带 reason + expiry。 */
interface JustifiedExemption {
  readonly command: string;
  /** 为什么它不是「Rust 注册但前端零消费」——必须可复核（文件:行号） */
  readonly reason: string;
  /** 可判定的到期条件：满足即删除本条（不允许无限期豁免） */
  readonly expiry: string;
}

const JUSTIFIED_EXEMPTIONS: readonly JustifiedExemption[] = [
  {
    command: 'workbench_window_ready',
    reason:
      '窗口首绘显现门闩：由 `public/loader.js:33` 骨架屏直出调用' +
      '（`window.__TAURI_INTERNALS__.invoke(\'workbench_window_ready\')`），' +
      '`public/` 不在本门禁扫描面（本门禁只扫 `apps/crish-desktop/src`）' +
      '——非「注册未消费」，故属正当豁免。',
    expiry:
      'loader.js 迁入 `apps/crish-desktop/src` 扫描面（或骨架屏改为 src 侧调用）' +
      '后删除本条：届时该命令应被静态抽取面覆盖，无需豁免。',
  },
];

/** 真漂移债务（B 类）：Rust 有注册 + 前端生产代码零消费。目标 = 0。 */
interface DriftDebt {
  readonly command: string;
  /** 证据：Rust 注册点 + 「前端零消费」的复核方式（文件:行号 / 命令） */
  readonly evidence: string;
  /** 责任方：应由谁接线或退役 */
  readonly owner: string;
  /** 可判定的到期条件：接线（本条删除）或退役（本条随命令一并删除） */
  readonly expiry: string;
}

/**
 * 真漂移债务表（04 方案阶段 2 ④「掩盖项清零」的**如实登记**形态）。
 *
 * 为何不直接退役：退役一条命令必须同步五处
 * （`main.rs` + `command_manifest.rs` + 实现文件 + 前端 `commandManifest.ts` +
 * 前端 `tauri-command-registry.ts`），D11 防线要求四方**双向全量对齐**，
 * 改动面 ≥ 5 文件且跨 Rust / 前端两个文件域 —— 超出本测试文件域，
 * 故按战役规则「不得静默豁免」登记为**带到期条件的债务**，由责任方收口。
 * 上限由 `DRIFT_DEBT_CEILING` 棘轮锁定：只降不升，目标 0。
 */
const DRIFT_DEBT: readonly DriftDebt[] = [
  {
    command: 'core_read_run_events',
    evidence:
      'Rust 有注册：`main.rs:288-294` + `command_manifest.rs:164`' +
      '（F-03 DM-07「恢复激活」）+ `core_query_commands.rs:810`。' +
      '前端零消费：Tauri 侧 grep 命中 0；前端 REST 侧亦零命中。' +
      '注：引擎 REST 孪生 `GET /v1/runs/{id}/events` 已接线' +
      '（`server/backend.rs:90-92`、`server/router.rs:2214`），属**另一 wire 面**，' +
      '不能作为 Tauri 命令注册的消费方。',
    owner: 'F-03 DM-07（多端 / 调试消费面）',
    expiry:
      '前端 run 事件分页消费接线后删除本条；若确证仅供引擎 REST 面使用，' +
      '则 Tauri 侧退役该注册（含四方同步）后一并删除。',
  },
];

/** 债务上限棘轮（目标 0）：新增债务必须显式上调本常量，禁止静默扩张。 */
const DRIFT_DEBT_CEILING = 1;

/** 已知断链棘轮（04 阶段 3 修复前为红）：只允许减少，禁止新增。 */
const KNOWN_BROKEN: ReadonlySet<string> = new Set([
  'catalog_get',
  'catalog_refresh',
]);

/** 幽灵豁免全集 = A 类 ∪ B 类（断言二口径不变：注册键集 ⊆ 前端字面量 ∪ 本集） */
const GHOST_EXEMPTIONS: ReadonlySet<string> = new Set([
  ...JUSTIFIED_EXEMPTIONS.map((e) => e.command),
  ...DRIFT_DEBT.map((d) => d.command),
]);

describe('T-F 06 T5.1 命令契约漂移总门禁', () => {
  const registry = extractRegistryNames().sort();
  const manifestRegistered = extractManifestRegisteredNames().sort();

  it('哨兵：注册宏抽取数 ≥ 80 且 == manifest registered 数（防正则漂移摆设化）', () => {
    expect(registry.length).toBeGreaterThanOrEqual(80);
    expect(registry).toEqual(manifestRegistered);
  });

  it('断言一（零断链）：前端 invoke 字面量全部 ∈ Rust 注册键集', () => {
    // 唯一豁免面 = `ENGINE_API_DEBT`（`config_get` / `config_update`）。
    // ⚠️ 该豁免**不是「它们不是 Tauri 命令」**——2026-09-15 复核推翻了原理由：
    // `transport.request` 恒路由 Tauri IPC（`transport/index.ts:4`、
    // `tauriTransport.ts:215-224`），且 `command_manifest.rs:326` 记载该两命令
    // 已在单轨收敛中**退役** ⇒ 它们是**真断链**，此处仅按战役规则 ② 登记为
    // 「目标 0 的债务」（详见 `ENGINE_API_DEBT` 块注释与债务棘轮断言）。
    //
    // 作用域收紧（04 方案阶段 2 根因 ④）：豁免**只在 `transport.*` 调用形态下
    // 生效**——即该名字必须由 `transport.*` 形态抽取到（`transportNames`）。
    // 经 `invoke(` / `invokeTyped(` / `callSnapshot(` / `const X = 'cmd'` 出现的
    // 名字一律不豁免，故「把真 Tauri 命令名塞进豁免表即变绿」的作弊面已被封死
    // （另有「引擎 REST 豁免债务自证」断言双重锁定）。
    const { names, transportNames } = extractFrontendInvokeNames();
    const transportForm = new Set(transportNames);
    const registered = new Set([...registry, ...manifestRegistered]);
    const broken = names.filter(
      (n) =>
        !registered.has(n) &&
        !(ENGINE_API_EXEMPTIONS.has(n) && transportForm.has(n))
    );
    expect(
      broken,
      `前端调用名不在 Rust 注册面（断链）：${broken.join(', ')}` +
        '（改前端调用名必须同步 Rust 注册 / rename）'
    ).toEqual([]);
  });

  it('断言二（零幽灵）：注册键集 ⊆ 前端字面量 ∪ 显式豁免集', () => {
    const { names } = extractFrontendInvokeNames();
    const invoked = new Set(names);
    const ghosts = registry.filter(
      (n) => !invoked.has(n) && !GHOST_EXEMPTIONS.has(n)
    );
    expect(
      ghosts,
      `注册面幽灵命令（前端无消费）：${ghosts.join(', ')}` +
        '（须接线或退役，不得注册而不消费）'
    ).toEqual([]);
  });

  it('引擎 REST 豁免债务自证：仅限 transport.* 形态 / ∉invoke 形态 / ∉注册面', () => {
    const { transportNames, invokeFormNames } = extractFrontendInvokeNames();
    const transportForm = new Set(transportNames);
    const invokeForm = new Set(invokeFormNames);
    const registered = new Set(registry);
    // (a) 必须以 transport.* 形态出现（否则豁免无从作用，条目是死条目）；
    // (b) 不得以 invoke 形态出现（否则即真 Tauri 调用，必须修注册而非豁免）；
    // (c) 不得已注册（已注册则豁免冗余，必须删除条目）。
    const offenders = ENGINE_API_DEBT.filter(
      (d) =>
        !transportForm.has(d.command) ||
        invokeForm.has(d.command) ||
        registered.has(d.command)
    ).map((d) => d.command);
    expect(
      offenders,
      `引擎 REST 豁免债务条目未满足自证条件：${offenders.join(', ')}——` +
        '每条必须（a）以 `transport.request/send/call` 形态出现，' +
        '（b）不得以 invoke 形态出现，（c）不得已在 Rust 注册面；' +
        '任一不满足即应删除该豁免条目（真 Tauri 断链必须修 Rust 注册）'
    ).toEqual([]);
  });

  it('豁免表自洽：无僵尸（∉注册面）/ 无冗余（∈前端消费面）/ A∩B=∅ / 理由字段齐备', () => {
    const { names } = extractFrontendInvokeNames();
    const invoked = new Set(names);
    const registered = new Set(registry);

    // (C) 类防回归：注册面已无此键 ⇒ 豁免行是僵尸，必须删
    const zombie = [...GHOST_EXEMPTIONS].filter((n) => !registered.has(n));
    expect(
      zombie,
      `僵尸豁免（Rust 注册面已无此键，命令早被删除）：${zombie.join(', ')}` +
        '——必须直接删除该豁免行'
    ).toEqual([]);

    // 冗余防回归：前端已能静态抽到 ⇒ 豁免不必要，必须删（豁免只增不减 = 门禁退化）
    const redundant = [...GHOST_EXEMPTIONS].filter((n) => invoked.has(n));
    expect(
      redundant,
      `冗余豁免（前端已被静态抽取面覆盖，豁免无必要）：${redundant.join(', ')}` +
        '——必须删除该豁免行（删除只使门禁更严，不得保留）'
    ).toEqual([]);

    // A / B 二分必须互斥（同一条不得既称「正当」又称「债务」）
    const overlap = JUSTIFIED_EXEMPTIONS.map((e) => e.command).filter((n) =>
      DRIFT_DEBT.some((d) => d.command === n)
    );
    expect(
      overlap,
      `豁免分类重叠（同一条既在 A 类又在 B 类）：${overlap.join(', ')}`
    ).toEqual([]);

    // 理由字段齐备（04 方案阶段 2 验收：每条带「正当理由 + 到期条件」）
    const blankJustified = JUSTIFIED_EXEMPTIONS.filter(
      (e) => !e.command || !e.reason.trim() || !e.expiry.trim()
    ).map((e) => e.command || '(空)');
    const blankDebt = DRIFT_DEBT.filter(
      (d) =>
        !d.command ||
        !d.evidence.trim() ||
        !d.owner.trim() ||
        !d.expiry.trim()
    ).map((d) => d.command || '(空)');
    expect(
      { blankJustified, blankDebt },
      '豁免条目必须带齐「理由/证据 + 责任方 + 到期条件」字段，不得只写命令名'
    ).toEqual({ blankJustified: [], blankDebt: [] });
  });

  it('债务棘轮：真漂移债务只降不升（目标 0），且新增断链必须显式登记', () => {
    // 债务上限：新增债务必须显式上调 DRIFT_DEBT_CEILING（并在 changelog 登记），
    // 禁止「悄悄多加一条豁免」；目标 0 = 全部接线或退役。
    expect(
      DRIFT_DEBT.length,
      `真漂移债务 ${DRIFT_DEBT.length} 条 > 上限 ${DRIFT_DEBT_CEILING}：` +
        '不得新增豁免掩盖漂移（本战役禁止假接线：注册了就必须有消费方）'
    ).toBeLessThanOrEqual(DRIFT_DEBT_CEILING);

    // 引擎 REST 豁免债务同样只降不升（目标 0）
    expect(
      ENGINE_API_DEBT.length,
      `引擎 REST 豁免债务 ${ENGINE_API_DEBT.length} 条 > 上限 ` +
        `${ENGINE_API_DEBT_CEILING}：不得新增豁免掩盖断链`
    ).toBeLessThanOrEqual(ENGINE_API_DEBT_CEILING);

    // 债务条目必须唯一（重复登记会让上限棘轮失真）
    const dup = DRIFT_DEBT.map((d) => d.command).filter(
      (n, i, arr) => arr.indexOf(n) !== i
    );
    expect(dup, `债务表重复条目：${dup.join(', ')}`).toEqual([]);

    // 已知断链棘轮：断言一当前红于 catalog_get / catalog_refresh（真缺陷，
    // 由 04 阶段 3 修复）。本断言**不**替代断言一，只把「已知的两条」与
    // 「新发生的断链」区分开——超出已知集即红，杜绝静默新增。
    // 注：`config_get` / `config_update` 亦为真断链，但被 `ENGINE_API_DEBT`
    // 豁免（目标 0 的债务，见该块注释），故不出现在本断链集内。
    const { names, transportNames } = extractFrontendInvokeNames();
    const transportForm = new Set(transportNames);
    const registered = new Set([...registry, ...manifestRegistered]);
    const broken = names.filter(
      (n) =>
        !registered.has(n) &&
        !(ENGINE_API_EXEMPTIONS.has(n) && transportForm.has(n))
    );
    const unexpected = broken.filter((n) => !KNOWN_BROKEN.has(n));
    expect(
      unexpected,
      `新增断链（超出已知 ${[...KNOWN_BROKEN].join(' / ')}）：${unexpected.join(', ')}` +
        '——不得加豁免，必须同步 Rust 注册或改前端调用名'
    ).toEqual([]);
  });

  it('动态拼接面：当前启动链路全静态，0 个 invoke(` 模板串', () => {
    const { dynamicTemplates } = extractFrontendInvokeNames();
    expect(
      dynamicTemplates,
      '出现动态拼接 invoke 模板串必须显式登记白名单（04 ⑥-7）'
    ).toBe(0);
  });
});
