export type PtyCreateResult = { ptyId: string };

export type PtyCreateOptions = {
  sessionKey: string;
  cols: number;
  rows: number;
  cwd?: string;
  isStandalone?: boolean;
};

export type NormalizedPtyCreateOptions = {
  sessionKey: string;
  cols: number;
  rows: number;
  cwd?: string;
  isStandalone?: boolean;
};

export function normalizePtyCreateOptions(
  options: PtyCreateOptions
): NormalizedPtyCreateOptions | null {
  const sessionKey = (options.sessionKey || '').trim();
  if (!sessionKey) return null;
  const isStandalone =
    Boolean(options.isStandalone) || sessionKey.startsWith('standalone:');
  return {
    sessionKey,
    cols: Math.max(1, Math.floor(Number(options.cols) || 80)),
    rows: Math.max(1, Math.floor(Number(options.rows) || 24)),
    cwd: options.cwd?.trim() || undefined,
    isStandalone,
  };
}

export function createPtyCreateArgs(
  options: NormalizedPtyCreateOptions,
  readWorkspacePath: () => string,
  preferExplicitCwd = true
): NormalizedPtyCreateOptions & { cwd?: string } {
  // 独立常规终端（isStandalone === true 或 sessionKey 以 standalone: 开头）
  // 绝对不读取活动工作区路径！如果显式传入了 cwd 则用传入的，否则保持 undefined（Rust 后端自动直通系统用户家目录 dirs::home_dir()）
  if (options.isStandalone || options.sessionKey.startsWith('standalone:')) {
    return { ...options, cwd: options.cwd };
  }
  // 普通工作区终端：以授权工作区根为准（不信任可能过期的 tab cwd）；
  // 调用方显式要求优先 tab cwd 时（如用户在特定子目录新建终端）可传 true。
  const wsCwd = readWorkspacePath().trim() || undefined;
  return {
    ...options,
    cwd: preferExplicitCwd ? (options.cwd ?? wsCwd) : (wsCwd ?? options.cwd),
  };
}
