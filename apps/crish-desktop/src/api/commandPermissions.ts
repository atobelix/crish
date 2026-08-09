/**
 * 命令白名单：本机持久化 + 审批时自动放行（契约：LS + 桌面审批桥）
 *
 * - 匹配：仅「精确」或「token 边界前缀」（白名单后必须是空白再跟参数）
 * - 绝不做裸 startsWith：whitelist "git" 不得匹配 gitignore / git-status / git_status
 * - 不做反向「命令是白名单前缀」匹配（曾误伤，已移除）
 * - 不伪造工具输出；仅在引擎要求确认时自动 approve-tool
 * - 与 permissionMode 配合：plan 模式仍不自动写操作（引擎侧为主）
 * - 极危 / 硬拒绝模式：即使用户白名单命中也不得自动放行（shouldAutoApproveCommand）
 * - Windows：cmd /c、powershell -Command 包装、.exe 后缀、盘符路径在匹配变体中剥离
 */

export const COMMAND_PERMISSIONS_STORAGE_KEY = 'crish_command_permissions_v1';

const DEFAULT_SEED = ['git status', 'git diff', 'git log', 'npm test', 'npm run test'];

type StorageGet = Pick<Storage, 'getItem'>;
type StorageSet = Pick<Storage, 'setItem'>;

function defaultStorage(): Storage | null {
  return typeof localStorage !== 'undefined' ? localStorage : null;
}

/** 将任意输入收成字符串；null/undefined/非字符串 → '' */
export function coerceCommandText(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (typeof input === 'number' || typeof input === 'boolean' || typeof input === 'bigint') {
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
  return `${head.replace(WIN_EXE_SUFFIX, '')}${rest}`.replace(/\s+/g, ' ').trim();
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
      /^(?:[a-zA-Z]:[\\/])?(?:[^\\/:*?"<>|\s]+[\\/])*cmd(?:\.exe)?(?:\s+\/[dDsS])*\s+\/[cCkK]\s+(.+)$/i,
    );
    if (cmdSimple?.[1]) {
      s = normalizeCommandLine(cmdSimple[1]);
    } else {
      // powershell[.exe] … -Command|-c <rest>  （排除 -EncodedCommand 由 deny 处理）
      const psM = s.match(
        /^(?:[a-zA-Z]:[\\/])?(?:[^\\/:*?"<>|\s]+[\\/])*(?:pwsh|powershell)(?:\.exe)?(?:\s+-[A-Za-z]+(?:\s+[^\s-][^\s]*)?)*\s+-(?:Command|c)\s+(.+)$/i,
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
  storage: StorageGet | null | undefined = defaultStorage(),
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
  storage: StorageSet | null | undefined = defaultStorage(),
): void {
  const cleaned = dedupeWhitelist(list);
  try {
    storage?.setItem?.(COMMAND_PERMISSIONS_STORAGE_KEY, JSON.stringify(cleaned));
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
  storage: StorageSet | null | undefined = defaultStorage(),
): string[] {
  const base = Array.isArray(list) ? list.map((x) => coerceCommandText(x)) : [];
  const c = sanitizeWhitelistEntry(cmd);
  if (!c) return dedupeWhitelist(base);
  if (base.some((x) => sanitizeWhitelistEntry(x).toLowerCase() === c.toLowerCase())) {
    return dedupeWhitelist(base);
  }
  const next = dedupeWhitelist([...base, c]);
  saveCommandPermissions(next, storage);
  return next;
}

export function removeCommandPermission(
  list: unknown,
  cmd: unknown,
  storage: StorageSet | null | undefined = defaultStorage(),
): string[] {
  const base = Array.isArray(list) ? list : [];
  const target = sanitizeWhitelistEntry(cmd).toLowerCase();
  if (!target) return dedupeWhitelist(base);
  const next = dedupeWhitelist(
    base.filter((x) => sanitizeWhitelistEntry(x).toLowerCase() !== target),
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
export function isTokenBoundaryPrefix(command: unknown, whitelistEntry: unknown): boolean {
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
export function commandMatchesWhitelist(command: unknown, whitelist: unknown): boolean {
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
export function extractCommandForMatch(toolName: unknown, args: unknown): string {
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
      if (rec.parameters && typeof rec.parameters === 'object' && !Array.isArray(rec.parameters)) {
        bags.push(rec.parameters as Record<string, unknown>);
      }
      if (rec.input && typeof rec.input === 'object' && !Array.isArray(rec.input)) {
        bags.push(rec.input as Record<string, unknown>);
      }
      const keys = ['command', 'cmd', 'script', 'input', 'argv', 'shell_command', 'code', 'line'] as const;
      for (const bag of bags) {
        for (const k of keys) {
          const c = bag[k];
          if (typeof c === 'string' && c.trim()) return c.trim();
          if (Array.isArray(c) && c.length > 0 && c.every((x) => typeof x === 'string')) {
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

// ── 风险分级 / 拒绝模式 ─────────────────────────────────────────────────────

/** 桌面侧 shell 风险档（与引擎 TrustZone 对齐语义，不直接依赖 daemon 包） */
export type ShellRiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical' | 'unknown';

export type ShellRiskClassification = {
  level: ShellRiskLevel;
  /** 中文 UX 文案（设置 / 审批提示） */
  message: string;
  /** 机器可读原因（英文短码） */
  reason: string;
  /** 命中的模式摘要（若有） */
  matched?: string;
  /** true：禁止白名单自动放行 */
  hardDeny: boolean;
};

const RISK_RANK: Record<ShellRiskLevel, number> = {
  safe: 0,
  low: 1,
  unknown: 2,
  medium: 3,
  high: 4,
  critical: 5,
};

/** 中文风险文案（稳定、无乱码；供 UI 直接展示） */
export function shellRiskMessage(level: ShellRiskLevel | unknown): string {
  switch (level) {
    case 'safe':
      return '低风险只读，可考虑加入白名单自动放行';
    case 'low':
      return '较低风险，白名单命中时可自动放行';
    case 'medium':
      return '中等风险，建议人工确认';
    case 'high':
      return '高风险，不建议自动放行';
    case 'critical':
      return '极危操作，禁止自动放行';
    case 'unknown':
    default:
      return '无法识别风险，请人工确认';
  }
}

type PatternEntry = { pattern: RegExp; reason: string; matched: string };

/** 极危：磁盘破坏、关机、LOLBins、编码执行等 — 永不白名单自动放行 */
const HARDLINE_PATTERNS: readonly PatternEntry[] = [
  { pattern: /\b(format|format\.com)\s+[a-zA-Z]:/i, reason: 'format-drive', matched: 'format drive' },
  {
    pattern: /\b(Format-Volume|Clear-Disk|Remove-Partition|Initialize-Disk|diskpart)\b/i,
    reason: 'disk-partition',
    matched: 'disk tool',
  },
  { pattern: /\bmkfs(\.[a-z0-9]+)?\b/i, reason: 'mkfs', matched: 'mkfs' },
  { pattern: /\bdd\b[^\n]*\bof=\/dev\//i, reason: 'dd-device', matched: 'dd' },
  { pattern: /\bcipher\s+\/w\b/i, reason: 'cipher-wipe', matched: 'cipher /w' },
  { pattern: /\bvssadmin\s+delete\s+shadows\b/i, reason: 'vss-delete', matched: 'vssadmin' },
  {
    pattern: /(^|[;&|]\s*)(sudo\s+)?(shutdown|reboot|halt|poweroff)\b/i,
    reason: 'shutdown',
    matched: 'shutdown',
  },
  { pattern: /\bshutdown\s+\/[srg]\b/i, reason: 'win-shutdown', matched: 'shutdown' },
  {
    pattern: /\b(Restart-Computer|Stop-Computer)\b/i,
    reason: 'ps-shutdown',
    matched: 'Stop/Restart-Computer',
  },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'fork-bomb', matched: 'fork bomb' },
  { pattern: /\bmshta\b/i, reason: 'mshta', matched: 'mshta' },
  { pattern: /\brundll32\b/i, reason: 'rundll32', matched: 'rundll32' },
  { pattern: /\bregsvr32\b/i, reason: 'regsvr32', matched: 'regsvr32' },
  {
    pattern: /\bpowershell\b[^\n]*-(enc|encodedcommand)\b/i,
    reason: 'ps-encoded',
    matched: 'powershell -enc',
  },
  { pattern: /\breg\s+(delete|add|import|restore)\b/i, reason: 'registry', matched: 'reg' },
  { pattern: /\bbcdedit\s+\/delete\b/i, reason: 'bcdedit', matched: 'bcdedit' },
  { pattern: /\b(sc|sc\.exe)\s+(stop|delete|config)\b/i, reason: 'service-control', matched: 'sc' },
  {
    pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|--force\s+)*\/(\s|$)/i,
    reason: 'rm-root',
    matched: 'rm /',
  },
  {
    pattern: /\brm\s+(-[a-zA-Z]+\s+)*\/\s*$/i,
    reason: 'rm-root',
    matched: 'rm /',
  },
  // Windows 整盘删除
  {
    pattern: /\b(del|rd|rmdir)\s+.*[a-zA-Z]:\\?\s*(\/s|\/q)/i,
    reason: 'win-wipe-drive',
    matched: 'del/rd drive',
  },
  {
    pattern: /\bRemove-Item\b.*\s-(Recurse|Force)\b/i,
    reason: 'ps-remove-force',
    matched: 'Remove-Item -Recurse',
  },
];

/** 高危破坏（删文件等）— 默认禁止白名单自动放行 */
const DESTRUCTIVE_PATTERNS: readonly PatternEntry[] = [
  { pattern: /(^|[;&|]\s*)rm\s+/i, reason: 'rm', matched: 'rm' },
  { pattern: /\bremove-item\b/i, reason: 'remove-item', matched: 'Remove-Item' },
  { pattern: /\bdel\s+/i, reason: 'del', matched: 'del' },
  { pattern: /\brmdir\b/i, reason: 'rmdir', matched: 'rmdir' },
  {
    pattern: /(^|[;&|]\s*)git\s+(reset\s+--hard|clean\s+-[a-z]*f)\b/i,
    reason: 'git-hard-reset',
    matched: 'git reset/clean',
  },
  { pattern: /\bchmod\s+(-R\s+)?777\b/i, reason: 'chmod-777', matched: 'chmod 777' },
  { pattern: /(^|[;&|]\s*)sudo\b/i, reason: 'sudo', matched: 'sudo' },
  { pattern: /\btaskkill\b/i, reason: 'taskkill', matched: 'taskkill' },
  { pattern: /\b(Stop-Process|kill|pkill|killall)\b/i, reason: 'kill-process', matched: 'kill' },
];

/** 外发副作用 — 中高风险 */
const EXTERNAL_PATTERNS: readonly PatternEntry[] = [
  { pattern: /(^|[;&|]\s*)git\s+push\b/i, reason: 'git-push', matched: 'git push' },
  { pattern: /\b(npm|pnpm|yarn|bun)\s+publish\b/i, reason: 'pkg-publish', matched: 'publish' },
  { pattern: /\b(terraform)\s+(apply|destroy)\b/i, reason: 'terraform', matched: 'terraform' },
  { pattern: /\bdocker\s+push\b/i, reason: 'docker-push', matched: 'docker push' },
  { pattern: /\bkubectl\s+(apply|delete|replace)\b/i, reason: 'kubectl', matched: 'kubectl' },
];

/** 网络 — 中等 */
const NETWORK_PATTERNS: readonly PatternEntry[] = [
  { pattern: /\b(curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\b/i, reason: 'http', matched: 'http client' },
  { pattern: /\b(ssh|scp|rsync|ftp|sftp)\b/i, reason: 'remote', matched: 'remote copy' },
  {
    pattern: /\b(npm|pnpm|yarn|bun|pip|uv|cargo|go)\s+(install|add|get|sync|update)\b/i,
    reason: 'pkg-install',
    matched: 'package install',
  },
];

/** 写操作 — 中等 */
const WRITE_PATTERNS: readonly PatternEntry[] = [
  {
    pattern: /(^|[;&|]\s*)git\s+(commit|add|stash|checkout|switch|merge|rebase)\b/i,
    reason: 'git-write',
    matched: 'git write',
  },
  {
    pattern: /\b(set-content|add-content|out-file|new-item|copy-item|move-item|rename-item)\b/i,
    reason: 'ps-write',
    matched: 'PowerShell write',
  },
  { pattern: /(^|[;&|]\s*)(cp|copy|mv|move|touch|mkdir|tee)\b/i, reason: 'fs-write', matched: 'fs write' },
  { pattern: />{1,2}/, reason: 'redirect', matched: 'redirect' },
];

/** 常见只读 — safe */
const SAFE_READ_PATTERNS: readonly RegExp[] = [
  /^pwd$/i,
  /^(ls|dir|tree|ll)(\s|$)/i,
  /^(cat|type|get-content|more|less|head|tail)(\s|$)/i,
  /^(rg|grep|findstr|find)(\s|$)/i,
  /^(git\s+(status|diff|show|log|blame|rev-parse|ls-files|describe)(\s|$))/i,
  /^(npm|pnpm|yarn)\s+(test|view|list|ls|outdated|why)(\s|$)/i,
  /^(node|npm|pnpm|yarn|python|python3|git|cargo|go)\s+(-v|--version|version|-V)(\s|$)/i,
  /^(ipconfig|ifconfig|hostname|whoami|uname|systeminfo)(\s|$)/i,
  /^(get-childitem|get-location|get-process|get-date)(\s|$)/i,
  /^(tsc|vitest|eslint|prettier|jest)(\s|$)/i,
];

function firstMatch(patterns: readonly PatternEntry[], text: string): PatternEntry | null {
  for (const p of patterns) {
    if (p.pattern.test(text)) return p;
  }
  return null;
}

function classifyOneSegment(raw: string): ShellRiskClassification {
  const hard = firstMatch(HARDLINE_PATTERNS, raw);
  if (hard) {
    return {
      level: 'critical',
      message: shellRiskMessage('critical'),
      reason: hard.reason,
      matched: hard.matched,
      hardDeny: true,
    };
  }
  const dest = firstMatch(DESTRUCTIVE_PATTERNS, raw);
  if (dest) {
    return {
      level: 'high',
      message: shellRiskMessage('high'),
      reason: dest.reason,
      matched: dest.matched,
      hardDeny: true,
    };
  }
  const ext = firstMatch(EXTERNAL_PATTERNS, raw);
  if (ext) {
    return {
      level: 'high',
      message: shellRiskMessage('high'),
      reason: ext.reason,
      matched: ext.matched,
      hardDeny: true,
    };
  }
  const net = firstMatch(NETWORK_PATTERNS, raw);
  if (net) {
    return {
      level: 'medium',
      message: shellRiskMessage('medium'),
      reason: net.reason,
      matched: net.matched,
      hardDeny: false,
    };
  }
  const write = firstMatch(WRITE_PATTERNS, raw);
  if (write) {
    return {
      level: 'medium',
      message: shellRiskMessage('medium'),
      reason: write.reason,
      matched: write.matched,
      hardDeny: false,
    };
  }
  if (SAFE_READ_PATTERNS.some((p) => p.test(raw))) {
    return {
      level: 'safe',
      message: shellRiskMessage('safe'),
      reason: 'read-only',
      matched: 'safe-read',
      hardDeny: false,
    };
  }
  // 未分类：偏保守 medium 未知
  return {
    level: 'unknown',
    message: shellRiskMessage('unknown'),
    reason: 'unclassified',
    hardDeny: false,
  };
}

/** 按 && / ; / | 切段（尊重引号），用于组合命令取最严风险 */
export function splitCommandSegments(command: unknown): string[] {
  const input = normalizeCommandLine(command);
  if (!input) return [];

  const segments: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    const next = input[i + 1];
    if (quote) {
      current += ch;
      if (escaped) {
        escaped = false;
      } else if (quote === '"' && (ch === '\\' || ch === '`')) {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '&' && next === '&') {
      if (current.trim()) segments.push(current.trim());
      current = '';
      i += 1;
      continue;
    }
    if (ch === '|' || ch === ';') {
      if (current.trim()) segments.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) segments.push(current.trim());
  return segments.length > 0 ? segments : [input];
}

/**
 * 分类 shell 命令风险（纯函数，null/空 → unknown）。
 * 组合命令取最严档；Windows 包装命令对内层再分类。
 */
export function classifyShellRisk(command: unknown): ShellRiskClassification {
  const variants = commandMatchVariants(command);
  if (variants.length === 0) {
    return {
      level: 'unknown',
      message: shellRiskMessage('unknown'),
      reason: 'empty',
      hardDeny: false,
    };
  }

  let worst: ShellRiskClassification = {
    level: 'safe',
    message: shellRiskMessage('safe'),
    reason: 'read-only',
    hardDeny: false,
  };

  for (const v of variants) {
    const segments = splitCommandSegments(v);
    for (const seg of segments) {
      const c = classifyOneSegment(seg);
      if (RISK_RANK[c.level] > RISK_RANK[worst.level] || (c.hardDeny && !worst.hardDeny)) {
        worst = segments.length > 1 ? { ...c, reason: `${c.reason}+compound` } : c;
      }
    }
  }
  // 保证 message 与 level 一致
  return { ...worst, message: shellRiskMessage(worst.level) };
}

/** 是否命中极危 hardline 模式 */
export function matchesHardlinePattern(command: unknown): boolean {
  return classifyShellRisk(command).level === 'critical';
}

/**
 * 是否命中「禁止自动放行」模式（critical/high hardDeny）。
 * 白名单命中也不得 auto-approve。
 */
export function matchesDenyPattern(command: unknown): boolean {
  return classifyShellRisk(command).hardDeny === true;
}

/**
 * 白名单自动放行判定：
 * - 必须 token 边界白名单命中
 * - 且未命中 deny/hardline/high 外发
 * - 空/null 命令 → false
 */
export function shouldAutoApproveCommand(command: unknown, whitelist: unknown): boolean {
  if (!commandMatchesWhitelist(command, whitelist)) return false;
  if (matchesDenyPattern(command)) return false;
  return true;
}

/**
 * 是否适合作为默认 seed / 推荐白名单的「安全只读」命令。
 */
export function isSafeReadCommand(command: unknown): boolean {
  const c = classifyShellRisk(command);
  return c.level === 'safe' && !c.hardDeny;
}
