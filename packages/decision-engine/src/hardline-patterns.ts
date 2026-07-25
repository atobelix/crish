export interface HardlineEntry {
  pattern: RegExp;
  reason: string;
}

/**
 * 极危命令：任何模式下都不可静默放行。
 * 覆盖磁盘破坏、系统停机、凭据与 Windows LOLBins 等。
 */
const DEFAULT_HARDLINE_ENTRIES: HardlineEntry[] = [
  // 磁盘 / 文件系统
  { pattern: /\b(format|format\.com)\s+[A-Z]:/i, reason: "formatting a drive" },
  { pattern: /\bformat\s+(\\\\\.\\PhysicalDrive|\w+)/i, reason: "formatting a volume" },
  { pattern: /\b(Format-Volume|Clear-Disk|Remove-Partition|Initialize-Disk|diskpart)\b/i, reason: "disk or partition operation" },
  { pattern: /\bmkfs(\.[a-z0-9]+)?\b/i, reason: "formatting a filesystem" },
  { pattern: /\bmke2fs\b/i, reason: "formatting a filesystem" },
  { pattern: /\b(parted|fdisk|gdisk|sfdisk)\s+\/dev\/(sd|nvme|hd|vd|xvd|mmcblk)/i, reason: "disk partitioning" },
  { pattern: /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|hd|mmcblk|vd|xvd|loop)[a-z0-9]*/i, reason: "raw block device overwrite" },
  { pattern: />\s*\/dev\/(sd|nvme|hd|mmcblk|vd|xvd)[a-z0-9]*\b/i, reason: "raw block device overwrite" },
  { pattern: /\blvm\s+(pvremove|vgremove|lvremove)\b/i, reason: "lvm destruction" },
  { pattern: /\bflashrom\s+-w\b/i, reason: "bios flashing" },
  { pattern: /\bhdparm\s+--security/i, reason: "ata security commands" },
  { pattern: /\bcipher\s+\/w\b/i, reason: "secure wipe free space" },
  { pattern: /\bvssadmin\s+delete\s+shadows\b/i, reason: "delete volume shadows" },
  { pattern: /\bwmic\s+diskdrive\s+delete\b/i, reason: "wmic disk deletion" },

  // 关机 / 重启
  { pattern: /(^|[;&|]\s*)(sudo\s+)?(shutdown|reboot|halt|poweroff)\b/i, reason: "system shutdown or reboot" },
  { pattern: /\/(sbin|usr\/sbin)\/(shutdown|reboot|halt|poweroff)\b/i, reason: "system shutdown or reboot" },
  { pattern: /\bshutdown\s+\/[srg]\b/i, reason: "Windows shutdown or reboot" },
  { pattern: /\b(Restart-Computer|Stop-Computer)\b/i, reason: "Windows shutdown or reboot" },
  { pattern: /\bsystemctl\s+(poweroff|reboot|halt|kexec)\b/i, reason: "system shutdown or reboot" },
  { pattern: /\b(init|telinit)\s+[06]\b/i, reason: "system shutdown or reboot" },

  // 进程
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "fork bomb" },
  { pattern: /\bkill\s+(-[^\s]+\s+)*-1\b/i, reason: "kill every process" },
  { pattern: /\btaskkill\b(?=.*\/f)(?=.*\/im\s+\*)/i, reason: "kill every matching Windows process" },
  { pattern: /\bStop-Process\b(?=.*-Name\s+\*)/i, reason: "kill every matching PowerShell process" },

  // Windows 账号 / 注册表 / 引导
  { pattern: /\breg\s+(delete|add|import|restore)\b/i, reason: "registry modification" },
  { pattern: /\bbcdedit\s+\/delete\b/i, reason: "boot configuration deletion" },
  { pattern: /\b(net|net1)\s+(user|localgroup)\b.*\/add/i, reason: "user account creation" },
  { pattern: /\bschtasks\s+\/create\b/i, reason: "scheduled task creation" },
  { pattern: /\b(sc|sc\.exe)\s+(stop|delete|config)\b/i, reason: "service control" },
  { pattern: /\btakeown\s+\/f\b/i, reason: "take ownership of system paths" },
  { pattern: /\bicacls\b.*\/grant\b/i, reason: "acl grant" },
  { pattern: /\bwevtutil\s+cl\b/i, reason: "clear event log" },

  // Windows LOLBins / 远程执行
  { pattern: /\bmshta\b/i, reason: "mshta script execution" },
  { pattern: /\bcscript(\.exe)?\b/i, reason: "cscript execution" },
  { pattern: /\bwscript(\.exe)?\b/i, reason: "wscript execution" },
  { pattern: /\brun(dll32|dll)\.exe\b/i, reason: "rundll32 execution" },
  { pattern: /\bregsvr32\b/i, reason: "regsvr32 bypass" },
  { pattern: /\bbitsadmin\s+\/transfer\b/i, reason: "bitsadmin download" },
  { pattern: /\bwmic\s+(process|useraccount)\s+(call|create|delete)\b/i, reason: "wmic process or account change" },
  { pattern: /\bpowershell\b[^\n]*-enc(odedcommand)?\b/i, reason: "encoded powershell" },

  // 原始内存 / 内核
  { pattern: /\bdd\b[^\n]*\bif=\/dev\/mem\b/i, reason: "raw memory read" },
  { pattern: /\bmodprobe\s+-r\s+/i, reason: "unload kernel module" },

  // 远程代码执行：网络工具管道到解释器（不可审计的远程脚本执行）
  { pattern: /\b(curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\b.*\|\s*(bash|sh|zsh|dash|ksh|python|python3|node|perl|ruby|php|iex|Invoke-Expression)\b/i, reason: "remote code execution via piped interpreter" },

  // rm -rf 根路径（字面 / 引号包裹 — 正则不识别引号语义，覆盖各种包裹形式）
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*|-rf|-fr|--recursive\b[^\n]*--force\b|--force\b[^\n]*--recursive\b)\s+\/(\s|"|'|$)/i, reason: "recursive force delete of root filesystem" },

  // rm -rf + 动态/通配路径（变量、命令替换、波浪号、通配符、当前目录、父目录 — 值未知时可能解析为根路径）
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*|-rf|-fr)\s+(\$\w|~|\*|\.(\/|\s|$)|\.\.\/)/i, reason: "recursive force delete with dynamic or wildcard path" },

  // find / -delete / find / -exec rm（在根路径上执行破坏性 find）
  { pattern: /\bfind\s+\/(\s|$)[^\n]*(-delete|-exec\s+rm\b)/i, reason: "destructive find on root filesystem" },
];

export class HardlinePatternRegistry {
  private readonly entries: readonly HardlineEntry[];

  constructor(entries?: HardlineEntry[]) {
    this.entries = Object.freeze([...(entries ?? DEFAULT_HARDLINE_ENTRIES)]);
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
