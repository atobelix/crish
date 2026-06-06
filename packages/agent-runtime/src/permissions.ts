import type { JsonObject, PermissionDecision, PermissionPolicy, PermissionRequest } from "./types";

export type PermissionMode = "project" | "read-only" | "full-access";
export type CommandRisk =
  | "read"
  | "write"
  | "network"
  | "process"
  | "destructive"
  | "secret"
  | "external-side-effect"
  | "hardline"
  | "unknown";

export interface CommandClassification {
  risk: CommandRisk;
  reason: string;
  matched?: string;
}

export interface SmartPermissionPolicyOptions {
  mode?: PermissionMode;
}

export interface RememberingPermissionPolicy extends PermissionPolicy {
  recordDecision(request: PermissionRequest, decision: PermissionDecision): void;
}

const SAFE_READ_PATTERNS: RegExp[] = [
  /^pwd$/i,
  /^cd$/i,
  /^get-location$/i,
  /^ls(\s|$)/i,
  /^dir(\s|$)/i,
  /^get-childitem(\s|$)/i,
  /^cat\s+[\w./\\:-]+$/i,
  /^type\s+[\w./\\:-]+$/i,
  /^get-content\s+[\w./\\:-]+$/i,
  /^rg(\s|$)/i,
  /^grep(\s|$)/i,
  /^findstr(\s|$)/i,
  /^git\s+(status|diff|show|log|branch|rev-parse|remote\s+-v|ls-files)(\s|$)/i,
  /^npm\s+(test|run\s+[\w:-]+|exec\s+tsc|view|list)(\s|$)/i,
  /^pnpm\s+(test|run\s+[\w:-]+|exec\s+tsc|view|list)(\s|$)/i,
  /^npx\s+(tsc|vitest|eslint|prettier)(\s|$)/i,
  /^node\s+(-v|--version)(\s|$)/i,
  /^python\s+(--version|-V)(\s|$)/i
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
  /(^|[\\/\s])\.aws([\\/\s]|$)/i
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
  /\breg\s+(add|delete|import)\b/i
];

const NETWORK_PATTERNS: RegExp[] = [
  /\b(curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\b/i,
  /\b(ssh|scp|rsync|ftp|sftp)\b/i,
  /\b(npm|pnpm|yarn|bun|pip|uv|cargo|go)\s+(install|add|get|sync|update|download|fetch)\b/i,
  /\bgit\s+(clone|fetch|pull|submodule\s+update)\b/i
];

const WRITE_PATTERNS: RegExp[] = [
  /(^|[;&|]\s*)git\s+(commit|pull|merge|rebase|checkout|switch|stash|tag)\b/i,
  /\b(apply_patch|patch)\b/i,
  /\b(set-content|add-content|out-file|new-item|copy-item|move-item|rename-item)\b/i,
  /(^|[;&|]\s*)(cp|copy|mv|move|touch|mkdir|tee)\b/i,
  />{1,2}/,
  /\b(npm|pnpm|yarn|bun)\s+(install|add|remove|update|audit\s+fix)\b/i,
  /\b(pip|uv)\s+(install|sync|add|remove)\b/i
];

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*r[a-z]*f?|-rf|-fr)\b/i,
  /\bremove-item\b.*(?:^|\s)(?:-recurse|-force)(?:\s|$)/i,
  /\bdel\s+\/[fsq]\b/i,
  /\brmdir\s+\/s\b/i,
  /(^|[;&|]\s*)git\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s+\.|restore\s+\.)(\s|$)/i,
  /\bchmod\s+(-R\s+)?777\b/i,
  /(^|[;&|]\s*)sudo\b/i,
  /\bSet-ExecutionPolicy\b/i
];

const PROCESS_PATTERNS: RegExp[] = [
  /\b(taskkill|Stop-Process|kill|pkill)\b/i
];

const HARDLINE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-[^\s]*\s+)*(\/|\/\*|~|\$HOME)(\s|$)/i, reason: "recursive delete of root or home directory" },
  {
    pattern:
      /\brm\s+(-[^\s]*\s+)*(\/home|\/root|\/etc|\/usr|\/var|\/bin|\/sbin|\/boot|\/lib|\/System|\/Applications)(\/|\s|$)/i,
    reason: "recursive delete of system directory"
  },
  {
    pattern:
      /\bRemove-Item\b(?=.*\b-Recurse\b)(?=.*\b-Force\b)(?=.*(?:[A-Z]:\\(?:\s|$)|\$HOME|~|%USERPROFILE%|C:\\Users(?:\\|\s|$)|C:\\Windows(?:\\|\s|$)|C:\\Program Files(?:\\|\s|$)))/i,
    reason: "recursive delete of Windows root, user, or system directory"
  },
  { pattern: /\brmdir\s+\/s\s+(?:[A-Z]:\\|%USERPROFILE%|%HOMEPATH%|C:\\Users|C:\\Windows|C:\\Program Files)\b/i, reason: "recursive delete of Windows root, user, or system directory" },
  { pattern: /\bdel\s+\/[fsq]+\s+(?:[A-Z]:\\|%USERPROFILE%|%HOMEPATH%|C:\\Users|C:\\Windows|C:\\Program Files)\b/i, reason: "delete of Windows root, user, or system directory" },
  { pattern: /\b(format|format\.com)\s+[A-Z]:/i, reason: "formatting a drive" },
  { pattern: /\b(Format-Volume|Clear-Disk|Remove-Partition|Initialize-Disk|diskpart)\b/i, reason: "disk or partition operation" },
  { pattern: /\bmkfs(\.[a-z0-9]+)?\b/i, reason: "formatting a filesystem" },
  { pattern: /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|hd|mmcblk|vd|xvd)[a-z0-9]*/i, reason: "raw block device overwrite" },
  { pattern: />\s*\/dev\/(sd|nvme|hd|mmcblk|vd|xvd)[a-z0-9]*\b/i, reason: "raw block device overwrite" },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "fork bomb" },
  { pattern: /\bkill\s+(-[^\s]+\s+)*-1\b/i, reason: "kill every process" },
  { pattern: /\btaskkill\b(?=.*\/f)(?=.*\/im\s+\*)/i, reason: "kill every matching Windows process" },
  { pattern: /\bStop-Process\b(?=.*-Name\s+\*)/i, reason: "kill every matching PowerShell process" },
  { pattern: /(^|[;&|]\s*)(sudo\s+)?(shutdown|reboot|halt|poweroff)\b/i, reason: "system shutdown or reboot" },
  { pattern: /\bshutdown\s+\/[srg]\b/i, reason: "Windows shutdown or reboot" },
  { pattern: /\b(Restart-Computer|Stop-Computer)\b/i, reason: "Windows shutdown or reboot" },
  { pattern: /\bsystemctl\s+(poweroff|reboot|halt|kexec)\b/i, reason: "system shutdown or reboot" },
  { pattern: /\b(init|telinit)\s+[06]\b/i, reason: "system shutdown or reboot" }
];

export function createPermissionPolicy(options: SmartPermissionPolicyOptions = {}): RememberingPermissionPolicy {
  const mode = options.mode ?? "project";
  const readOnlyApprovals = new Set<string>();

  return {
    decide(request): PermissionDecision {
      return decidePermission(request, mode, readOnlyApprovals);
    },
    recordDecision(request, decision): void {
      if (mode !== "read-only" || decision.behavior !== "allow") return;
      const scope = permissionScope(request);
      if (scope) readOnlyApprovals.add(scope);
    }
  };
}

export function decidePermission(
  request: PermissionRequest,
  mode: PermissionMode = "project",
  readOnlyApprovals: ReadonlySet<string> = new Set()
): PermissionDecision {
  const hardline = getHardlineCommandBlock(commandFromRequest(request));
  if (hardline) {
    return {
      behavior: "deny",
      reason: hardline.reason,
      metadata: metadataWithMatch("hardline", hardline.matched)
    };
  }

  if (mode === "read-only") {
    if (request.tool.isReadOnly(request.input) || isMarkdownWrite(request)) {
      return { behavior: "allow", reason: request.tool.isReadOnly(request.input) ? "Read-only tool" : "Markdown output is allowed in read-only mode" };
    }

    const scope = permissionScope(request);
    if (scope && readOnlyApprovals.has(scope)) {
      return { behavior: "allow", reason: "Approved read-only override for this run", metadata: { scope } };
    }

    return {
      behavior: "ask",
      reason: "Read-only mode needs user approval before using mutating capabilities",
      metadata: { scope: scope ?? "tool", mode }
    };
  }

  if (request.tool.category === "terminal") {
    const classification = classifyTerminalCommand(commandFromRequest(request) ?? request.summary);
    if (classification.risk === "hardline") {
      return {
        behavior: "deny",
        reason: classification.reason,
        metadata: metadataWithMatch(classification.risk, classification.matched)
      };
    }
    if (requiresStrongConfirmation(classification)) {
      return {
        behavior: "ask",
        reason: classification.reason,
        metadata: {
          risk: classification.risk,
          recommendSnapshot: classification.risk === "destructive"
        }
      };
    }
    return {
      behavior: "allow",
      reason: mode === "full-access" ? "Full-access mode" : "Project mode allows local project work",
      metadata: { risk: classification.risk }
    };
  }

  if (isSensitiveFilesystemMutation(request)) {
    return {
      behavior: "ask",
      reason: "Sensitive file mutation requires confirmation",
      metadata: { risk: "secret", recommendSnapshot: true }
    };
  }

  return {
    behavior: "allow",
    reason: mode === "full-access" ? "Full-access mode" : "Project mode allows trusted project tools"
  };
}

export function classifyTerminalCommand(command: string): CommandClassification {
  const normalized = command.trim();
  const hardline = getHardlineCommandBlock(normalized);
  if (hardline) return hardline;

  const secret = firstMatch(SECRET_PATTERNS, normalized);
  if (secret && !isNarrowSafeRead(normalized)) {
    return { risk: "secret", reason: `Command may expose credentials or environment secrets: ${secret}`, matched: secret };
  }

  const external = firstMatch(EXTERNAL_SIDE_EFFECT_PATTERNS, normalized);
  if (external) {
    return { risk: "external-side-effect", reason: `External side-effect command: ${external}`, matched: external };
  }

  const destructive = firstMatch(DESTRUCTIVE_PATTERNS, normalized);
  if (destructive) {
    return { risk: "destructive", reason: `Destructive command pattern: ${destructive}`, matched: destructive };
  }

  const network = firstMatch(NETWORK_PATTERNS, normalized);
  if (network) {
    return { risk: "network", reason: `Network or package-management command: ${network}`, matched: network };
  }

  const write = firstMatch(WRITE_PATTERNS, normalized);
  if (write) {
    return { risk: "write", reason: `Mutating command pattern: ${write}`, matched: write };
  }

  const process = firstMatch(PROCESS_PATTERNS, normalized);
  if (process) {
    return { risk: "process", reason: `Process-control command: ${process}`, matched: process };
  }

  const read = firstMatch(SAFE_READ_PATTERNS, normalized);
  if (read) {
    return { risk: "read", reason: `Safe read-only command: ${read}`, matched: read };
  }

  return { risk: "unknown", reason: "Unknown command risk" };
}

export function getHardlineCommandBlock(command: string | undefined): CommandClassification | undefined {
  if (!command) return undefined;
  const normalized = command.trim();
  const match = HARDLINE_PATTERNS.find((item) => item.pattern.test(normalized));
  if (!match) return undefined;
  return {
    risk: "hardline",
    reason: `Blocked hardline command: ${match.reason}`,
    matched: match.pattern.source
  };
}

function requiresStrongConfirmation(classification: CommandClassification): boolean {
  return classification.risk === "destructive" || classification.risk === "secret" || classification.risk === "external-side-effect";
}

function metadataWithMatch(risk: CommandRisk, matched: string | undefined): JsonObject {
  return matched ? { risk, matched } : { risk };
}

function permissionScope(request: PermissionRequest): string | undefined {
  if (request.tool.category === "terminal") {
    const classification = classifyTerminalCommand(commandFromRequest(request) ?? request.summary);
    return `terminal:${classification.risk}`;
  }
  if (request.tool.category === "filesystem") return "filesystem:write";
  return `${request.tool.category}:${request.tool.name}`;
}

function commandFromRequest(request: PermissionRequest): string | undefined {
  const command = request.input.command;
  return typeof command === "string" ? command : undefined;
}

function isMarkdownWrite(request: PermissionRequest): boolean {
  if (request.tool.category !== "filesystem" || request.tool.isReadOnly(request.input)) return false;
  const path = stringField(request.input, "path");
  return !!path && /\.(md|markdown)$/i.test(path);
}

function isSensitiveFilesystemMutation(request: PermissionRequest): boolean {
  if (request.tool.category !== "filesystem" || request.tool.isReadOnly(request.input)) return false;
  const path = stringField(request.input, "path") ?? stringField(request.input, "targetPath") ?? "";
  return SECRET_PATTERNS.some((pattern) => pattern.test(path));
}

function firstMatch(patterns: RegExp[], input: string): string | undefined {
  return patterns.find((pattern) => pattern.test(input))?.source;
}

function isNarrowSafeRead(command: string): boolean {
  return /^git\s+(status|diff|show|log|branch|rev-parse|ls-files)(\s|$)/i.test(command) || /^rg(\s|$)/i.test(command);
}

function stringField(input: JsonObject, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}
