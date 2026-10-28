/**
 * 工具展示参数与返回值解析纯函数（P5 T-P5-02 · ToolPresentation SSOT）。
 *
 * 职责：
 * 1. 工具入参提取与纯文本截断（str / clipText / formatUrlHost）
 * 2. 目标对象（Target）构造器与特化提取（pathTarget / patternTarget / textTarget / extract*Target）
 * 3. 结果元数据解析（resolveReadFileMeta / resolveListDirMeta / resolveGrepMeta / resolveFileStatMeta）
 * 4. Diff 与耗时解析（makeDiffMeta / resolveDiffMeta / resolveDurationMeta）
 * 5. 未知工具兜底提取与状态映射（extractFallbackTarget / mapPresentationStatus）
 */

import type { MessageToolCall } from '../../store/types';
import { t } from '../../i18n';
import { basename } from './toolArgsNormalizer';
import { toolDiffLineStats } from './toolDiffStats';
import type {
  ToolMeta,
  ToolPresentationStatus,
  ToolTarget,
  ToolTargetKind,
} from './toolPresentationTypes';

export const PATH_KEYS = [
  'target_file',
  'targetfile',
  'path',
  'filepath',
  'file_path',
  'absolutepath',
  'absolute_path',
  'file',
] as const;

export const DIR_KEYS = [
  'path',
  'directorypath',
  'directory_path',
  'dir',
  'target',
] as const;

export const CMD_KEYS = [
  'commandline',
  'command_line',
  'command',
  'cmd',
  'script',
] as const;

/** 安全提取指定键候选值 */
export function str(
  args: Record<string, unknown>,
  keys: readonly string[]
): string {
  for (const k of keys) {
    const val = args[k] ?? args[k.toLowerCase()];
    if (val !== undefined && val !== null) {
      const s = String(val).trim();
      if (s && s !== '{}' && s !== '[]') return s;
    }
  }
  return '';
}

/** 截断纯文本并追加省略号 */
export const clipText = (text: string, maxLen: number): string =>
  text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;

/** 提取 URL 域名或紧凑路径预览 */
export function formatUrlHost(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  try {
    const u = new URL(
      trimmed.startsWith('http') ? trimmed : `https://${trimmed}`
    );
    return u.hostname || clipText(trimmed, 32);
  } catch {
    return clipText(trimmed, 32);
  }
}

/** 路径类目标生成器 */
export const pathTarget =
  (keys: readonly string[], clickable = true) =>
  (args: Record<string, unknown>): ToolTarget | undefined => {
    const p = str(args, keys);
    return p
      ? { text: basename(p) || p, kind: 'path', clickable, tooltip: p }
      : undefined;
  };

/** 搜索模式类目标生成器 */
export const patternTarget =
  (keys: readonly string[], quoted = false) =>
  (args: Record<string, unknown>): ToolTarget | undefined => {
    const q = str(args, keys);
    return q
      ? {
          text: quoted ? `"${q}"` : q,
          kind: 'pattern',
          clickable: false,
          tooltip: q,
        }
      : undefined;
  };

/** 普通文本类目标生成器 */
export const textTarget =
  (keys: readonly string[], maxLen = 48) =>
  (args: Record<string, unknown>): ToolTarget | undefined => {
    const tVal = str(args, keys);
    return tVal
      ? {
          text: clipText(tVal, maxLen),
          kind: 'text',
          clickable: false,
          tooltip: tVal,
        }
      : undefined;
  };

/** list_dir 目标提取器 */
export function extractListDirTarget(
  args: Record<string, unknown>
): ToolTarget {
  const d = str(args, DIR_KEYS);
  return {
    text: d ? basename(d) || d : '.',
    kind: 'path',
    clickable: Boolean(d),
    tooltip: d || t('tool.action.workspaceCurrent', '当前工作区'),
  };
}

/** run_command 目标提取器 */
export function extractRunCommandTarget(
  args: Record<string, unknown>
): ToolTarget | undefined {
  const cmd = str(args, CMD_KEYS);
  return cmd
    ? {
        text: clipText(cmd, 60),
        kind: 'command',
        clickable: false,
        tooltip: cmd,
      }
    : undefined;
}

/** wait_subagents 目标提取器 */
export function extractWaitSubagentsTarget(
  args: Record<string, unknown>
): ToolTarget | undefined {
  const rawIds = args.task_ids ?? args.taskids ?? args.ids;
  if (Array.isArray(rawIds) && rawIds.length > 0) {
    return {
      text: t('tool.action.subagentTasks', '{count} 个任务', {
        count: rawIds.length,
      }),
      kind: 'text',
      clickable: false,
      tooltip: rawIds.map(String).join(', '),
    };
  }
  const single = str(args, ['task_id', 'taskid']);
  return single
    ? {
        text: t('tool.action.subagentTaskSingle', '1 个任务'),
        kind: 'text',
        clickable: false,
        tooltip: single,
      }
    : undefined;
}

/** set_timer 目标提取器 */
export function extractSetTimerTarget(
  args: Record<string, unknown>
): ToolTarget | undefined {
  const sec = args.duration_seconds ?? args.durationseconds ?? args.duration;
  if (sec !== undefined && sec !== null && String(sec).trim() !== '') {
    const text = t('tool.action.scheduleSeconds', '{seconds} 秒', {
      seconds: String(sec).trim(),
    });
    return { text, kind: 'text', clickable: false, tooltip: text };
  }
  const cron = str(args, ['cron', 'cron_expression', 'cronexpression']);
  return cron
    ? { text: cron, kind: 'text', clickable: false, tooltip: cron }
    : undefined;
}

/** read_url_content 目标提取器 */
export function extractReadUrlTarget(
  args: Record<string, unknown>
): ToolTarget | undefined {
  const u = str(args, ['url', 'uri', 'target_url', 'link']);
  return u
    ? { text: formatUrlHost(u), kind: 'url', clickable: false, tooltip: u }
    : undefined;
}

/** read_file 返回行数与范围元数据解析 */
export function resolveReadFileMeta(
  tc: MessageToolCall,
  args: Record<string, unknown>
): readonly ToolMeta[] {
  const out = tc.output || '';
  if (out) {
    const linesMatch = out.match(/^lines:\s*(\d+)$/im);
    const rangeMatch = out.match(/^startLine:\s*(\d+),\s*endLine:\s*(\d+)$/im);
    const total = linesMatch?.[1] ? parseInt(linesMatch[1], 10) : undefined;
    const sl = rangeMatch?.[1] ? parseInt(rangeMatch[1], 10) : undefined;
    const el = rangeMatch?.[2] ? parseInt(rangeMatch[2], 10) : undefined;
    if (sl !== undefined && el !== undefined && total && el - sl + 1 < total) {
      return [
        {
          type: 'metric',
          text: t('tool.action.linesRange', 'L{sl}–{el} / {total} 行', {
            sl,
            el,
            total,
          }),
        },
      ];
    }
    if (total) {
      return [
        {
          type: 'metric',
          text: t('tool.action.linesTotal', '{total} 行', { total }),
        },
      ];
    }
  }
  const sl = args.startline ?? args.start_line ?? args.StartLine;
  const el = args.endline ?? args.end_line ?? args.EndLine;
  return sl !== undefined && el !== undefined
    ? [{ type: 'metric', text: `L${sl}–${el}` }]
    : [];
}

/** list_dir 返回条目数元数据解析 */
export function resolveListDirMeta(tc: MessageToolCall): readonly ToolMeta[] {
  const raw = (tc.output || '').trim();
  if (!raw) return [];
  if (raw === '(empty directory)') {
    return [{ type: 'metric', text: t('tool.action.emptyDir', '空目录') }];
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.length > 0
    ? [
        {
          type: 'metric',
          text: t('tool.action.itemsCount', '{count} 项', {
            count: lines.length,
          }),
        },
      ]
    : [];
}

/** grep_search 返回匹配数元数据解析 */
export function resolveGrepMeta(tc: MessageToolCall): readonly ToolMeta[] {
  const raw = (tc.output || '').trim();
  if (!raw) return [];
  if (raw === '(no matches)') {
    return [{ type: 'metric', text: t('tool.action.noMatch', '无匹配') }];
  }
  const mm = raw.match(/^matches:\s*(\d+)$/im);
  if (mm?.[1]) {
    const count = parseInt(mm[1], 10);
    return [
      {
        type: 'metric',
        text:
          count === 0
            ? t('tool.action.noMatch', '无匹配')
            : t('tool.action.matchCount', '{count} 处匹配', { count }),
      },
    ];
  }
  return [];
}

/** file_stat 返回大小元数据解析 */
export function resolveFileStatMeta(tc: MessageToolCall): readonly ToolMeta[] {
  const raw = (tc.output || '').trim();
  if (!raw) return [];
  const sizeBytesMatch = raw.match(/size:\s*(\d+)\s*bytes/i);
  if (sizeBytesMatch?.[1]) {
    const bytes = parseInt(sizeBytesMatch[1], 10);
    if (Number.isFinite(bytes)) {
      if (bytes < 1024) return [{ type: 'metric', text: `${bytes} B` }];
      if (bytes < 1024 * 1024)
        return [{ type: 'metric', text: `${(bytes / 1024).toFixed(1)} KB` }];
      return [
        { type: 'metric', text: `${(bytes / (1024 * 1024)).toFixed(1)} MB` },
      ];
    }
  }
  const direct = raw.match(
    /^\s*(\d+(?:\.\d+)?\s*(?:B|KB|MB|GB|TB|字节|bytes))\b/i
  );
  return direct?.[1] ? [{ type: 'metric', text: direct[1].trim() }] : [];
}

/** 构造 Diff 元数据对象 */
export function makeDiffMeta(add: number, del: number): ToolMeta {
  return {
    type: 'diff',
    text: `+${add} -${del}`,
    add,
    del,
    ariaLabel: t('tool.action.diffLines', '新增 {add} 行，删除 {del} 行', {
      add,
      del,
    }),
  };
}

/** 解析工具调用的 Diff 增删行元数据 */
export function resolveDiffMeta(
  tc: MessageToolCall,
  overrideDiff?: { add: number; del: number } | null
): readonly ToolMeta[] {
  if (overrideDiff && (overrideDiff.add > 0 || overrideDiff.del > 0)) {
    return [makeDiffMeta(overrideDiff.add, overrideDiff.del)];
  }
  if (Array.isArray(tc.diffs) && tc.diffs.length > 0) {
    let add = 0;
    let del = 0;
    let hasExplicit = false;
    for (const d of tc.diffs) {
      if (!d || typeof d !== 'object') continue;
      const raw = d as unknown as {
        additions?: number;
        deletions?: number;
        add?: number;
        del?: number;
      };
      if (typeof raw.additions === 'number' || typeof raw.add === 'number') {
        add += Math.max(0, raw.additions ?? raw.add ?? 0);
        hasExplicit = true;
      }
      if (typeof raw.deletions === 'number' || typeof raw.del === 'number') {
        del += Math.max(0, raw.deletions ?? raw.del ?? 0);
        hasExplicit = true;
      }
    }
    if (hasExplicit || add > 0 || del > 0) return [makeDiffMeta(add, del)];
  }
  const fb = toolDiffLineStats(tc);
  return fb && (fb.add > 0 || fb.del > 0) ? [makeDiffMeta(fb.add, fb.del)] : [];
}

/** 解析工具调用的耗时元数据 */
export function resolveDurationMeta(
  tc: MessageToolCall,
  overrideDurationStr?: string | null
): readonly ToolMeta[] {
  if (typeof overrideDurationStr === 'string' && overrideDurationStr.trim()) {
    return [{ type: 'duration', text: overrideDurationStr.trim() }];
  }
  let ms =
    typeof tc.durationMs === 'number' && tc.durationMs > 0 ? tc.durationMs : 0;
  if (!ms && tc.startedAt) {
    const end = tc.completedAt ?? tc.finishedAt;
    if (end && end > tc.startedAt) ms = end - tc.startedAt;
  }
  if (ms <= 0) return [];
  const text = ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
  return [
    {
      type: 'duration',
      text,
      ariaLabel: t('tool.action.duration', '耗时 {text}', { text }),
    },
  ];
}

/** 未知工具兜底参数提取（P5 §9.1 风险 3 防御） */
export function extractFallbackTarget(
  args: Record<string, unknown>,
  _tc: MessageToolCall
): ToolTarget | undefined {
  const pathVal = str(args, PATH_KEYS);
  if (pathVal) {
    return {
      text: basename(pathVal) || clipText(pathVal, 50),
      kind: 'path',
      clickable: true,
      tooltip: pathVal,
    };
  }
  const cmdVal = str(args, CMD_KEYS);
  if (cmdVal) {
    return {
      text: clipText(cmdVal, 50),
      kind: 'command',
      clickable: false,
      tooltip: cmdVal,
    };
  }
  const urlVal = str(args, ['url', 'uri']);
  if (urlVal) {
    return {
      text: formatUrlHost(urlVal),
      kind: 'url',
      clickable: false,
      tooltip: urlVal,
    };
  }
  const queryVal = str(args, [
    'query',
    'pattern',
    'keyword',
    'prompt',
    'task',
    'action',
    'id',
  ]);
  if (queryVal) {
    return {
      text: clipText(queryVal, 50),
      kind: 'text',
      clickable: false,
      tooltip: queryVal,
    };
  }

  for (const [k, v] of Object.entries(args)) {
    if (k === '_raw' || k !== k.toLowerCase() || v === undefined || v === null)
      continue;
    const vStr = typeof v === 'object' ? JSON.stringify(v) : String(v).trim();
    if (vStr) {
      return {
        text: `${k}: ${clipText(vStr, 30)}`,
        kind: 'text' as ToolTargetKind,
        clickable: false,
        tooltip: vStr,
      };
    }
  }
  if (typeof args._raw === 'string' && args._raw.trim()) {
    const raw = args._raw.trim();
    return {
      text: clipText(raw, 50),
      kind: 'text',
      clickable: false,
      tooltip: raw,
    };
  }
  return undefined;
}

/** 映射工具调用状态为展示状态 */
export function mapPresentationStatus(
  status: MessageToolCall['status']
): ToolPresentationStatus {
  if (status === 'running') return 'running';
  if (status === 'error') return 'error';
  if (status === 'pending_approval') return 'pending';
  return 'success';
}
