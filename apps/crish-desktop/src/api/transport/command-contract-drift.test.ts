/**
 * 命令契约漂移总门禁（T-F 06 T5.1，对齐 04 方案步骤 6）。
 *
 * 断言一（零断链）：每个前端 invoke 字面量 ∈ Rust 注册键集（main.rs
 * command_registry! 注册宏；rename 后 wire 键 = 宏名 = manifest 名）。
 * 断言二（零幽灵）：注册键集 ⊆ 前端 invoke 字面量 ∪ 显式豁免集。
 *
 * 抽取面：
 * - Rust 真源：`main.rs` 注册宏 `("name", path)` 元组 + `command_manifest.rs`
 *   registered=true 条目（对齐 commandManifest.test.ts 的 locateRepoRoot +
 *   extractRustManifestNames 先例；读失败 fail 不 skip + 哨兵计数防摆设化）；
 * - 前端：扫描 `apps/crish-desktop/src` 生产文件（排除 `*.test.ts`、
 *   `test-setup*`、`generated/`），正则匹配 `invoke('X'` / `invokeTyped('X'` /
 *   `invokeResult('X'` / `transport.request('X'` /
 *   `transport.send('X'` 的字符串字面量（含跨行参数形态：调用名在下一行）；
 * - 动态拼接：当前启动链路无 `invoke(\`...\`)` 模板串，断言 0 个动态拼接
 *   （出现动态拼接需显式登记白名单，04 ⑥-7 风险）。
 *
 * 豁免集（每条注释理由；幽灵清零后应趋空）：
 * - workbench_open_path_default / workbench_open_host_target / workbench_run_shell
 *   / workbench_apply_update / browser_*：GUI 专属入口，经组件/动态路径调用
 *   （tauriTransport / hostOpenersApi 等）——见下方逐条理由。
 *
 * 有效性自证：临时改一个前端调用名 / 加一条 Rust 注册 → 断言立即红。
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
 * 从前端生产代码抽取 invoke 字面量。
 * 算法：定位调用名（invoke/invokeTyped/invokeResult/tryInvokeTauri/
 * transport.request/send/call）→ 取其后第一个 `(` → 括号内第一个命令名字面量。
 * 这样泛型（`invokeResult<{ status: 'ok' }>`）内的字符串不会误配为命令名，
 * 跨行调用（调用名与命令名不同行）同样覆盖。
 * 附加面：`const X = 'cmd'` 常量定义（间接调用——消费方以常量名 invoke，
 * 如 BROWSER_START_CMD / FLOW_SNAPSHOT_CMD，04 ⑥-7 动态拼接白名单的同类）。
 * 动态拼接模板串（`invoke(` 后跟 ` 或 ${）单独计数。
 */
function extractFrontendInvokeNames(): {
  names: string[];
  dynamicTemplates: number;
} {
  const names = new Set<string>();
  let dynamicTemplates = 0;
  const callRe =
    /\b(invoke|invokeTyped|invokeResult|tryInvokeTauri|(?:getTransport\(\)|transport)\.(?:request|send|call))\b(?!\s*,)/g;
  const cmdRe = /'([a-z][a-z0-9_-]*)'/g;
  // 命令形态前缀：抽取到的字面量必须是命令名形态（tauriInvoke.ts 内部
  // `invoke(cmd, args)` 变量参数调用、`status: 'ok'` 等通用字符串不是命令）
  const COMMAND_PREFIX_RE =
    /^(core_|workbench_|config_|provider_|multi_device_|browser_|note_|usage_|auth_|list_|get_|load_|save_|set_|import_|cleanup_|touch_|upsert_|trash_|catalog_|create-|update-|delete-|list-|trigger-|computer_|kill_|resume_)/;
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
      }
    }
    // 常量间接调用面（`const BROWSER_START_CMD = 'browser_start'`）
    let cm: RegExpExecArray | null;
    while ((cm = constRe.exec(src)) !== null) {
      if (cm[1] !== undefined && COMMAND_PREFIX_RE.test(cm[1]))
        names.add(cm[1]);
    }
    dynamicTemplates += src.match(templateRe)?.length ?? 0;
  }
  return { names: [...names].sort(), dynamicTemplates };
}

/** 幽灵豁免集：注册键无前端静态字面量时的显式豁免（每条注释理由；
 *  幽灵清零后应趋空，新增豁免必须同轮登记 changelog） */
const GHOST_EXEMPTIONS: ReadonlySet<string> = new Set([
  // ── 动态拼接面（04 ⑥-7：运行时映射，非静态字面量）──
  // core_run_control / core_cancel_run：runControlClient.ts:104-105 由
  // `{ type: 'run-control' | 'cancel-run' }` 运行时映射命令名后经
  // transport.send(cmd, rest) 发送（产品路径只走 compositionRoot.runControl）
  'core_run_control',
  'core_cancel_run',
  // ── 多端与查询面（F-03 DM-07 恢复激活，供多端与调试消费）──
  'core_read_run_events',
  // ── 登记先行面（有真实消费意图但未接线，接线后移除豁免）──
  // config_get_outputs_root / config_set_outputs_root / set_session_output_root：
  // G03 产出根两级配置（T-EG-12），前端设置面接线中（agentOutputsRoot 设置项）
  'config_get_outputs_root',
  'config_set_outputs_root',
  'set_session_output_root',
  // workbench_select_folder：原生目录选择器（PE-07 T07.2 唯一「新授权」入口），
  // 前端经 openDirectoryDialogSafe 动态触发（对话框后段），非静态字面量
  'workbench_select_folder',
  // workbench_http_request：原生通用出站代理通道，保留供扩展与备用网络探测
  'workbench_http_request',
  // ── 退役面（computer-panel 旧投屏残留已物理删除，Rust 侧命令面仍登记）──
  // computer_session_enable / computer_session_disable / computer_status：
  // 原生浏览器与面板标准化战役（决策 1 同类退役）——computer-panel 前端壳
  // （ComputerPanel / useComputerSession / computerPanelLib / computerSessionApi）
  // 已删净，前端无静态字面量消费；Rust 侧 computer_commands.rs 命令面仍登记，
  // 由并行域退役后从豁免集移除（对齐 computer_estop 退役先例）
  'computer_session_enable',
  'computer_session_disable',
  'computer_status',
]);

describe('T-F 06 T5.1 命令契约漂移总门禁', () => {
  const registry = extractRegistryNames().sort();
  const manifestRegistered = extractManifestRegisteredNames().sort();

  it('哨兵：注册宏抽取数 ≥ 80 且 == manifest registered 数（防正则漂移摆设化）', () => {
    expect(registry.length).toBeGreaterThanOrEqual(80);
    expect(registry).toEqual(manifestRegistered);
  });

  it('断言一（零断链）：前端 invoke 字面量全部 ∈ Rust 注册键集', () => {
    const { names } = extractFrontendInvokeNames();
    const registered = new Set([...registry, ...manifestRegistered]);
    const broken = names.filter((n) => !registered.has(n));
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

  it('动态拼接面：当前启动链路全静态，0 个 invoke(` 模板串', () => {
    const { dynamicTemplates } = extractFrontendInvokeNames();
    expect(
      dynamicTemplates,
      '出现动态拼接 invoke 模板串必须显式登记白名单（04 ⑥-7）'
    ).toBe(0);
  });
});
