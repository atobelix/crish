export type CommandRisk =
  | "read"
  | "write"
  | "network"
  | "process"
  | "destructive"
  | "secret"
  | "external-side-effect"
  | "unknown";

export interface CommandClassification {
  risk: CommandRisk;
  reason: string;
  matched?: string;
}

/**
 * Tier 0 — 纯只读：任意模式下默认可自动放行（经 isReadOnly → policy allow）。
 * 覆盖目录/文件/搜索/Git 查看/测试检查/系统信息等 50+ 类。
 */
const SAFE_READ_PATTERNS: RegExp[] = [
  // 定位 / 目录
  /^pwd$/i,
  /^cd(\s|$)/i,
  /^get-location$/i,
  /^ls(\s|$)/i,
  /^dir(\s|$)/i,
  /^tree(\s|$)/i,
  /^get-childitem(\s|$)/i,
  /^ll(\s|$)/i,

  // 文件阅读（放宽路径：中文、空格、引号）
  /^(cat|type|get-content|more|less)(\s|$)/i,
  /^(head|tail)(\s|$)/i,

  // 搜索
  /^(rg|grep|egrep|fgrep|findstr|find|ag|ack)(\s|$)/i,
  /^select-string(\s|$)/i,
  /^where(\s|$)/i,
  /^which(\s|$)/i,
  /^where\.exe(\s|$)/i,

  // 文件/磁盘信息
  /^(stat|file|wc|du|df|lsblk|blkid)(\s|$)/i,
  /^(Get-Item|Get-ItemProperty|Get-Acl)(\s|$)/i,

  // 进程 / 服务 / 系统信息（只读）
  /^(ps|top|htop|pgrep)(\s|$)/i,
  /^(get-process|get-service|get-date|get-computerinfo|get-hotfix)(\s|$)/i,
  /^(select-object|where-object|measure-object|format-table|format-list|sort-object)(\s|$)/i,
  /^(netstat|ss|ipconfig|ifconfig|systeminfo|hostname|whoami|uname)(\s|$)/i,
  /^ip\s+(addr|route|link|neigh)(\s|$)/i,

  // Git 只读（不含会改 ref 的 branch/tag 创建）
  /^git\s+(status|diff|show|log|blame|rev-parse|ls-files|describe|stash\s+list|config\s+--get|config\s+--list)(\s|$)/i,
  /^git\s+branch(\s+(-a|-r|-v|--list|-\w+))*\s*$/i,
  /^git\s+branch\s+(-a|-r|-v|--list)\b/i,
  /^git\s+remote(\s+(-v|--verbose))?\s*$/i,
  /^git\s+tag(\s+(-l|--list))?\s*$/i,

  // 包 / 工具：仅明确只读子命令；npm run 脚本可能写盘 → 不进 T0
  /^npm\s+(test|view|list|ls|outdated|why|explain|pack\s+--dry-run)(\s|$)/i,
  /^pnpm\s+(test|view|list|ls|outdated|why)(\s|$)/i,
  /^yarn\s+(test|why|list|info)(\s|$)/i,
  /^npx\s+(tsc|vitest|eslint|prettier|jest|mocha)(\s|$)/i,
  /^(tsc|vitest|jest|mocha|eslint|prettier)(\s|$)/i,
  /^pip(\s+3)?\s+(list|show|freeze)(\s|$)/i,
  /^cargo\s+(test|check|search|tree|metadata)(\s|$)/i,
  /^go\s+(test|version|env|list)(\s|$)/i,
  /^dotnet\s+(test|build\s+--no-restore|--version|list)(\s|$)/i,

  // 版本
  /^(node|npm|pnpm|yarn|python|python3|pip|pip3|git|cargo|go|rustc|java|javac)\s+(-v|--version|version)(\s|$)/i,
  /^(node|npm|pnpm|yarn|python|python3|git|cargo|go)\s+-V$/i,

  // 常见只读组合（分段仍会再校验）
  /^pwd\s*&&\s*(ls|dir|get-childitem)\b/i,
  /^(ls|dir|get-childitem)\b.*\|\s*(select-object|measure-object|where-object|findstr|head|tail|sort|uniq|wc)\b/i,
  /^(cat|type|get-content)\b.*\|\s*(head|tail|select-object|findstr|wc|sort|uniq)\b/i,
];

const SECRET_PATTERNS: RegExp[] = [
  /\b(auth|token|secret|password|credential|api[_-]?key)\b/i,
  /\bprintenv\b/i,
  /^\s*set(?:\s|$)/i,
  /\bget-childitem\s+env:/i,
  /(^|[;&|]\s*)env(?:\s|$)/i,
  /(^|[\\/\s])\.env(\.[\w-]+)?(\s|$)/i,
  /(^|[\\/\s])id_(rsa|ed25519|ecdsa)(\s|$)/i,
  /\.(pem|key|p12|pfx)(\s|$)/i,
  /(^|[\\/\s])\.ssh([\\/\s]|$)/i,
  /(^|[\\/\s])\.aws([\\/\s]|$)/i,
];

const EXTERNAL_SIDE_EFFECT_PATTERNS: RegExp[] = [
  /(^|[;&|]\s*)git\s+push\b/i,
  /\b(npm|pnpm|yarn|bun)\s+publish\b/i,
  /\b(cargo|dotnet)\s+publish\b/i,
  /\btwine\s+upload\b/i,
  /\b(vercel|netlify|wrangler|firebase)\s+deploy\b/i,
  /\bkubectl\s+(apply|delete|replace|scale|rollout)\b/i,
  /\bterraform\s+(apply|destroy)\b/i,
  /\bdocker\s+push\b/i,
  /\bgh\s+release\b/i,
  /\b(sc|New-Service|Set-Service|Register-ScheduledTask)\b/i,
  /\breg\s+(add|delete|import)\b/i,
];

const NETWORK_PATTERNS: RegExp[] = [
  /\b(curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\b/i,
  /\b(ssh|scp|rsync|ftp|sftp)\b/i,
  /\b(npm|pnpm|yarn|bun|pip|uv|cargo|go)\s+(install|add|get|sync|update|download|fetch)\b/i,
  /\bgit\s+(clone|fetch|pull|submodule\s+update)\b/i,
];

const WRITE_PATTERNS: RegExp[] = [
  // 本地 git 变更（push 走 external-side-effect → T3）
  /(^|[;&|]\s*)git\s+(commit|add|stash|checkout|switch|merge|rebase|pull|tag)(\s|$)/i,
  /\b(apply_patch|patch)\b/i,
  /\b(set-content|add-content|out-file|new-item|copy-item|move-item|rename-item)\b/i,
  /(^|[;&|]\s*)(cp|copy|mv|move|touch|mkdir|tee)\b/i,
  />{1,2}/,
];

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\b/i,
  /\bremove-item\b/i,
  /\bdel\s+/i,
  /\brmdir\b/i,
  // 删除分支/标签/远程删除
  /(^|[;&|]\s*)git\s+branch\s+(-d|-D)\b/i,
  /(^|[;&|]\s*)git\s+tag\s+(-d|--delete)\b/i,
  /(^|[;&|]\s*)git\s+push\b.*(--delete|-d)\b/i,
  /(^|[;&|]\s*)git\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s+\.|restore\s+\.)(\s|$)/i,
  /\bchmod\s+(-R\s+)?777\b/i,
  /(^|[;&|]\s*)sudo\b/i,
  /\bSet-ExecutionPolicy\b/i,
  // 解释器内联执行（内容不透明，无法审计实际操作）
  /\b(bash|sh|zsh|dash|ksh)\s+(-c|--command)\b/i,
  /\beval\s+["'`$]/i,
  /\b(python|python3)\s+(-c|--command)\b/i,
  /\bnode\s+(-e|--eval)\s+["'`]/i,
  /\b(perl|ruby)\s+(-e)\s+["']/i,
  /\bphp\s+(-r)\s+['"]/i,
  // 权限提升（su -c / doas / pkexec — 非交互式提权执行）
  /\bsu\s+.*(-c|--command)\b/i,
  /\bdoas\b/i,
  /\bpkexec\b/i,
];

const PROCESS_PATTERNS: RegExp[] = [/\b(taskkill|Stop-Process|kill|pkill|killall)\b/i];

/**
 * SAFE_READ_PATTERNS 首词分派表。
 *
 * SAFE_READ 是最大 pattern 组（41 条，全部 ^ 锚定首词），且大部分命令是只读的，
 * 会走到 classifySingle 的 SAFE_READ 步骤。按首词分派可将候选集从 41 缩小到 2-7。
 *
 * 其他 pattern 组（DESTRUCTIVE/SECRET/EXTERNAL/NETWORK/PROCESS/WRITE）多用 \b 任意位置
 * 匹配，无法安全按首词缩小，保持全量测试。
 *
 * 维护：新增 SAFE_READ pattern 时需同步更新此分派表。未命中分派表的命令回退到
 * 测试全部 SAFE_READ_PATTERNS，保证行为等价。
 */
const SAFE_READ_DISPATCH: ReadonlyMap<string, RegExp[]> = (() => {
  const m = new Map<string, RegExp[]>();
  const add = (word: string, ...patterns: RegExp[]) => {
    const arr = m.get(word);
    if (arr) arr.push(...patterns);
    else m.set(word, [...patterns]);
  };
  const register = (words: string[], pattern: RegExp) => {
    for (const w of words) add(w, pattern);
  };
  const P = SAFE_READ_PATTERNS;
  // 定位/目录
  add("pwd", P[0]!, P[38]!);
  add("cd", P[1]!);
  add("get-location", P[2]!);
  register(["ls", "dir", "get-childitem"], P[39]!); // 组合管道
  add("ls", P[3]!);
  add("dir", P[4]!);
  add("tree", P[5]!);
  add("get-childitem", P[6]!);
  add("ll", P[7]!);
  // 文件阅读
  register(["cat", "type", "get-content", "more", "less"], P[8]!);
  register(["cat", "type", "get-content"], P[40]!); // 组合管道
  register(["head", "tail"], P[9]!);
  // 搜索
  register(["rg", "grep", "egrep", "fgrep", "findstr", "find", "ag", "ack"], P[10]!);
  add("select-string", P[11]!);
  add("where", P[12]!, P[14]!); // where 和 where.exe 共享
  add("which", P[13]!);
  add("where.exe", P[14]!);
  // 文件/磁盘信息
  register(["stat", "file", "wc", "du", "df", "lsblk", "blkid"], P[15]!);
  register(["get-item", "get-itemproperty", "get-acl"], P[16]!);
  // 进程/服务/系统信息
  register(["ps", "top", "htop", "pgrep"], P[17]!);
  register(["get-process", "get-service", "get-date", "get-computerinfo", "get-hotfix"], P[18]!);
  register(["select-object", "where-object", "measure-object", "format-table", "format-list", "sort-object"], P[19]!);
  register(["netstat", "ss", "ipconfig", "ifconfig", "systeminfo", "hostname", "whoami", "uname"], P[20]!);
  add("ip", P[21]!);
  // Git 只读（多条）
  add("git", P[22]!, P[23]!, P[24]!, P[25]!, P[26]!);
  // 包/工具只读
  add("npm", P[27]!);
  add("pnpm", P[28]!);
  add("yarn", P[29]!);
  add("npx", P[30]!);
  register(["tsc", "vitest", "jest", "mocha", "eslint", "prettier"], P[31]!);
  register(["pip", "pip3"], P[32]!);
  add("cargo", P[33]!);
  add("go", P[34]!);
  add("dotnet", P[35]!);
  // 版本查询（多工具共享）
  register(["node", "npm", "pnpm", "yarn", "python", "python3", "pip", "pip3", "git", "cargo", "go", "rustc", "java", "javac"], P[36]!);
  register(["node", "npm", "pnpm", "yarn", "python", "python3", "git", "cargo", "go"], P[37]!);
  return m;
})();

/** 提取命令首词（小写），用于 SAFE_READ 分派表查询 */
function extractFirstWord(raw: string): string {
  const trimmed = raw.trimStart();
  const end = trimmed.search(/\s/);
  return (end === -1 ? trimmed : trimmed.slice(0, end)).toLowerCase();
}

/** 按 && / ; / | 切段（尊重引号） */
function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    const next = command[i + 1];
    if (quote) {
      current += ch;
      if (escaped) {
        escaped = false;
      } else if (quote === '"' && (ch === "\\" || ch === "`")) {
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
    if (ch === "&" && next === "&") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      i += 1;
      continue;
    }
    if (ch === "|" || ch === ";") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) segments.push(current.trim());
  return segments.length > 0 ? segments : [command.trim()];
}

function classifySingle(raw: string): CommandClassification {
  if (DESTRUCTIVE_PATTERNS.some((p) => p.test(raw))) {
    const matched = DESTRUCTIVE_PATTERNS.find((p) => p.test(raw));
    return { risk: "destructive", reason: "Destructive command", matched: matched?.source };
  }
  if (SECRET_PATTERNS.some((p) => p.test(raw))) {
    return { risk: "secret", reason: "Command may expose secrets" };
  }
  if (EXTERNAL_SIDE_EFFECT_PATTERNS.some((p) => p.test(raw))) {
    return { risk: "external-side-effect", reason: "External side effect" };
  }
  if (NETWORK_PATTERNS.some((p) => p.test(raw))) {
    return { risk: "network", reason: "Network access" };
  }
  if (PROCESS_PATTERNS.some((p) => p.test(raw))) {
    return { risk: "process", reason: "Process management" };
  }
  // SAFE_READ 按首词分派：未命中分派表的命令回退到测试全部 SAFE_READ_PATTERNS
  const firstWord = extractFirstWord(raw);
  const candidates = SAFE_READ_DISPATCH.get(firstWord);
  const readPatterns = candidates ?? SAFE_READ_PATTERNS;
  if (readPatterns.some((p) => p.test(raw))) {
    return { risk: "read", reason: "Read-only command" };
  }
  if (WRITE_PATTERNS.some((p) => p.test(raw))) {
    return { risk: "write", reason: "Write command" };
  }
  return { risk: "write", reason: "Unclassified command" };
}

/**
 * 命令风险分类。
 * 组合命令：所有段都为 read 才算 read；任一非 read 取「更严」风险。
 */
export function classifyCommand(command: string): CommandClassification {
  if (!command) return { risk: "unknown", reason: "No command provided" };

  const raw = command.trim();
  const segments = splitCommandSegments(raw);
  if (segments.length === 1) {
    return classifySingle(segments[0]!);
  }

  const ranks: Record<CommandRisk, number> = {
    read: 0,
    unknown: 1,
    write: 2,
    network: 3,
    process: 3,
    secret: 4,
    "external-side-effect": 4,
    destructive: 5,
  };

  let worst: CommandClassification = { risk: "read", reason: "Read-only compound command" };
  for (const seg of segments) {
    const c = classifySingle(seg);
    if (ranks[c.risk] > ranks[worst.risk]) {
      worst = { ...c, reason: `${c.reason} (in compound command)` };
    }
  }
  if (worst.risk === "read") {
    return { risk: "read", reason: "All segments are read-only", matched: "compound-read" };
  }
  return worst;
}

/** 别名：与 agent-runtime 命名对齐 */
export function classifyTerminalCommand(command: string): CommandClassification {
  return classifyCommand(command);
}
