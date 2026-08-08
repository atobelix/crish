/**
 * 终端面板：直接调用系统 PowerShell（Windows）/ bash（其它）。
 * 经 Tauri workbench_run_shell，不经 daemon 审批。
 */

export type TerminalShellResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  shell: string;
  cwd: string;
  durationMs: number;
  truncated: boolean;
};

/**
 * 是否应走系统 shell 执行（非 clear 内建、非空）。
 * UI 在 Enter 时先过滤 clear，再调用此判断。
 */
export function shouldExecuteTerminalInput(raw: string): boolean {
  const t = (raw || '').trim();
  if (!t) return false;
  if (t.toLowerCase() === 'clear') return false;
  return true;
}

/** 将结果拆成终端缓冲行（无前缀元数据噪音） */
export function shellResultToLines(result: TerminalShellResult): string[] {
  const lines: string[] = [];
  const out = [result.stdout.trimEnd(), result.stderr.trimEnd()]
    .filter(Boolean)
    .join('\n')
    .replace(/\r\n/g, '\n');
  if (out) {
    for (const line of out.split('\n')) lines.push(line);
  }
  if (!out && !result.timedOut) {
    lines.push('(无输出)');
  }
  if (result.timedOut) {
    lines.push('(命令超时)');
  } else if (result.exitCode != null && result.exitCode !== 0) {
    lines.push(`(exit ${result.exitCode})`);
  }
  if (result.truncated) {
    lines.push('(输出已截断)');
  }
  return lines;
}
