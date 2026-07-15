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
      currentPath = gitHeader[2] || gitHeader[1];
      continue;
    }
    const plusFile = line.match(/^\+\+\+ (?:b\/)?(.+)$/);
    if (plusFile && plusFile[1] !== '/dev/null') {
      if (!currentPath) currentPath = plusFile[1];
      else if (currentPath.startsWith('a/') || currentPath === '/dev/null') currentPath = plusFile[1];
      continue;
    }
    const minusFile = line.match(/^--- (?:a\/)?(.+)$/);
    if (minusFile && !currentPath && minusFile[1] !== '/dev/null') {
      currentPath = minusFile[1];
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
    for (const key of ['path', 'filePath', 'file', 'target_file', 'filename']) {
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
 * 只对「真·编辑类工具」或带 git/unified diff 头的输出解析 diff。
 * 绝不可把 dir / Get-ChildItem 的 d----- 行当成 diff（会误开变更面板）。
 */
export function resolveToolDiffs(opts: {
  name: string;
  args?: string;
  output?: string;
  structuredDiffs?: FileDiff[];
}): FileDiff[] {
  if (opts.structuredDiffs?.length) return opts.structuredDiffs;

  const out = opts.output || '';
  const looksLikeGitDiff =
    /\bdiff --git\b/.test(out) ||
    /^@@\s+-\d/.test(out) ||
    (/\n--- [^\n]+\n\+\+\+ /.test(out) && /\n@@ /.test(out));

  if (looksLikeGitDiff) {
    const fromText = parseUnifiedDiffs(out);
    if (fromText.length) return fromText;
  }

  // 编辑工具：优先从参数还原 diff（改动总览/变更面板有内容）
  if (isEditToolName(opts.name) && !isShellToolName(opts.name)) {
    const fromArgs = fileDiffFromEditArgs(opts.args || '');
    if (fromArgs) return [fromArgs];

    const path = pathFromToolArgs(opts.args || '') || '文件';
    const preview = sanitizeToolDisplayOutput(out).trim();
    // 成功但无内容时仍记一笔路径，便于总览「改了哪些文件」
    if (!preview || /^(完成|OK|ok|success|写入成功|已写入|已保存)$/i.test(preview)) {
      return [
        {
          filePath: path,
          additions: 0,
          deletions: 0,
          changes: [{ type: 'normal', content: preview || '文件已更新' }],
        },
      ];
    }
    if (preview.split('\n').length > 40) return [];
    const lines = preview
      .split('\n')
      .slice(0, 40)
      .map((content) => ({ type: 'addition' as const, content }));
    return [
      {
        filePath: path,
        additions: lines.length,
        deletions: 0,
        changes: lines,
      },
    ];
  }

  return [];
}

/** 对话里展示的工具输出：去掉 exit/wall/checkpoint 元数据噪音 */
export function sanitizeToolDisplayOutput(raw: string): string {
  if (!raw) return '';
  let text = raw.replace(/\r\n/g, '\n');
  // 整段元信息块
  text = text.replace(/^Pre-mutation Git checkpoint:.*$/gim, '');
  text = text.replace(/^Exit code:\s*.*$/gim, '');
  text = text.replace(/^Wall time:\s*.*$/gim, '');
  text = text.replace(/^Duration:\s*.*$/gim, '');
  text = text.replace(/^Signal:\s*.*$/gim, '');
  text = text.replace(/^Timed out:\s*.*$/gim, '');
  text = text.replace(/^Output:\s*$/gim, '');
  text = text.replace(/^Path:\s*$/gim, '');
  // 多余空行
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text;
}
