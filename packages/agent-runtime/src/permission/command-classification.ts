/**
 * @deprecated command classification 已迁移到 @crish/decision-engine。此文件仅为向后兼容保留。
 */

export type CommandRisk =
  | "read" | "write" | "network" | "process" | "destructive" | "secret" | "external-side-effect" | "hardline" | "unknown";

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

const HARDLINE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
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
  { pattern: /\b(init|telinit)\s+[06]\b/i, reason: "system shutdown or reboot" },
];

/** @deprecated 使用 decision-engine 的 HardlinePatternRegistry */
export function getHardlineCommandBlock(command: string | undefined): CommandClassification | undefined {
  if (!command) return undefined;
  const normalized = command.trim();
  for (const entry of HARDLINE_PATTERNS) {
    if (entry.pattern.test(normalized)) {
      return { risk: "hardline", reason: entry.reason, matched: entry.pattern.source };
    }
  }
  return undefined;
}

/** @deprecated 使用 decision-engine 的 classifyCommand */
export function classifyTerminalCommand(command: string): CommandClassification {
  const normalized = command.trim();
  if (!normalized) return { risk: "unknown", reason: "No command provided" };
  if (SAFE_READ_PATTERNS.some((p) => p.test(normalized))) {
    return { risk: "read", reason: "Read-only command" };
  }
  return { risk: "write", reason: "Unclassified command" };
}
