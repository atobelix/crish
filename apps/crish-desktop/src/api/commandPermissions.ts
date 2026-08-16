/**
 * 命令白名单：本机持久化 + 批准记忆（契约：LS + 桌面审批桥）
 *
 * - 匹配：仅「精确」或「token 边界前缀」（白名单后必须是空白再跟参数）
 * - 绝不做裸 startsWith：whitelist "git" 不得匹配 gitignore / git-status / git_status
 * - 不做反向「命令是白名单前缀」匹配（曾误伤，已移除）
 * - 不伪造工具输出；白名单 = 显示/记忆（记住用户批准过的命令），
 *   **不再参与自动放行判定**（P1 权限归一 B3：放行权威 = 引擎
 *   call_verdict / ApprovalGateImpl 单一裁决链）
 * - 与 permissionMode 配合：plan 模式仍不自动写操作（引擎侧为主）
 * - Windows：cmd /c、powershell -Command 包装、.exe 后缀、盘符路径在匹配变体中剥离
 */

export const COMMAND_PERMISSIONS_STORAGE_KEY = 'crish_command_permissions_v1';

const DEFAULT_SEED = [
  'git status',
  'git diff',
  'git log',
  'npm test',
  'npm run test',
];

type StorageGet = Pick<Storage, 'getItem'>;
type StorageSet = Pick<Storage, 'setItem'>;

function defaultStorage(): Storage | null {
  return typeof localStorage !== 'undefined' ? localStorage : null;
}

/** 将任意输入收成字符串；null/undefined/非字符串 → '' */
export function coerceCommandText(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (
    typeof input === 'number' ||
    typeof input === 'boolean' ||
    typeof input === 'bigint'
  ) {
    return String(input);
  }
  return '';
}

/**
 * 规范化命令串便于前缀匹配：折叠空白、去 $ 提示符、去首尾引号；空/null → ''。
 */
export function normalizeCommandLine(input: unknown): string {
  let s = coerceCommandText(input)
    .replace(/\r\n/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\$\s*/, '');
  // 整行外包一层引号（cmd /c "…" 解包后常见）
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    s = s.slice(1, -1).replace(/\s+/g, ' ').trim();
  }
  return s;
}

/**
 * 规范化白名单条目：折叠空白、去 $ 提示符；空串返回 ''。
 * 添加/持久化前统一走此路径，避免 "git  status" 与 "git status" 双条。
 */
export function sanitizeWhitelistEntry(raw: unknown): string {
  return normalizeCommandLine(raw);
}

// ── Windows / shell 包装剥离 ────────────────────────────────────────────────

/** 首 token 的 Windows 可执行后缀（仅匹配用，不改用户白名单原文） */
const WIN_EXE_SUFFIX = /\.(exe|cmd|bat|com|ps1)$/i;

/**
 * 去掉首 token 的 .exe/.cmd/.bat/.com/.ps1（支持带盘符/反斜杠路径）。
 * `git.exe status` → `git status`；`C:\Tools\git.exe status` → `C:\Tools\git status`
 */
export function stripWindowsExecutableExtension(command: unknown): string {
  const s = normalizeCommandLine(command);
  if (!s) return '';
  const m = s.match(/^(\S+)(\s+.*)?$/);
  if (!m) return s;
  const head = m[1] ?? '';
  const rest = m[2] ?? '';
  if (!WIN_EXE_SUFFIX.test(head)) return s;
  return `${head.replace(WIN_EXE_SUFFIX, '')}${rest}`
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 剥离 cmd.exe /c|k 与 powershell -Command|-EncodedCommand 等包装，露出内层命令。
 * 用于匹配变体；不修改白名单存储原文。
 */
export function unwrapShellWrapper(command: unknown): string {
  let s = normalizeCommandLine(command);
  if (!s) return '';

  // 多轮：cmd /c powershell -Command "…"
  for (let i = 0; i < 3; i += 1) {
    const before = s;
    // cmd[.exe] [/d] [/s] /c|/k <rest>（可选路径前缀）
    const cmdSimple = s.match(
      /^(?:[a-zA-Z]:[\\/])?(?:[^\\/:*?"<>|\s]+[\\/])*cmd(?:\.exe)?(?:\s+\/[dDsS])*\s+\/[cCkK]\s+(.+)$/i
    );
    if (cmdSimple?.[1]) {
      s = normalizeCommandLine(cmdSimple[1]);
    } else {
      // powershell[.exe] … -Command|-c <rest>  （排除 -EncodedCommand 由 deny 处理）
      const psM = s.match(
        /^(?:[a-zA-Z]:[\\/])?(?:[^\\/:*?"<>|\s]+[\\/])*(?:pwsh|powershell)(?:\.exe)?(?:\s+-[A-Za-z]+(?:\s+[^\s-][^\s]*)?)*\s+-(?:Command|c)\s+(.+)$/i
      );
      if (psM?.[1]) {
        s = normalizeCommandLine(psM[1]);
      }
    }
    if (s === before) break;
  }
  return s;
}

/**
 * 匹配用命令变体（去重保序）：原文规范化 → 去 .exe → 解 shell 包装 → 再去 .exe。
 * 任一变体命中白名单即可；极危判定对所有变体取最严。
 */
export function commandMatchVariants(command: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (v: string) => {
    const c = normalizeCommandLine(v);
    if (!c) return;
    const key = c.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };

  const base = normalizeCommandLine(command);
  push(base);
  push(stripWindowsExecutableExtension(base));
  const unwrapped = unwrapShellWrapper(base);
  push(unwrapped);
  push(stripWindowsExecutableExtension(unwrapped));
  // 再解一层包装（cmd /c "powershell -Command …"）
  const unwrapped2 = unwrapShellWrapper(unwrapped);
  push(unwrapped2);
  push(stripWindowsExecutableExtension(unwrapped2));
  return out;
}

// ── 白名单 CRUD ─────────────────────────────────────────────────────────────

export function loadCommandPermissions(
  storage: StorageGet | null | undefined = defaultStorage()
): string[] {
  try {
    const raw = storage?.getItem?.(COMMAND_PERMISSIONS_STORAGE_KEY);
    if (!raw) return [...DEFAULT_SEED];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [...DEFAULT_SEED];
    return dedupeWhitelist(arr.map((x) => coerceCommandText(x)));
  } catch {
    return [...DEFAULT_SEED];
  }
}

export function saveCommandPermissions(
  list: unknown,
  storage: StorageSet | null | undefined = defaultStorage()
): void {
  const cleaned = dedupeWhitelist(list);
  try {
    storage?.setItem?.(
      COMMAND_PERMISSIONS_STORAGE_KEY,
      JSON.stringify(cleaned)
    );
  } catch {
    /* swallow-ok: 白名单尽力写，quota/隐私模式失败时回退内存态 */
  }
}

/** 去重 + 规范化；保序。非数组 → [] */
export function dedupeWhitelist(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const c = sanitizeWhitelistEntry(raw);
    if (!c) continue;
    const key = c.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

export function addCommandPermission(
  list: unknown,
  cmd: unknown,
  storage: StorageSet | null | undefined = defaultStorage()
): string[] {
  const base = Array.isArray(list) ? list.map((x) => coerceCommandText(x)) : [];
  const c = sanitizeWhitelistEntry(cmd);
  if (!c) return dedupeWhitelist(base);
  if (
    base.some(
      (x) => sanitizeWhitelistEntry(x).toLowerCase() === c.toLowerCase()
    )
  ) {
    return dedupeWhitelist(base);
  }
  const next = dedupeWhitelist([...base, c]);
  saveCommandPermissions(next, storage);
  return next;
}

export function removeCommandPermission(
  list: unknown,
  cmd: unknown,
  storage: StorageSet | null | undefined = defaultStorage()
): string[] {
  const base = Array.isArray(list) ? list : [];
  const target = sanitizeWhitelistEntry(cmd).toLowerCase();
  if (!target) return dedupeWhitelist(base);
  const next = dedupeWhitelist(
    base.filter((x) => sanitizeWhitelistEntry(x).toLowerCase() !== target)
  );
  saveCommandPermissions(next, storage);
  return next;
}

/**
 * 命令是否以白名单项为「整 token」前缀。
 * - 精确相等
 * - 或白名单后紧跟空白（再接参数）
 * - 下一字符为标识续接（字母数字 _ - . / \\）时拒绝，防 git→gitignore
 * - 也不认 `=` `;` `|` `&` 等粘连（防 `git=evil` / `git;rm`）
 * - null/空 → false
 */
export function isTokenBoundaryPrefix(
  command: unknown,
  whitelistEntry: unknown
): boolean {
  const cmd = normalizeCommandLine(command).toLowerCase();
  const w = normalizeCommandLine(whitelistEntry).toLowerCase();
  if (!cmd || !w) return false;
  if (cmd === w) return true;
  if (!cmd.startsWith(w)) return false;
  const next = cmd.charAt(w.length);
  // 仅空白分隔参数；normalize 后通常只剩 space，仍认 tab
  if (next === ' ' || next === '\t') return true;
  return false;
}

/**
 * 白名单是否覆盖该命令。
 * - 精确：whitelist "git status" 匹配 "git status"
 * - token 边界前缀：匹配 "git status --short"
 * - Windows 变体：cmd /c、powershell -Command、.exe 后缀
 * - 禁止：gitignore、npmrc、git-status、npm runtime（相对 npm run）
 */
export function commandMatchesWhitelist(
  command: unknown,
  whitelist: unknown
): boolean {
  if (!Array.isArray(whitelist) || whitelist.length === 0) return false;
  const variants = commandMatchVariants(command);
  if (variants.length === 0) return false;
  for (const raw of whitelist) {
    const entry = sanitizeWhitelistEntry(raw);
    if (!entry) continue;
    for (const v of variants) {
      if (isTokenBoundaryPrefix(v, entry)) return true;
    }
  }
  return false;
}

/**
 * 从审批参数中提取可读命令（与 bridge 提取策略对齐的轻量版）。
 * null/非字符串 args → 回落 toolName；JSON 多字段候选。
 */
export function extractCommandForMatch(
  toolName: unknown,
  args: unknown
): string {
  const name = coerceCommandText(toolName).trim();
  const a =
    typeof args === 'string'
      ? args.trim()
      : args == null
        ? ''
        : typeof args === 'object'
          ? '' // 非字符串对象不 String()，避免 "[object Object]"
          : coerceCommandText(args).trim();

  if (!a) return name;

  if (!a.startsWith('{') && !a.startsWith('[')) return a;

  try {
    const o = JSON.parse(a) as unknown;
    if (Array.isArray(o) && o.every((x) => typeof x === 'string')) {
      return (o as string[]).join(' ');
    }
    if (o && typeof o === 'object') {
      const rec = o as Record<string, unknown>;
      // 常见键 + 嵌套 parameters / input 对象
      const bags: Record<string, unknown>[] = [rec];
      if (
        rec.parameters &&
        typeof rec.parameters === 'object' &&
        !Array.isArray(rec.parameters)
      ) {
        bags.push(rec.parameters as Record<string, unknown>);
      }
      if (
        rec.input &&
        typeof rec.input === 'object' &&
        !Array.isArray(rec.input)
      ) {
        bags.push(rec.input as Record<string, unknown>);
      }
      const keys = [
        'command',
        'cmd',
        'script',
        'input',
        'argv',
        'shell_command',
        'code',
        'line',
      ] as const;
      for (const bag of bags) {
        for (const k of keys) {
          const c = bag[k];
          if (typeof c === 'string' && c.trim()) return c.trim();
          if (
            Array.isArray(c) &&
            c.length > 0 &&
            c.every((x) => typeof x === 'string')
          ) {
            return (c as string[]).join(' ');
          }
        }
      }
    }
  } catch {
    /* swallow-ok: 命令文本 JSON 解析兜底，失败时按原串展示 */
  }
  return a;
}

// ── P1 权限归一（D6）──
//
// 前端命令风险正则表（极危/破坏/外发/网络/写/只读六表）与基于它的风险
// 分类函数族已整体删除——前端不再存在第二套命令风险分类（TrustZone 双
// 语义收敛归引擎权威）；白名单保留为批准记忆（本文件上方 CRUD/匹配原
// 语），不再参与任何放行判定。
