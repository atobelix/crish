/**
 * 将工具输出解析为 Diff / 终端可用的结构化反馈（正式版）。
 */

import type { DiffChange, FileDiff } from '../store/layoutStore';

/** 是否像 shell / 命令类工具 */
export function isShellToolName(name: string): boolean {
  const n = name.toLowerCase().replace(/[\s-]+/g, '_');
  return (
    n === 'run_command' ||
    n === 'shell_command' ||
    n === 'shell' ||
    n === 'bash' ||
    n === 'exec' ||
    n === 'run_terminal_command' ||
    n === 'terminal' ||
    n.includes('shell') ||
    n.includes('command') ||
    n.includes('terminal')
  );
}

/**
 * 目录列表输出（PowerShell / cmd / Unix ls）不得被当成 unified diff。
 * d----- / -a---- / <DIR> / drwx 等行会误触发 `+/-` 解析。
 * 含表头残缺、仅 Mode 行密集输出等变体。
 */
export function looksLikeDirectoryListing(text: string): boolean {
  if (!text || text.length < 12) return false;
  const t = text.replace(/\r\n/g, '\n');
  // PowerShell Get-ChildItem / Format-Table
  if (/\bMode\s+LastWriteTime\s+Length\s+Name\b/i.test(t)) return true;
  if (/^\s*Directory:\s+\S+/m.test(t) && /\b[d\-][a\-hsr]{4,5}\b/.test(t)) return true;
  // cmd.exe `dir`
  if (/\bDirectory of\s+/i.test(t) && /<DIR>/i.test(t)) return true;
  // Unix `ls -l` / `ls -la`
  if (/^total\s+\d+\s*$/m.test(t) && /^[d\-l][rwxsStT\-]{9}\s/m.test(t)) return true;
  // 表头被截掉：≥2 行 PowerShell Mode + 日期（避免单行误伤）
  const psModes = t.match(
    /^[d\-][a\-hsr]{4,5}\s+\d{1,4}[\/\-.]\d{1,2}[\/\-.]\d{1,4}/gm,
  );
  if (psModes && psModes.length >= 2) return true;
  // 多行 Unix 权限（无 total 行时）
  const unixModes = t.match(/^[d\-l][rwxsStT\-]{9}\s+\d+\s+\S+/gm);
  if (unixModes && unixModes.length >= 3) return true;
  // cmd 多条 <DIR>
  if ((t.match(/<DIR>/gi) || []).length >= 2) return true;
  return false;
}

/** 是否像文件编辑类工具 */
export function isEditToolName(name: string): boolean {
  const n = name.toLowerCase().replace(/[\s-]+/g, '_');
  return (
    n === 'edit' ||
    n === 'write' ||
    n === 'write_file' ||
    n === 'apply_patch' ||
    n === 'apply_workspace_edits' ||
    n === 'str_replace' ||
    n === 'search_replace' ||
    n === 'create_file' ||
    n.includes('edit') ||
    n.includes('write') ||
    n.includes('patch')
  );
}

/**
 * 从统一 diff / git diff 文本解析 FileDiff 列表。
 * 支持 `diff --git`、`---`/`+++`、以及简单的 +/- 行块。
 */
export function parseUnifiedDiffs(text: string): FileDiff[] {
  if (!text || !text.includes('\n')) return [];
  // daemonChatBridge / gitApi 也会直调本函数，目录列表必须在此拦死
  if (looksLikeDirectoryListing(text)) return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');

  // 优先按 diff --git / --- +++ 分文件
  const files: FileDiff[] = [];
  let currentPath = '';
  let changes: DiffChange[] = [];
  let additions = 0;
  let deletions = 0;
  let inHunk = false;

  const flush = () => {
    if (!currentPath || changes.length === 0) {
      currentPath = '';
      changes = [];
      additions = 0;
      deletions = 0;
      inHunk = false;
      return;
    }
    files.push({
      filePath: currentPath,
      additions,
      deletions,
      changes: changes.slice(0, 400),
    });
    currentPath = '';
    changes = [];
    additions = 0;
    deletions = 0;
    inHunk = false;
  };

  for (const line of lines) {
    const gitHeader = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (gitHeader) {
      flush();
      currentPath = gitHeader[2]! || gitHeader[1]!;
      continue;
    }
    const plusFile = line.match(/^\+\+\+ (?:b\/)?(.+)$/);
    if (plusFile && plusFile[1] !== '/dev/null') {
      if (!currentPath) currentPath = plusFile[1]!;
      else if (currentPath.startsWith('a/') || currentPath === '/dev/null') currentPath = plusFile[1]!;
      continue;
    }
    const minusFile = line.match(/^--- (?:a\/)?(.+)$/);
    if (minusFile && !currentPath && minusFile[1] !== '/dev/null') {
      currentPath = minusFile[1]!;
      continue;
    }
    if (line.startsWith('@@')) {
      inHunk = true;
      changes.push({ type: 'normal', content: line });
      continue;
    }
    if (!currentPath && !inHunk) continue;

    if (line.startsWith('+') && !line.startsWith('+++')) {
      additions += 1;
      changes.push({ type: 'addition', content: line.slice(1) });
      inHunk = true;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      deletions += 1;
      changes.push({ type: 'deletion', content: line.slice(1) });
      inHunk = true;
    } else if (inHunk && (line.startsWith(' ') || line === '')) {
      changes.push({ type: 'normal', content: line.startsWith(' ') ? line.slice(1) : line });
    }
  }
  flush();

  // 无 git 头则不猜测：Windows 目录列表 d----- 会误伤
  if (files.length === 0) {
    const hasGitMarker = lines.some(
      (l) => l.startsWith('diff --git ') || /^@@\s+-\d/.test(l),
    );
    if (!hasGitMarker) return [];
    const plusCount = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
    const minusCount = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
    if (plusCount + minusCount >= 3) {
      const pathHint =
        lines.find((l) => l.startsWith('+++ '))?.replace(/^\+\+\+ (?:b\/)?/, '') ||
        lines.find((l) => l.startsWith('--- '))?.replace(/^--- (?:a\/)?/, '') ||
        '变更';
      files.push({
        filePath: pathHint === '/dev/null' ? '变更' : pathHint,
        additions: plusCount,
        deletions: minusCount,
        changes: lines.slice(0, 400).map((content) => {
          if (content.startsWith('+') && !content.startsWith('+++')) {
            return { type: 'addition' as const, content: content.slice(1) };
          }
          if (content.startsWith('-') && !content.startsWith('---')) {
            return { type: 'deletion' as const, content: content.slice(1) };
          }
          return { type: 'normal' as const, content };
        }),
      });
    }
  }

  return files;
}

/** 解析工具 arguments（支持 parameters/input 嵌套） */
function parseToolArgsObject(args: string): Record<string, unknown> | null {
  if (!args?.trim()) return null;
  try {
    const parsed = JSON.parse(args);
    if (!parsed || typeof parsed !== 'object') return null;
    const o = parsed as Record<string, unknown>;
    const inner = o.parameters ?? o.input;
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      return { ...o, ...(inner as Record<string, unknown>) };
    }
    return o;
  } catch {
    return null;
  }
}

/** 从工具参数字符串里尽量抽出路径 */
export function pathFromToolArgs(args: string): string | null {
  if (!args?.trim()) return null;
  const parsed = parseToolArgsObject(args);
  if (parsed) {
    // 与 toolPresentation 路径键对齐，避免 file_path / targetFile 漏抽
    for (const key of [
      'path',
      'filePath',
      'file_path',
      'file',
      'target_file',
      'targetFile',
      'filename',
    ]) {
      const v = parsed[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  // path=... 或纯路径
  const m = args.match(/(?:^|[\s,"'])([A-Za-z]:[\\/][^\s"']+|(?:\.\/|\/)?[\w./\\-]+\.\w{1,8})/);
  if (m?.[1]) return m[1];
  const first = args.trim().split(/\s+/)[0];
  if (first && (/[\\/]/.test(first) || /\.\w+$/.test(first))) return first;
  return null;
}

/**
 * 从编辑类工具参数合成 FileDiff（old_string/new_string、content 全量写入等）。
 * 引擎未回结构化 diffs 时，保证「改动总览」仍能出现。
 */
export function fileDiffFromEditArgs(args: string): FileDiff | null {
  const path = pathFromToolArgs(args);
  if (!path) return null;
  const parsed = parseToolArgsObject(args);
  if (!parsed) return null;

  const oldStr =
    (typeof parsed.old_string === 'string' && parsed.old_string) ||
    (typeof parsed.oldString === 'string' && parsed.oldString) ||
    (typeof parsed.old_str === 'string' && parsed.old_str) ||
    '';
  const newStr =
    (typeof parsed.new_string === 'string' && parsed.new_string) ||
    (typeof parsed.newString === 'string' && parsed.newString) ||
    (typeof parsed.new_str === 'string' && parsed.new_str) ||
    '';
  const content =
    (typeof parsed.content === 'string' && parsed.content) ||
    (typeof parsed.contents === 'string' && parsed.contents) ||
    (typeof parsed.text === 'string' && parsed.text) ||
    '';

  // search_replace / str_replace 风格
  if (oldStr || newStr) {
    const delLines = oldStr ? oldStr.replace(/\r\n/g, '\n').split('\n') : [];
    const addLines = newStr ? newStr.replace(/\r\n/g, '\n').split('\n') : [];
    const changes: DiffChange[] = [
      ...delLines.slice(0, 200).map((c) => ({ type: 'deletion' as const, content: c })),
      ...addLines.slice(0, 200).map((c) => ({ type: 'addition' as const, content: c })),
    ];
    if (!changes.length) return null;
    return {
      filePath: path,
      additions: addLines.length,
      deletions: delLines.length,
      changes: changes.slice(0, 400),
    };
  }

  // write / create 全量内容
  if (content) {
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    return {
      filePath: path,
      additions: lines.length,
      deletions: 0,
      changes: lines.slice(0, 400).map((c) => ({ type: 'addition' as const, content: c })),
    };
  }

  return null;
}

/**
 * 丢弃无路径 / 占位路径 / 空内容的 FileDiff。
 * 结构化 diffs 也走此关，避免引擎脏数据误开变更面板。
 */
export function filterPublishableFileDiffs(
  files: FileDiff[] | undefined | null,
): FileDiff[] {
  if (!files?.length) return [];
  return files.filter((f) => {
    if (!f?.filePath?.trim()) return false;
    // 与 isSafeApplyPath 对齐的轻量拒绝（避免 toolFeedback ↔ applyFileDiff 循环依赖）
    const p = f.filePath.trim();
    if (p.includes('\0')) return false;
    if (p === '变更' || p === '文件' || p === 'unknown' || p === 'untitled') return false;
    if (p.replace(/\\/g, '/').split('/').some((seg) => seg === '..')) return false;
    const changes = f.changes || [];
    if (changes.length > 0) return true;
    if ((f.additions || 0) > 0 || (f.deletions || 0) > 0) return true;
    return false;
  });
}

/**
 * 只对「真·编辑类工具」或带 git/unified diff 头的输出解析 diff。
 * 绝不可把 dir / Get-ChildItem 的 d----- 行当成 diff（会误开变更面板）。
 */
export function resolveToolDiffs(opts: {
  name: string;
  args?: string | undefined;
  output?: string | undefined;
  structuredDiffs?: FileDiff[] | undefined;
}): FileDiff[] {
  if (opts.structuredDiffs?.length) {
    return filterPublishableFileDiffs(opts.structuredDiffs);
  }

  const out = opts.output || '';

  // 目录列表优先短路：绝不进 unified / 编辑参数合成
  if (looksLikeDirectoryListing(out)) {
    return [];
  }

  const looksLikeGitDiff =
    /\bdiff --git\b/.test(out) ||
    /^@@\s+-\d/.test(out) ||
    (/\n--- [^\n]+\n\+\+\+ /.test(out) && /\n@@ /.test(out));

  if (looksLikeGitDiff) {
    const fromText = filterPublishableFileDiffs(parseUnifiedDiffs(out));
    if (fromText.length) return fromText;
  }

  // 编辑工具：优先从参数还原 diff（改动总览/变更面板有内容）
  if (isEditToolName(opts.name) && !isShellToolName(opts.name)) {
    const fromArgs = fileDiffFromEditArgs(opts.args || '');
    if (fromArgs) return filterPublishableFileDiffs([fromArgs]);

    const path = pathFromToolArgs(opts.args || '');
    // 无可靠路径时不合成占位「文件」（不可应用、也不可发布）
    if (!path) return [];
    const preview = sanitizeToolDisplayOutput(out).trim();
    // 成功但无内容时仍记一笔路径，便于总览「改了哪些文件」
    if (!preview || /^(完成|OK|ok|success|写入成功|已写入|已保存)$/i.test(preview)) {
      return filterPublishableFileDiffs([
        {
          filePath: path,
          additions: 0,
          deletions: 0,
          changes: [{ type: 'normal', content: preview || '文件已更新' }],
        },
      ]);
    }
    if (preview.split('\n').length > 40) return [];
    const lines = preview
      .split('\n')
      .slice(0, 40)
      .map((content) => ({ type: 'addition' as const, content }));
    return filterPublishableFileDiffs([
      {
        filePath: path,
        additions: lines.length,
        deletions: 0,
        changes: lines,
      },
    ]);
  }

  return [];
}

/** 对话里展示的工具输出：只留命令结果，剥系统/元数据噪音 */
export function sanitizeToolDisplayOutput(raw: string): string {
  if (!raw) return '';
  let text = raw.replace(/\r\n/g, '\n');
  // ANSI / 控制符
  // eslint-disable-next-line no-control-regex
  text = text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
  text = text.replace(/\r/g, '');

  // 整段元信息行（引擎 / shell 包装）
  text = text.replace(/^Pre-mutation Git checkpoint:.*$/gim, '');
  text = text.replace(/^Post-mutation Git checkpoint:.*$/gim, '');
  text = text.replace(/^Workspace checkpoint:.*$/gim, '');
  text = text.replace(/^Checkpoint (?:created|restored|id|path):.*$/gim, '');
  text = text.replace(/^Exit code:\s*.*$/gim, '');
  text = text.replace(/^Wall time:\s*.*$/gim, '');
  text = text.replace(/^Duration:\s*.*$/gim, '');
  text = text.replace(/^Elapsed:\s*.*$/gim, '');
  text = text.replace(/^Signal:\s*.*$/gim, '');
  text = text.replace(/^Timed out:\s*.*$/gim, '');
  text = text.replace(/^Working directory:\s*.*$/gim, '');
  text = text.replace(/^Current directory:\s*.*$/gim, '');
  text = text.replace(/^CWD:\s*.*$/gim, '');
  text = text.replace(/^Shell:\s*.*$/gim, '');
  text = text.replace(/^Command:\s*$/gim, '');
  text = text.replace(/^Output:\s*$/gim, '');
  text = text.replace(/^Path:\s*$/gim, '');
  text = text.replace(/^Stdout:\s*$/gim, '');
  text = text.replace(/^Stderr:\s*$/gim, '');
  text = text.replace(/^STDERR:\s*$/gim, '');
  text = text.replace(/^STDOUT:\s*$/gim, '');
  // PowerShell CLIXML / 进度噪音
  text = text.replace(/^#<\s*CLIXML[\s\S]*$/gim, '');
  text = text.replace(/^Preparing modules for first use\..*$/gim, '');
  // 通用「系统提示」包装行
  text = text.replace(/^\[(?:system|runtime|engine|daemon)\]\s*.*$/gim, '');
  text = text.replace(/^系统提示[：:].*$/gim, '');
  text = text.replace(/^\[crish[^\]]*\]\s*.*$/gim, '');

  // 多余空行
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

// ─── 工具结果分类 / 结构化反馈（不发明 success toast） ───────────────────────

/** 成功 / 失败 / 部分完成 / 取消 / 进行中 / 待确认 */
export type ToolFeedbackKind =
  | 'success'
  | 'error'
  | 'partial'
  | 'cancelled'
  | 'running'
  | 'pending';

export interface ClassifyToolOutcomeInput {
  name?: string;
  status?: string | null;
  output?: string | null;
  /** 独立 stderr；空白不得把 success 打成 partial/error */
  stderr?: string | null;
  exitCode?: number | null;
  cancelled?: boolean;
  /** 上游已标记截断 */
  truncated?: boolean;
  diffs?: FileDiff[] | null;
  args?: string;
}

export interface ToolFeedback {
  kind: ToolFeedbackKind;
  /** 短中文主文案（行内 / 结构化反馈） */
  message: string;
  /** 清洗后详情（可截断） */
  detail: string;
  truncated: boolean;
  /** 如「+3 −1 · src/a.ts」 */
  diffHint: string | null;
  /**
   * 编辑类且有可发布 diff 时的撤销友好提示。
   * 仅文案结构，不触发 toast；成功无撤销场景应静默。
   */
  undoHint: string | null;
  /**
   * 是否适合 toast。策略：仅 error 为 true；
   * success / partial / cancelled / running / pending 均为 false（不发明成功 toast）。
   */
  toastable: boolean;
}

const CANCEL_SIGNAL_RE =
  /已取消|用户取消|cancelled by user|canceled by user|user\s*(?:cancel|abort)|aborted by user|interrupted by user|上次会话中断|会话中断/i;

const PARTIAL_SIGNAL_RE =
  /部分成功|部分失败|部分完成|完成但有警告|partial(?:ly)?\s+(?:succeeded|failed|complete|done)|completed with warnings?/i;

/** 空白 / 仅换行的流视为空（空 stderr 不改分类） */
export function isEmptyToolStream(text: string | null | undefined): boolean {
  return !text || !String(text).trim();
}

/** 输出或标志是否表示用户取消 / 会话中断 */
export function isCancelledToolSignal(
  input: Pick<ClassifyToolOutcomeInput, 'cancelled' | 'output' | 'stderr' | 'status'>,
): boolean {
  if (input.cancelled === true) return true;
  const blob = `${input.output || ''}\n${input.stderr || ''}`;
  if (CANCEL_SIGNAL_RE.test(blob)) return true;
  const st = (input.status || '').toLowerCase();
  if (st === 'cancelled' || st === 'canceled' || st === 'aborted') return true;
  return false;
}

/**
 * 从原始工具输出解析 Exit code（sanitize 会剥掉该行，须在清洗前调用）。
 */
export function parseExitCodeFromToolOutput(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = String(raw).match(/^\s*Exit code:\s*(-?\d+)\s*$/im);
  if (!m) {
    const loose = String(raw).match(/\bExit code:\s*(-?\d+)\b/i);
    if (!loose) return null;
    const n = Number(loose[1]);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function resolveExitCode(input: ClassifyToolOutcomeInput): number | null {
  if (input.exitCode != null && Number.isFinite(Number(input.exitCode))) {
    return Number(input.exitCode);
  }
  return parseExitCodeFromToolOutput(input.output);
}

function hasPartialSignal(input: ClassifyToolOutcomeInput): boolean {
  if (input.truncated) return true;
  if (!isEmptyToolStream(input.stderr)) return true;
  const blob = `${input.output || ''}\n${input.stderr || ''}`;
  if (PARTIAL_SIGNAL_RE.test(blob)) return true;
  // 展示层截断标记
  if (/…（(?:已截断|共 \d+ 行)/.test(blob) || /\btruncated\b/i.test(blob)) return true;
  return false;
}

/**
 * 分类工具结果。
 * 优先级：cancelled → running/pending → 非零 exit → status error → partial → success。
 * 空 stderr 不得把 success 打成 partial。
 */
export function classifyToolOutcome(input: ClassifyToolOutcomeInput): ToolFeedbackKind {
  if (isCancelledToolSignal(input)) return 'cancelled';

  const st = (input.status || '').toLowerCase().trim();
  if (st === 'running' || st === 'in_progress' || st === 'in-progress') return 'running';
  if (st === 'pending_approval' || st === 'pending' || st === 'awaiting_approval') {
    return 'pending';
  }

  const exit = resolveExitCode(input);
  if (exit != null && exit !== 0) return 'error';

  if (st === 'error' || st === 'failed' || st === 'failure') return 'error';

  // 成功态但有警告 stderr / 截断 / 部分完成文案
  if (hasPartialSignal(input)) {
    // 明确失败 status 已在上面处理；此处覆盖 success 或缺 status
    if (!st || st === 'success' || st === 'ok' || st === 'completed' || st === 'done') {
      return 'partial';
    }
  }

  if (st === 'success' || st === 'ok' || st === 'completed' || st === 'done') return 'success';
  if (exit === 0) return 'success';

  // 无 status：有输出按成功（调用方未标失败）；全空也归 success 占位由 message 表达
  if (!st) return 'success';
  return 'success';
}

/** 按 Unicode 码点截断，避免切断代理对 / 中文 */
export function safeTruncateChars(text: string, maxChars: number): string {
  if (!text || maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return chars.slice(0, maxChars).join('');
}

/**
 * 大输出截断（中文省略号、行数/字符双重上限）。
 * 供结构化反馈 detail 使用；不抛异常。
 */
export function truncateToolFeedbackOutput(
  raw: string | null | undefined,
  opts?: { maxChars?: number; maxLines?: number },
): { text: string; truncated: boolean } {
  const maxChars = opts?.maxChars ?? 2000;
  const maxLines = opts?.maxLines ?? 40;
  if (!raw) return { text: '', truncated: false };
  let text = sanitizeToolDisplayOutput(raw);
  if (!text) return { text: '', truncated: false };

  let truncated = false;
  const lines = text.split('\n');
  if (lines.length > maxLines) {
    text = `${lines.slice(0, maxLines).join('\n')}\n…（共 ${lines.length} 行，已截断）`;
    truncated = true;
  }
  const charCount = Array.from(text).length;
  if (charCount > maxChars) {
    text = `${safeTruncateChars(text, Math.max(1, maxChars - 1))}…（已截断）`;
    truncated = true;
  }
  return { text, truncated };
}

function basenamePath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || p;
}

/** 可发布 diff 的 ± 摘要；无可发布项返回 null */
export function buildToolDiffHint(files: FileDiff[] | null | undefined): string | null {
  const list = filterPublishableFileDiffs(files);
  if (!list.length) return null;
  let add = 0;
  let del = 0;
  for (const f of list) {
    add += f.additions || 0;
    del += f.deletions || 0;
  }
  const parts: string[] = [];
  if (add > 0) parts.push(`+${add}`);
  if (del > 0) parts.push(`−${del}`);
  const stat = parts.length ? parts.join(' ') : '有变更';
  if (list.length === 1) {
    return `${stat} · ${basenamePath(list![0]!.filePath)}`;
  }
  return `${stat} · ${list.length} 个文件`;
}

/**
 * 撤销友好提示：仅编辑类 + 可发布 diff + success/partial。
 * 不表示已 toast；shell 仅 diff 预览不给 undo。
 */
export function buildToolUndoHint(opts: {
  kind: ToolFeedbackKind;
  name?: string;
  diffs?: FileDiff[] | null;
}): string | null {
  if (opts.kind !== 'success' && opts.kind !== 'partial') return null;
  const list = filterPublishableFileDiffs(opts.diffs);
  if (!list.length) return null;
  const name = opts.name || '';
  // shell 输出 git diff 不代表本端已写入，不可暗示撤销
  if (name && isShellToolName(name) && !isEditToolName(name)) return null;
  if (name && !isEditToolName(name) && !isShellToolName(name)) {
    // 非编辑工具但有引擎结构化 diffs：仍给查看提示
    return '可在变更面板查看详情。';
  }
  if (!name || isEditToolName(name)) {
    return '可在变更面板查看；不需要时可用撤销还原。';
  }
  return null;
}

/** 短中文主文案（不夹带 stack / 不发明「成功」营销语） */
export function formatToolFeedbackMessage(
  kind: ToolFeedbackKind,
  input: ClassifyToolOutcomeInput = {},
): string {
  switch (kind) {
    case 'running':
      return '执行中…';
    case 'pending':
      return '待确认';
    case 'cancelled':
      return '已取消';
    case 'success': {
      const name = input.name || '';
      if (name && isEditToolName(name) && !isShellToolName(name)) {
        const n = filterPublishableFileDiffs(input.diffs).length;
        return n > 0 ? '文件已更新' : '完成';
      }
      if (name && isShellToolName(name)) return '命令已完成';
      return '完成';
    }
    case 'partial': {
      if (input.truncated || /…（(?:已截断|共 \d+ 行)/.test(input.output || '')) {
        return '结果已截断（部分输出）';
      }
      if (!isEmptyToolStream(input.stderr)) return '完成，但有警告输出';
      return '部分完成';
    }
    case 'error': {
      const clean = sanitizeToolDisplayOutput(input.output || input.stderr || '').trim();
      if (clean) {
        const first = (clean.split('\n').find((l) => l.trim()) || clean).trim();
        const sliced = safeTruncateChars(first, 80);
        return sliced.length < Array.from(first).length ? `${sliced}…` : sliced;
      }
      const exit = resolveExitCode(input);
      if (exit != null && exit !== 0) return `执行失败（退出码 ${exit}）`;
      return '执行失败';
    }
    default:
      return '完成';
  }
}

/**
 * 组装结构化工具反馈。
 * toastable 仅 error 为 true——调用方不得据此弹成功 toast。
 */
export function buildToolFeedback(
  input: ClassifyToolOutcomeInput & {
    maxDetailChars?: number;
    maxDetailLines?: number;
  },
): ToolFeedback {
  const kind = classifyToolOutcome(input);
  // detail 优先 stdout；stderr 非空时附在后（空 stderr 不拼接）
  let rawDetail = input.output || '';
  if (!isEmptyToolStream(input.stderr)) {
    rawDetail = rawDetail
      ? `${rawDetail}\n${String(input.stderr).trim()}`
      : String(input.stderr).trim();
  }
  const { text, truncated: detailTrunc } = truncateToolFeedbackOutput(rawDetail, {
    ...(input.maxDetailChars !== undefined && { maxChars: input.maxDetailChars }),
    ...(input.maxDetailLines !== undefined && { maxLines: input.maxDetailLines }),
  });
  const truncated = Boolean(input.truncated) || detailTrunc;
  // 若仅因 detail 截断且原 kind 为 success，与 classify 的 truncated 标志对齐
  const effectiveKind =
    kind === 'success' && truncated && !isCancelledToolSignal(input) ? 'partial' : kind;

  const diffs = input.diffs;
  const diffHint = buildToolDiffHint(diffs);
  const undoHint = buildToolUndoHint({
    kind: effectiveKind,
    ...(input.name !== undefined && { name: input.name }),
    ...(diffs !== undefined && { diffs }),
  });
  const message = formatToolFeedbackMessage(effectiveKind, {
    ...input,
    ...(truncated !== undefined && { truncated: truncated || input.truncated }),
  });

  return {
    kind: effectiveKind,
    message,
    detail: text,
    truncated,
    diffHint,
    undoHint,
    toastable: effectiveKind === 'error',
  };
}
