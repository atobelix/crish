/**
 * 工具展示统一模型与 25 类工具注册表（P5 T-P5-02 · ToolPresentation SSOT）。
 *
 * 5 大去重与消解流水线：
 *   1. 目标对象预提取（extractTarget / extractFallbackTarget）
 *   2. Explanation 意图优先与内含消解（意图已含目标对象或同义词根时 target 置为 undefined）
 *   3. 无 Explanation 时的动宾分离（label 仅承载动作谓词，target 承载宾语对象，严禁双写）
 *   4. 失败态错误扼要提炼（status === 'error' 时提取首行错误摘要至 target，截断 60 字符）
 *   5. 元数据预算截断（优先级：Diff 统计 > 次要指标 > 耗时，最多保留 2 项）
 */

import type { MessageToolCall } from '../../store/types';
import { t } from '../../i18n';
import { basename, parseToolArgsSafe } from './toolArgsNormalizer';
import { toolCommandType, type ToolCommandKind } from './toolCommandType';
import { toolDiffLineStats } from './toolDiffStats';
import type {
  ToolMeta,
  ToolPresentation,
  ToolPresentationOptions,
  ToolPresentationStatus,
  ToolTarget,
  ToolTargetKind,
} from './toolPresentationTypes';

export interface ToolPresentationRegistration {
  kind: ToolCommandKind;
  iconName: string;
  defaultAction: string;
  resolveAction?: (
    args: Record<string, unknown>,
    tc: MessageToolCall
  ) => string;
  extractTarget: (
    args: Record<string, unknown>,
    tc: MessageToolCall
  ) => ToolTarget | undefined;
  extractMeta?: (
    tc: MessageToolCall,
    args: Record<string, unknown>
  ) => readonly ToolMeta[];
}

function str(args: Record<string, unknown>, keys: readonly string[]): string {
  for (const k of keys) {
    const val = args[k] ?? args[k.toLowerCase()];
    if (val !== undefined && val !== null) {
      const s = String(val).trim();
      if (s && s !== '{}' && s !== '[]') return s;
    }
  }
  return '';
}

const clipText = (text: string, maxLen: number): string =>
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

const pathTarget =
  (keys: readonly string[], clickable = true) =>
  (args: Record<string, unknown>): ToolTarget | undefined => {
    const p = str(args, keys);
    return p
      ? { text: basename(p) || p, kind: 'path', clickable, tooltip: p }
      : undefined;
  };

const patternTarget =
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

const textTarget =
  (keys: readonly string[], maxLen = 48) =>
  (args: Record<string, unknown>): ToolTarget | undefined => {
    const t = str(args, keys);
    return t
      ? {
          text: clipText(t, maxLen),
          kind: 'text',
          clickable: false,
          tooltip: t,
        }
      : undefined;
  };

function defTool(
  kind: ToolCommandKind,
  iconName: string,
  defaultAction: string,
  extractTarget: ToolPresentationRegistration['extractTarget'],
  extractMeta?: ToolPresentationRegistration['extractMeta'],
  resolveAction?: ToolPresentationRegistration['resolveAction']
): ToolPresentationRegistration {
  return {
    kind,
    iconName,
    defaultAction,
    extractTarget,
    ...(extractMeta ? { extractMeta } : {}),
    ...(resolveAction ? { resolveAction } : {}),
  };
}

function resolveReadFileMeta(
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
    if (total)
      return [
        {
          type: 'metric',
          text: t('tool.action.linesTotal', '{total} 行', { total }),
        },
      ];
  }
  const sl = args.startline ?? args.start_line ?? args.StartLine;
  const el = args.endline ?? args.end_line ?? args.EndLine;
  return sl !== undefined && el !== undefined
    ? [{ type: 'metric', text: `L${sl}–${el}` }]
    : [];
}

function resolveListDirMeta(tc: MessageToolCall): readonly ToolMeta[] {
  const raw = (tc.output || '').trim();
  if (!raw) return [];
  if (raw === '(empty directory)')
    return [{ type: 'metric', text: t('tool.action.emptyDir', '空目录') }];
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

function resolveGrepMeta(tc: MessageToolCall): readonly ToolMeta[] {
  const raw = (tc.output || '').trim();
  if (!raw) return [];
  if (raw === '(no matches)')
    return [{ type: 'metric', text: t('tool.action.noMatch', '无匹配') }];
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

function resolveFileStatMeta(tc: MessageToolCall): readonly ToolMeta[] {
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

function makeDiffMeta(add: number, del: number): ToolMeta {
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

function resolveDiffMeta(
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

function resolveDurationMeta(
  tc: MessageToolCall,
  overrideDurationStr?: string | null
): readonly ToolMeta[] {
  if (overrideDurationStr && overrideDurationStr.trim()) {
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

const PATH_KEYS = [
  'target_file',
  'targetfile',
  'path',
  'filepath',
  'file_path',
  'absolutepath',
  'absolute_path',
  'file',
];
const DIR_KEYS = ['path', 'directorypath', 'directory_path', 'dir', 'target'];
const CMD_KEYS = ['commandline', 'command_line', 'command', 'cmd', 'script'];

/** 25 类内置工具权威展示注册表（与 crates/agent-tools 及 P5 §4.2.4 双向对齐） */
export const TOOL_PRESENTATION_REGISTRY: Record<
  string,
  ToolPresentationRegistration
> = {
  list_dir: defTool(
    'list',
    'folder-01',
    t('tool.action.listDir', '列出目录'),
    (args) => {
      const d = str(args, DIR_KEYS);
      return {
        text: d ? basename(d) || d : '.',
        kind: 'path',
        clickable: Boolean(d),
        tooltip: d || t('tool.action.workspaceCurrent', '当前工作区'),
      };
    },
    resolveListDirMeta
  ),
  grep_search: defTool(
    'search',
    'search-01',
    'Grep',
    patternTarget(['query', 'pattern', 'term'], true),
    resolveGrepMeta
  ),
  multi_replace_file_content: defTool(
    'edit',
    'edit-02',
    t('tool.action.editFile', '修改文件'),
    pathTarget(PATH_KEYS, true),
    (tc) => resolveDiffMeta(tc)
  ),
  read_file: defTool(
    'read',
    'file-view',
    t('tool.action.readFile', '读取文件'),
    pathTarget(PATH_KEYS, true),
    resolveReadFileMeta
  ),
  write_file: defTool(
    'write',
    'file-plus',
    t('tool.action.writeFile', '写入文件'),
    pathTarget(PATH_KEYS, true),
    (tc) => resolveDiffMeta(tc)
  ),
  run_command: defTool(
    'shell',
    'terminal',
    t('tool.action.runCommand', '运行命令'),
    (args) => {
      const cmd = str(args, CMD_KEYS);
      return cmd
        ? {
            text: clipText(cmd, 60),
            kind: 'command',
            clickable: false,
            tooltip: cmd,
          }
        : undefined;
    },
    (tc) => resolveDurationMeta(tc)
  ),
  file_stat: defTool(
    'read',
    'file-search',
    t('tool.action.fileStat', '查看文件属性'),
    pathTarget(PATH_KEYS, true),
    resolveFileStatMeta
  ),
  fuzzy_find: defTool(
    'search',
    'search-01',
    t('tool.action.fuzzyFind', '模糊查找'),
    patternTarget(['pattern', 'query', 'name'], false)
  ),
  diff_text: defTool(
    'edit',
    'file-diff',
    t('tool.action.diff', '差异对比'),
    pathTarget(PATH_KEYS, true),
    (tc) => resolveDiffMeta(tc)
  ),
  delete_file: defTool(
    'delete',
    'trash',
    t('tool.action.deleteFile', '删除文件'),
    pathTarget(PATH_KEYS, false)
  ),
  delete_dir: defTool(
    'delete',
    'trash',
    t('tool.action.deleteDir', '删除目录'),
    pathTarget(DIR_KEYS, false)
  ),
  run_subagent: defTool(
    'subagent',
    'bot',
    t('tool.action.spawnSubagent', '启动子代理'),
    textTarget(['prompt', 'task', 'role', 'description'], 48)
  ),
  wait_subagents: defTool(
    'subagent',
    'bot',
    t('tool.action.waitSubagent', '等待子代理'),
    (args) => {
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
  ),
  kill_subagent: defTool(
    'subagent',
    'bot',
    t('tool.action.killSubagent', '终止子代理'),
    textTarget(['task_id', 'taskid', 'subagent_id', 'id'], 48)
  ),
  send_message: defTool(
    'subagent',
    'send',
    t('tool.action.sendSubagentMessage', '向子代理发送消息'),
    textTarget(
      ['recipient', 'recipient_id', 'recipientid', 'task_id', 'to'],
      48
    )
  ),
  set_timer: defTool(
    'timer',
    'timer',
    t('tool.action.scheduleSet', '设置定时器'),
    (args) => {
      const sec =
        args.duration_seconds ?? args.durationseconds ?? args.duration;
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
  ),
  cancel_timer: defTool(
    'timer',
    'timer',
    t('tool.action.scheduleCancel', '取消定时器'),
    textTarget(['timer_id', 'timerid', 'task_id', 'taskid', 'id'], 48)
  ),
  create_workflow: defTool(
    'task',
    'workflow',
    t('tool.action.workflowCreate', '创建工作流'),
    textTarget(['name', 'title', 'workflow_name'], 48)
  ),
  resolve_output_dir: defTool(
    'workspace',
    'folder-cog',
    t('tool.action.resolveOutputDir', '解析产出目录'),
    pathTarget(['folder', 'path', 'dir'], true)
  ),
  project_tree: defTool(
    'workspace',
    'folder-tree',
    t('tool.action.treeGenerate', '生成工程结构树'),
    pathTarget(['path', 'root', 'dir'], true)
  ),
  search_context: defTool(
    'search',
    'search-01',
    t('tool.action.memorySearch', '检索压缩记忆'),
    patternTarget(['query', 'keyword', 'pattern'], false)
  ),
  decompress_context: defTool(
    'workspace',
    'archive',
    t('tool.action.memoryRestore', '还原记忆原文'),
    textTarget(['block_id', 'blockid', 'chunk_id', 'chunkid', 'id'], 48)
  ),
  note_query_blocks: defTool(
    'note',
    'notebook-pen',
    t('tool.action.noteQuery', '查询笔记区块'),
    patternTarget(['keyword', 'query', 'block_id', 'blockid'], false)
  ),
  read_url_content: defTool(
    'network',
    'globe-02',
    t('tool.action.webAccess', '访问网络'),
    (args) => {
      const u = str(args, ['url', 'uri', 'target_url', 'link']);
      return u
        ? { text: formatUrlHost(u), kind: 'url', clickable: false, tooltip: u }
        : undefined;
    }
  ),
  call_mcp_tool: defTool(
    'mcp',
    'plug',
    t('tool.action.mcpCall', '调用 MCP 工具'),
    () => undefined,
    undefined,
    (args) => {
      const s = str(args, ['server', 'servername', 'server_name']);
      const tName = str(args, ['tool', 'toolname', 'tool_name']);
      return s && tName
        ? `MCP [${s}:${tName}]`
        : tName
          ? `MCP [${tName}]`
          : s
            ? `MCP [${s}]`
            : t('tool.action.mcpCall', '调用 MCP 工具');
    }
  ),
};

/** 常见工具别名到 25 类权威注册表的归并映射 */
export const TOOL_PRESENTATION_ALIASES: Readonly<Record<string, string>> = {
  list_directory: 'list_dir',
  ls: 'list_dir',
  dir: 'list_dir',
  list_files: 'list_dir',
  grep: 'grep_search',
  rg: 'grep_search',
  ripgrep: 'grep_search',
  replace_file_content: 'multi_replace_file_content',
  edit_file: 'multi_replace_file_content',
  replace_string_in_file: 'multi_replace_file_content',
  apply_patch: 'multi_replace_file_content',
  view_file: 'read_file',
  open_file: 'read_file',
  cat: 'read_file',
  read_text_file: 'read_file',
  write_to_file: 'write_file',
  create_file: 'write_file',
  execute_command: 'run_command',
  run_in_terminal: 'run_command',
  bash: 'run_command',
  powershell: 'run_command',
  pwsh: 'run_command',
  find_by_name: 'fuzzy_find',
  glob: 'fuzzy_find',
  invoke_subagent: 'run_subagent',
  schedule: 'set_timer',
  fetch_url: 'read_url_content',
  read_browser_page: 'read_url_content',
  web_search: 'read_url_content',
  search_web: 'read_url_content',
  read_resource: 'call_mcp_tool',
  list_resources: 'call_mcp_tool',
};

const EXT_LANG_ALIASES: Readonly<Record<string, readonly string[]>> = {
  rs: ['rust', '.rs'],
  ts: ['typescript', '.ts'],
  tsx: ['typescript', 'react', '.tsx'],
  js: ['javascript', '.js'],
  jsx: ['javascript', 'react', '.jsx'],
  py: ['python', '.py'],
  go: ['golang', '.go'],
  md: ['markdown', '.md'],
  json: ['json', '.json'],
  css: ['css', 'style', '.css'],
  html: ['html', '.html'],
  toml: ['toml', '.toml'],
  yaml: ['yaml', '.yaml'],
  yml: ['yaml', '.yml'],
};

/** 清理并验证人类意图说明 */
export function cleanHumanExplanation(
  raw?: string | null,
  toolName?: string
): string {
  if (!raw) return '';
  const text = raw.replace(/\s+/g, ' ').trim();
  const needsApprovalZh = t('tool.action.needsApproval', '需要确认');
  if (
    !text ||
    text === needsApprovalZh ||
    text.toLowerCase() === 'needs approval' ||
    text.startsWith('{') ||
    text.startsWith('[')
  )
    return '';
  if (toolName && text.toLowerCase() === toolName.toLowerCase()) return '';
  return clipText(text, 120);
}

/** 判定 explanation 是否已内含 target（含去除引号、不带扩展名 stem 及通配符语言映射） */
export function isTargetContainedInExplanation(
  explanation: string,
  target: ToolTarget | undefined
): boolean {
  if (!explanation || !target || !target.text) return false;
  const expLower = explanation.toLowerCase();
  const stripped = target.text
    .trim()
    .replace(/^["'「『`]+|["'」』`]+$/g, '')
    .trim();
  if (!stripped || stripped === '.') return false;

  if (expLower.includes(stripped.toLowerCase())) return true;
  if (target.tooltip) {
    const tipBase = basename(target.tooltip).toLowerCase();
    if (tipBase && tipBase !== '.' && expLower.includes(tipBase)) return true;
  }

  const base = basename(stripped);
  const dotIdx = base.lastIndexOf('.');
  if (dotIdx > 0) {
    const stem = base.slice(0, dotIdx).trim();
    if (
      stem &&
      stem !== '*' &&
      stem.length >= 3 &&
      expLower.includes(stem.toLowerCase())
    )
      return true;
    const ext = base.slice(dotIdx + 1).toLowerCase();
    if (
      stem === '*' &&
      EXT_LANG_ALIASES[ext]?.some((alias) => expLower.includes(alias))
    )
      return true;
  }
  return false;
}

/** 未知工具兜底参数提取（P5 §9.1 风险 3 防御） */
export function extractFallbackTarget(
  args: Record<string, unknown>,
  _tc: MessageToolCall
): ToolTarget | undefined {
  const pathVal = str(args, PATH_KEYS);
  if (pathVal)
    return {
      text: basename(pathVal) || clipText(pathVal, 50),
      kind: 'path',
      clickable: true,
      tooltip: pathVal,
    };
  const cmdVal = str(args, CMD_KEYS);
  if (cmdVal)
    return {
      text: clipText(cmdVal, 50),
      kind: 'command',
      clickable: false,
      tooltip: cmdVal,
    };
  const urlVal = str(args, ['url', 'uri']);
  if (urlVal)
    return {
      text: formatUrlHost(urlVal),
      kind: 'url',
      clickable: false,
      tooltip: urlVal,
    };
  const queryVal = str(args, [
    'query',
    'pattern',
    'keyword',
    'prompt',
    'task',
    'action',
    'id',
  ]);
  if (queryVal)
    return {
      text: clipText(queryVal, 50),
      kind: 'text',
      clickable: false,
      tooltip: queryVal,
    };

  for (const [k, v] of Object.entries(args)) {
    if (k === '_raw' || k !== k.toLowerCase() || v === undefined || v === null)
      continue;
    const vStr = typeof v === 'object' ? JSON.stringify(v) : String(v).trim();
    if (vStr)
      return {
        text: `${k}: ${clipText(vStr, 30)}`,
        kind: 'text' as ToolTargetKind,
        clickable: false,
        tooltip: vStr,
      };
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

function mapPresentationStatus(
  status: MessageToolCall['status']
): ToolPresentationStatus {
  if (status === 'running') return 'running';
  if (status === 'error') return 'error';
  if (status === 'pending_approval') return 'pending';
  return 'success';
}

/** 构建工具调用统一展示模型（SSOT 纯函数） */
export function resolveToolPresentation(
  tc: MessageToolCall,
  humanExplanation?: string,
  options?: ToolPresentationOptions
): ToolPresentation {
  const normName = (tc.name || 'tool').toLowerCase().replace(/[\s-]+/g, '_');
  const regKey = TOOL_PRESENTATION_REGISTRY[normName]
    ? normName
    : TOOL_PRESENTATION_ALIASES[normName];
  const reg = regKey ? TOOL_PRESENTATION_REGISTRY[regKey] : undefined;

  const args = parseToolArgsSafe(tc.arguments).props;
  const kind: ToolCommandKind = reg ? reg.kind : toolCommandType(tc);
  const iconName = reg ? reg.iconName : 'wrench';
  const defaultAction = reg
    ? reg.resolveAction
      ? reg.resolveAction(args, tc)
      : reg.defaultAction
    : t('tool.action.defaultTool', '调用工具');

  let rawTarget = reg
    ? reg.extractTarget(args, tc)
    : extractFallbackTarget(args, tc);
  if (!rawTarget && options?.filePath) {
    rawTarget = {
      text: options.pathLabel || basename(options.filePath),
      kind: 'path',
      clickable: true,
      tooltip: options.filePath,
    };
  }

  const rawExp =
    humanExplanation !== undefined ? humanExplanation : tc.explanation;
  const explanation = cleanHumanExplanation(rawExp, tc.name);
  let label = explanation || defaultAction;
  let target = isTargetContainedInExplanation(label, rawTarget)
    ? undefined
    : rawTarget;

  const status = mapPresentationStatus(tc.status);
  if (status === 'error' && tc.output && tc.output.trim()) {
    const firstLine =
      tc.output
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find(Boolean) || t('tool.action.executionFailed', '执行失败');
    const cleanErr =
      firstLine.replace(/^(?:\[[^\]]+\]\s*)+/, '').trim() || firstLine;
    const errText = clipText(cleanErr, 60);
    target = {
      text: errText,
      kind: 'text',
      clickable: false,
      tooltip: tc.output.trim(),
    };
    if (label === errText) label = defaultAction;
  }

  const metaList: ToolMeta[] = [...resolveDiffMeta(tc, options?.diffStats)];
  if (reg?.extractMeta) {
    for (const m of reg.extractMeta(tc, args)) {
      if (
        (m.type === 'diff' && metaList.some((x) => x.type === 'diff')) ||
        m.type === 'duration'
      )
        continue;
      metaList.push(m);
    }
  }
  metaList.push(...resolveDurationMeta(tc, options?.durationStr));

  const meta = metaList.slice(0, 2);
  const statusZh =
    status === 'running'
      ? t('tool.action.statusRunning', '执行中')
      : status === 'error'
        ? t('tool.action.statusFailed', '失败')
        : status === 'pending'
          ? t('tool.action.statusPending', '待确认')
          : t('tool.action.statusSuccess', '完成');
  const rowAriaLabel = [
    label,
    target?.text,
    ...meta.map((m) => m.ariaLabel || m.text),
    statusZh,
  ]
    .filter(Boolean)
    .join(' · ');

  return {
    label,
    ...(target ? { target } : {}),
    meta,
    status,
    iconName,
    kind,
    rowAriaLabel,
  };
}

/** buildToolPresentation 为 resolveToolPresentation 的同义导出 */
export const buildToolPresentation = resolveToolPresentation;
