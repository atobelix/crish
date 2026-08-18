import type { SessionMessage, FileDiff } from '../store/types';

/** 产生物理文件写入与变更的合法工具名称白名单 */
const FILE_MUTATING_TOOLS = new Set([
  'write_file',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'apply_diff',
  'edit_file',
]);

/**
 * 跨平台 Posix 路径全量归一化：
 * 1. 反斜杠转正斜杠；
 * 2. 切除 Windows 盘符前导斜杠（如 /C:/ -> C:/）；
 * 3. Windows 盘符统一转小写（如 C:/ -> c:/）；
 * 4. 剥离工作区路径前缀（若提供）；
 * 5. 去除多余前导斜杠。
 */
export function normalizeSessionFilePath(rawPath: string, workspaceRoot?: string): string {
  if (!rawPath) return '';
  let p = rawPath.replace(/\\/g, '/').trim();
  p = p.replace(/^\/+([A-Za-z]:)/, '$1');
  p = p.replace(/^([A-Za-z]):/, (_, drive) => `${drive.toLowerCase()}:`);

  if (workspaceRoot) {
    let ws = workspaceRoot.replace(/\\/g, '/').trim();
    ws = ws.replace(/^\/+([A-Za-z]:)/, '$1');
    ws = ws.replace(/^([A-Za-z]):/, (_, drive) => `${drive.toLowerCase()}:`);
    if (!ws.endsWith('/')) {
      ws += '/';
    }
    if (p.startsWith(ws)) {
      p = p.slice(ws.length);
    }
  }

  return p.replace(/^\/+/, '');
}

/** 拦截非成功的脏 ToolCall 状态集合 */
const INVALID_TOOL_STATUSES = new Set([
  'error',
  'cancelled',
  'rejected',
  'aborted',
  'pending_approval',
]);

/**
 * 纯函数：从指定会话的消息列表中即时派生该会话专属的文件变更清单
 *
 * @param messages 当前会话的消息历史数组
 * @param workspaceRoot 可选工作区根路径，用于剥离绝对路径前缀
 * @returns 该会话产生的 FileDiff 数组
 */
export function selectSessionDiffFiles(
  messages: readonly SessionMessage[] | undefined,
  workspaceRoot?: string
): FileDiff[] {
  // 1. 空态与空白消息历史快速短路返回空数组
  if (!messages || messages.length === 0) {
    return [];
  }

  const fileMap = new Map<string, FileDiff>();

  for (const msg of messages) {
    if (!msg.toolCalls || msg.toolCalls.length === 0) {
      continue;
    }

    for (const tc of msg.toolCalls) {
      // 1. 守卫拦截：严格阻断执行报错、被取消、被拒绝或中止的脏 ToolCall 渗透
      if (
        (tc.status && INVALID_TOOL_STATUSES.has(tc.status)) ||
        (tc as unknown as Record<string, unknown>).error
      ) {
        continue;
      }

      // 2. 结构化名称提取
      const fnName = tc.name || (tc as unknown as { function?: { name?: string } }).function?.name || '';

      // 仅拦截产生文件写入/变更的合法工具名称
      if (FILE_MUTATING_TOOLS.has(fnName)) {
        try {
          const rawArgs =
            tc.arguments ??
            (tc as unknown as { function?: { arguments?: unknown } }).function?.arguments;
          const args = (
            typeof rawArgs === 'string'
              ? JSON.parse(rawArgs)
              : rawArgs || {}
          ) as Record<string, unknown>;

          const rawFilePath = (
            args.target_file ||
            args.TargetFile ||
            args.targetFile ||
            args.path ||
            args.file_path ||
            args.filePath
          ) as string | undefined;

          if (rawFilePath && typeof rawFilePath === 'string') {
            // 3. 跨平台 Posix 路径全量归一化：支持 Windows 盘符小写与工作区前缀剥离
            const normalizedPath = normalizeSessionFilePath(rawFilePath, workspaceRoot);
            const existing = fileMap.get(normalizedPath);
            const isCreation = (fnName === 'write_file' || fnName === 'write_to_file') && !existing;

            let add = Number(args.additions);
            let del = Number(args.deletions);

            const codeContent =
              args.CodeContent ?? args.codeContent ?? args.code_content ?? args.content;
            const replacementContent =
              args.ReplacementContent ??
              args.replacementContent ??
              args.replacement_content;
            const targetContent =
              args.TargetContent ?? args.targetContent ?? args.target_content;
            const replacementChunks =
              args.ReplacementChunks ??
              args.replacementChunks ??
              args.replacement_chunks;

            if (Number.isNaN(add)) {
              if (codeContent != null) {
                add = String(codeContent).split('\n').length;
              } else if (replacementContent != null) {
                add = String(replacementContent).split('\n').length;
              } else if (Array.isArray(replacementChunks)) {
                add = (
                  replacementChunks as Array<{
                    ReplacementContent?: string;
                    replacementContent?: string;
                    replacement_content?: string;
                  }>
                ).reduce((sum, chunk) => {
                  const rc =
                    chunk.ReplacementContent ??
                    chunk.replacementContent ??
                    chunk.replacement_content;
                  return sum + (rc ? String(rc).split('\n').length : 0);
                }, 0);
              } else {
                add = 1;
              }
            }

            if (Number.isNaN(del)) {
              if (targetContent != null) {
                del = String(targetContent).split('\n').length;
              } else if (Array.isArray(replacementChunks)) {
                del = (
                  replacementChunks as Array<{
                    TargetContent?: string;
                    targetContent?: string;
                    target_content?: string;
                  }>
                ).reduce((sum, chunk) => {
                  const tcVal =
                    chunk.TargetContent ??
                    chunk.targetContent ??
                    chunk.target_content;
                  return sum + (tcVal ? String(tcVal).split('\n').length : 0);
                }, 0);
              } else {
                del = 0;
              }
            }

            fileMap.set(normalizedPath, {
              filePath: normalizedPath,
              gitStatus: existing?.gitStatus || (isCreation ? 'A' : 'M'),
              additions: (existing?.additions || 0) + add,
              deletions: (existing?.deletions || 0) + del,
              changes: existing?.changes || [],
            });
          }
        } catch {
          // 安全容错：跳过参数解析异常的脏数据
        }
      }
    }
  }

  return Array.from(fileMap.values());
}
