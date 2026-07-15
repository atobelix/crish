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

/** 从工具参数字符串里尽量抽出路径 */
export function pathFromToolArgs(args: string): string | null {
  if (!args?.trim()) return null;
  try {
    const parsed = JSON.parse(args);
    if (parsed && typeof parsed === 'object') {
      for (const key of ['path', 'filePath', 'file', 'target_file', 'filename']) {
        const v = (parsed as Record<string, unknown>)[key];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
    }
  } catch {
    /* 非 JSON */
  }
  // path=... 或纯路径
  const m = args.match(/(?:^|[\s,"'])([A-Za-z]:[\\/][^\s"']+|(?:\.\/|\/)?[\w./\\-]+\.\w{1,8})/);
  if (m?.[1]) return m[1];
  const first = args.trim().split(/\s+/)[0];
  if (first && (/[\\/]/.test(first) || /\.\w+$/.test(first))) return first;
  return null;
}

/**
 * 综合结构化 diffs、统一 diff 文本、编辑工具参数，得到最佳 FileDiff 列表。
 */
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

  // 编辑工具且无 unified diff：用简短预览，勿把整段 shell 日志当地图
  if (isEditToolName(opts.name) && !isShellToolName(opts.name)) {
    const path = pathFromToolArgs(opts.args || '') || '文件';
    const preview = sanitizeToolDisplayOutput(out).trim();
    if (!preview) return [];
    // 只有像「写入成功」的短结果才合成预览行，避免 dir 列表
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
