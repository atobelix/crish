export interface HardlineEntry {
  pattern: RegExp;
  reason: string;
}

const DEFAULT_HARDLINE_ENTRIES: HardlineEntry[] = [
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

export class HardlinePatternRegistry {
  private readonly entries: readonly HardlineEntry[];
  private frozen = false;

  constructor(entries?: HardlineEntry[]) {
    this.entries = Object.freeze([...(entries ?? DEFAULT_HARDLINE_ENTRIES)]);
    this.frozen = true;
  }

  isHardline(command: string): HardlineEntry | null {
    for (const entry of this.entries) {
      if (entry.pattern.test(command)) return entry;
    }
    return null;
  }

  getEntries(): readonly HardlineEntry[] {
    return this.entries;
  }
}

export const DEFAULT_HARDLINE_REGISTRY = new HardlinePatternRegistry();
