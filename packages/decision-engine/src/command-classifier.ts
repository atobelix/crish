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

const SAFE_READ_PATTERNS: RegExp[] = [
  /^pwd$/i, /^cd$/i, /^get-location$/i, /^ls(\s|$)/i, /^dir(\s|$)/i,
  /^get-childitem(\s|$)/i, /^cat\s+[\w./\\:-]+$/i, /^type\s+[\w./\\:-]+$/i,
  /^get-content\s+[\w./\\:-]+$/i, /^rg(\s|$)/i, /^grep(\s|$)/i, /^findstr(\s|$)/i,
  /^git\s+(status|diff|show|log|branch|rev-parse|remote\s+-v|ls-files)(\s|$)/i,
  /^npm\s+(test|run\s+[\w:-]+|exec\s+tsc|view|list)(\s|$)/i,
  /^pnpm\s+(test|run\s+[\w:-]+|exec\s+tsc|view|list)(\s|$)/i,
  /^npx\s+(tsc|vitest|eslint|prettier)(\s|$)/i,
  /^node\s+(-v|--version)(\s|$)/i, /^python\s+(--version|-V)(\s|$)/i,
];

const SECRET_PATTERNS: RegExp[] = [
  /\b(auth|token|secret|password|credential|api[_-]?key)\b/i, /\bprintenv\b/i,
  /^\s*set(?:\s|$)/i, /\bget-childitem\s+env:/i, /(^|[;&|]\s*)env(?:\s|$)/i,
  /(^|[\\/\s])\.env(\.[\w-]+)?(\s|$)/i, /(^|[\\/\s])id_(rsa|ed25519|ecdsa)(\s|$)/i,
  /\.(pem|key|p12|pfx)(\s|$)/i, /(^|[\\/\s])\.ssh([\\/\s]|$)/i, /(^|[\\/\s])\.aws([\\/\s]|$)/i,
];

const EXTERNAL_SIDE_EFFECT_PATTERNS: RegExp[] = [
  /(^|[;&|]\s*)git\s+push\b/i, /\b(npm|pnpm|yarn|bun)\s+publish\b/i,
  /\b(cargo|dotnet)\s+publish\b/i, /\btwine\s+upload\b/i,
  /\b(vercel|netlify|wrangler|firebase)\s+deploy\b/i, /\bkubectl\s+(apply|delete|replace|scale|rollout)\b/i,
  /\bterraform\s+(apply|destroy)\b/i, /\bdocker\s+push\b/i, /\bgh\s+release\b/i,
  /\b(sc|New-Service|Set-Service|Register-ScheduledTask)\b/i, /\breg\s+(add|delete|import)\b/i,
];

const NETWORK_PATTERNS: RegExp[] = [
  /\b(curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\b/i,
  /\b(ssh|scp|rsync|ftp|sftp)\b/i,
  /\b(npm|pnpm|yarn|bun|pip|uv|cargo|go)\s+(install|add|get|sync|update|download|fetch)\b/i,
  /\bgit\s+(clone|fetch|pull|submodule\s+update)\b/i,
];

const WRITE_PATTERNS: RegExp[] = [
  /(^|[;&|]\s*)git\s+(commit|pull|merge|rebase|checkout|switch|stash|tag)\b/i,
  /\b(apply_patch|patch)\b/i, /\b(set-content|add-content|out-file|new-item|copy-item|move-item|rename-item)\b/i,
  /(^|[;&|]\s*)(cp|copy|mv|move|touch|mkdir|tee)\b/i, />{1,2}/,
  /\b(npm|pnpm|yarn|bun)\s+(install|add|remove|update|audit\s+fix)\b/i,
  /\b(pip|uv)\s+(install|sync|add|remove)\b/i,
];

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*r[a-z]*f?|-rf|-fr)\b/i,
  /\bremove-item\b.*(?:^|\s)(?:-recurse|-force)(?:\s|$)/i, /\bdel\s+\/[fsq]\b/i, /\brmdir\s+\/s\b/i,
  /(^|[;&|]\s*)git\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s+\.|restore\s+\.)(\s|$)/i,
  /\bchmod\s+(-R\s+)?777\b/i, /(^|[;&|]\s*)sudo\b/i, /\bSet-ExecutionPolicy\b/i,
];

const PROCESS_PATTERNS: RegExp[] = [
  /\b(taskkill|Stop-Process|kill|pkill)\b/i,
];

export function classifyCommand(command: string): CommandClassification {
  if (!command) return { risk: "unknown", reason: "No command provided" };

  const raw = command.trim();

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
  if (SAFE_READ_PATTERNS.some((p) => p.test(raw))) {
    return { risk: "read", reason: "Read-only command" };
  }
  if (WRITE_PATTERNS.some((p) => p.test(raw))) {
    return { risk: "write", reason: "Write command" };
  }

  return { risk: "write", reason: "Unclassified command" };
}
