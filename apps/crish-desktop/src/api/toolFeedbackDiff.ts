/**
 * toolFeedback Diff 解析域：工具名识别 / 目录列表拦截 / unified diff 解析 /
 * 编辑参数合成 / 可发布 diff 过滤 / resolveToolDiffs 调度 / 输出清洗。
 * 从 toolFeedbackLogic.ts 拆出，保持消费方 import 路径不变（hub 仍 re-export）。
 * sanitizeToolDisplayOutput 无其他模块依赖，置于本文件以避免与 logic 循环依赖。
 */

import type { DiffChange, FileDiff } from '../store/layoutStore';

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
  if (/^\s*Directory:\s+\S+/m.test(t) && /\b[d-][a\-hsr]{4,5}\b/.test(t)) return true;
  // cmd.exe `dir`
  if (/\bDirectory of\s+/i.test(t) && /<DIR>/i.test(t)) return true;
  // Unix `ls -l` / `ls -la`
  if (/^total\s+\d+\s*$/m.test(t) && /^[d\-l][rwxsStT-]{9}\s/m.test(t)) return true;
  // 表头被截掉：≥2 行 PowerShell Mode + 日期（避免单行误伤）
  const psModes = t.match(
    /^[d-][a\-hsr]{4,5}\s+\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4}/gm,
  );
  if (psModes && psModes.length >= 2) return true;
  // 多行 Unix 权限（无 total 行时）
  const unixModes = t.match(/^[d\-l][rwxsStT-]{9}\s+\d+\s+\S+/gm);
  if (unixModes && unixModes.length >= 3) return true;
  // cmd 多条 <DIR>
  if ((t.match(/<DIR>/gi) || []).length >= 2) return true;
  return false;
}

/** 是否像文件编辑类工具 */
export function isEditToolName(name: string): boolean {
  const n = name.toLowerCase().replace(/[\s-]+/g, '_');
  if (isShellToolName(n)) return false;
  return (
    n === 'edit' ||
    n === 'write' ||
    n === 'write_file' ||
    n === 'write_to_file' ||
    n === 'replace_file_content' ||
    n === 'apply_patch' ||
    n === 'apply_diff' ||
    n === 'apply_workspace_edits' ||
    n === 'str_replace' ||
    n === 'search_replace' ||
    n === 'create_file' ||
    n.includes('edit') ||
    n.includes('write') ||
    n.includes('patch') ||
    n.includes('replace')
  );
}

/**
 * 从统一 diff / git diff 文本解析 FileDiff 列表。
 * 支持 `diff --git`、`---`/`+++`、以及简单的 +/- 行块。
 */
export function parseUnifiedDiffs(text: string): FileDiff[] {
  if (!text || !text.includes('\n')) return [];
  // chatBridge / gitApi 也会直调本函数，目录列表必须在此拦死
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
  // 核心契约：只有在实际编辑/修改文件的工具调用时，才展示差异变化；
  // 查看代码差异、检查命令（如 git diff、git show、view_file 等）绝不展示差异内容展开
  if (!isEditToolName(opts.name)) {
    return [];
  }

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
