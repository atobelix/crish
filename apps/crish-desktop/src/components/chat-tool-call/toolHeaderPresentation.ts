/**
 * apps/crish-desktop/src/components/chat-tool-call/toolHeaderPresentation.ts
 *
 * 工具行头部展现语义解析与次要指标提炼（DIM-04 专项）
 * 纯业务逻辑模块，从 ToolCallHeader.tsx 解耦抽离以满足行数门禁 (≤ 518 行)
 */

import type { MessageToolCall } from '../../store/types';
import type { ToolTarget } from '../../api/tool-presentation/toolPresentationTypes';
import { t } from '../../i18n';
import {
  extractToolCommand,
  toolCommandPreview,
  basename,
  deriveFlatScalarSummary,
} from '../../api/toolPresentation';
import { isEditToolName, isShellToolName } from '../../api/toolFeedback';
import type { ToolHumanLabelSource } from '../../api/tool-presentation/toolHumanDescriptions';
import {
  parseReadFileOutput,
  parseGrepSearchOutput,
  parseFileStatOutput,
} from './toolOutputParser';

export interface ResolvedToolAction {
  actionText: string;
  paramText: string;
  isPath: boolean;
}

/** 严格防裸奔安全阀：严禁任何原始 JSON 结构或键值倾倒直接呈现在行头 */
export function sanitizeParamText(text: string): string {
  if (!text) return '';
  const trimmed = text.trim();
  return trimmed.startsWith('{') ||
    trimmed.startsWith('[') ||
    trimmed === '{}' ||
    trimmed === '[]'
    ? ''
    : trimmed;
}

/**
 * 兜底提取入参中的核心值或有效属性（如果无法识别具体工具，将输入内容直接紧凑展示）
 */
export function extractFallbackParam(name: string, args?: string): string {
  if (!args) return '';
  const trimmed = args.trim();
  if (!trimmed || trimmed === '{}' || trimmed === '[]') return '';

  try {
    const obj = JSON.parse(trimmed);
    if (typeof obj === 'string') return obj;
    if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj);
    if (typeof obj === 'object' && obj !== null) {
      // 1. 优先提取常规目标字段
      const candidateKeys = [
        'path',
        'Path',
        'filePath',
        'filepath',
        'directorypath',
        'DirectoryPath',
        'dir',
        'query',
        'Query',
        'pattern',
        'Pattern',
        'url',
        'Url',
        'uri',
        'command',
        'CommandLine',
        'cmd',
        'prompt',
        'task',
        'role',
        'action',
        'tabId',
      ];
      for (const k of candidateKeys) {
        if (obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim()) {
          const val = String(obj[k]).trim();
          return val.length > 50 ? val.slice(0, 50) + '…' : val;
        }
      }

      // 2. 提取前两项 key: 值——对象/数组只给「键名 + 类型占位」（HC1 · D-4）
      const entries = Object.entries(obj).filter(
        ([_, v]) => v !== undefined && v !== null
      );
      if (entries.length > 0) {
        const parts = entries.slice(0, 2).map(([k, v]) => {
          if (Array.isArray(v)) return `${k}: [数组 ×${v.length}]`;
          if (typeof v === 'object') {
            return `${k}: {对象 ×${Object.keys(v as Record<string, unknown>).length}}`;
          }
          const vStr = String(v);
          return `${k}: ${vStr.length > 20 ? vStr.slice(0, 20) + '…' : vStr}`;
        });
        return parts.join(', ');
      }
    }
  } catch {
    return trimmed.length > 50 ? trimmed.slice(0, 50) + '…' : trimmed;
  }
  return '';
}

/** 动词时态映射表（特例动词采用映射，通用动作词自动规则派生） */
const VERB_TENSE: Record<string, { done: string; doing: string }> = {
  读取: { done: '已读取', doing: '读取中' },
  写入: { done: '已写入', doing: '写入中' },
  编辑: { done: '已编辑', doing: '编辑中' },
  修改: { done: '已修改', doing: '修改中' },
  列出目录: { done: '已列出目录', doing: '列出中' },
  差异对比: { done: '已对比', doing: '对比中' },
  搜索网络: { done: '已搜索', doing: '搜索中' },
  搜索: { done: '已搜索', doing: '搜索中' },
  查找: { done: '已查找', doing: '查找中' },
  网页获取: { done: '已获取', doing: '获取中' },
};

export function applyActionTense(
  actionText: string,
  status: MessageToolCall['status'] | undefined
): string {
  const forms = VERB_TENSE[actionText];
  if (forms) {
    if (status === 'success') return forms.done;
    if (status === 'running') return forms.doing;
    return actionText;
  }
  if (status === 'success')
    return t('tool.tense.done', '已{action}', { action: actionText });
  if (status === 'running')
    return t('tool.tense.doing', '正在{action}', { action: actionText });
  return actionText;
}

/** 任务类入参结构化解析（禁止 raw JSON 泄露） */
function summarizeTaskArgs(args: string): string {
  const trimmed = (args || '').trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object') {
      const list = Array.isArray(parsed.tasks)
        ? parsed.tasks
        : Array.isArray(parsed.todos)
          ? parsed.todos
          : Array.isArray(parsed.items)
            ? parsed.items
            : null;
      if (list) {
        const first = list[0] as Record<string, unknown> | string | undefined;
        const firstTitle =
          typeof first === 'string'
            ? first.trim()
            : first && typeof first === 'object'
              ? String(first.title ?? first.name ?? first.content ?? '').trim()
              : '';
        const head = `${list.length} 个任务`;
        return firstTitle ? `${head} · ${firstTitle}` : head;
      }
      const single = String(
        parsed.title ?? parsed.name ?? parsed.task ?? ''
      ).trim();
      if (single) return single;
      return '';
    }
  } catch {
    // 非 JSON 参数
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return '';
  return trimmed.length > 50 ? trimmed.slice(0, 50) + '…' : trimmed;
}

/** 任务管理、定时调度、插件市场等专用领域意图解析（彻底杜绝 raw JSON 裸奔） */
function resolveDomainToolAction(
  name: string,
  args: string
): ResolvedToolAction | null {
  if (!args) return null;
  let parsed: Record<string, unknown> | null = null;
  try {
    const o = JSON.parse(args.trim());
    if (o && typeof o === 'object') parsed = o as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!parsed) return null;

  // 1. 任务管理 (manage_task / task_manager)
  if (
    name === 'manage_task' ||
    name === 'manage_tasks' ||
    (parsed.action && parsed.taskId)
  ) {
    const act = String(parsed.action ?? parsed.Action ?? '')
      .toLowerCase()
      .trim();
    const taskId = String(
      parsed.taskId ?? parsed.TaskId ?? parsed.id ?? ''
    ).trim();
    const map: Record<string, string> = {
      status: t('tool.action.taskStatus', '查看任务状态'),
      read_log: t('tool.action.taskLog', '读取任务日志'),
      log: t('tool.action.taskLog', '读取任务日志'),
      logs: t('tool.action.taskLog', '读取任务日志'),
      kill: t('tool.action.taskKill', '终止任务'),
      stop: t('tool.action.taskKill', '终止任务'),
      cancel: t('tool.action.taskKill', '终止任务'),
      send_input: t('tool.action.taskInput', '发送任务输入'),
      input: t('tool.action.taskInput', '发送任务输入'),
      list: t('tool.action.taskList', '查看任务列表'),
    };
    const actionText = map[act] || t('tool.action.taskManage', '管理任务');
    return {
      actionText,
      paramText: act === 'list' ? '' : taskId,
      isPath: false,
    };
  }

  // 2. 定时调度 (schedule / set_timer / cancel_timer)
  if (name === 'schedule' || name === 'set_timer' || name === 'cancel_timer') {
    if (name.includes('cancel')) {
      const id = String(parsed.timerId ?? parsed.id ?? '').trim();
      return {
        actionText: t('tool.action.scheduleCancel', '取消定时器'),
        paramText: sanitizeParamText(id),
        isPath: false,
      };
    }
    const sec =
      parsed.DurationSeconds ?? parsed.durationSeconds ?? parsed.duration;
    const cron = parsed.CronExpression ?? parsed.cronExpression ?? parsed.cron;
    const pText =
      sec !== undefined && sec !== null
        ? t('tool.action.scheduleSeconds', '{seconds} 秒', {
            seconds: String(sec),
          })
        : cron
          ? String(cron).trim()
          : '';
    return {
      actionText: t('tool.action.scheduleSet', '设置定时器'),
      paramText: sanitizeParamText(pText),
      isPath: false,
    };
  }

  // 3. 插件与市场
  if (name === 'search_marketplace') {
    const q = Array.isArray(parsed.queries)
      ? parsed.queries.join(', ')
      : String(parsed.query || parsed.q || '');
    return {
      actionText: t('tool.action.marketplaceSearch', '搜索插件市场'),
      paramText: q ? (q.startsWith('"') ? q : `"${q}"`) : '',
      isPath: false,
    };
  }
  if (name === 'list_plugin_accounts') {
    return {
      actionText: t('tool.action.pluginAccounts', '查看插件账号'),
      paramText: '',
      isPath: false,
    };
  }

  // 4. 子代理派发 (invoke_subagent / run_subagent)
  if (name === 'invoke_subagent' || name === 'run_subagent') {
    const label = String(
      parsed.Role ?? parsed.role ?? parsed.TypeName ?? parsed.typeName ?? ''
    ).trim();
    if (label)
      return {
        actionText: t('tool.action.subagentSpawn', '派发子任务'),
        paramText: sanitizeParamText(label),
        isPath: false,
      };
  }

  return null;
}

/** 从读取文件参数中解析行号区间 */
export function resolveReadFileLineRange(
  tc: MessageToolCall
): { rangeStr: string; startLine?: number; endLine?: number } | null {
  if (tc.output) {
    const parsed = parseReadFileOutput(
      tc.output,
      (tc.name || '').toLowerCase().replace(/[\s-]+/g, '_')
    );
    if (
      parsed &&
      parsed.startLine !== undefined &&
      parsed.endLine !== undefined
    ) {
      return {
        rangeStr: `${parsed.startLine}-${parsed.endLine}`,
        startLine: parsed.startLine,
        endLine: parsed.endLine,
      };
    }
  }
  if (tc.arguments) {
    try {
      const p = JSON.parse(tc.arguments.trim());
      const start = p.StartLine ?? p.startLine ?? p.start_line ?? p.start;
      const end = p.EndLine ?? p.endLine ?? p.end_line ?? p.end;
      if (start !== undefined && end !== undefined) {
        return {
          rangeStr: `${start}-${end}`,
          startLine: Number(start),
          endLine: Number(end),
        };
      }
      if (start !== undefined) {
        return {
          rangeStr: `${start}`,
          startLine: Number(start),
          endLine: Number(start),
        };
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

export function formatReadFileParam(
  baseName: string,
  lineRange: { rangeStr: string } | null
): string {
  return baseName && lineRange?.rangeStr
    ? `${baseName}:${lineRange.rangeStr}`
    : baseName;
}

/** read_file 目标提取器（用于 ToolPresentation 领域注册模型） */
export function extractReadFileTarget(
  args: Record<string, unknown>,
  tc?: MessageToolCall
): ToolTarget | undefined {
  const p = String(
    args.path ?? args.Path ?? args.filePath ?? args.filepath ?? ''
  ).trim();
  if (!p) return undefined;
  const base = basename(p) || p;
  const m = tc?.output?.match(/^startLine:\s*(\d+),\s*endLine:\s*(\d+)$/im);
  const rangeStr = m ? `:${m[1]}-${m[2]}` : '';
  return {
    text: `${base}${rangeStr}`,
    kind: 'path',
    clickable: true,
    tooltip: rangeStr ? `${p}:${rangeStr.slice(1)}` : p,
  };
}

/** 按照 DIM-04 规范将工具调用解析为人类友好动作与核心参数 */
export function resolveToolActionAndParam(
  tc: MessageToolCall,
  human: string,
  filePath?: string,
  pathLabel?: string
): ResolvedToolAction {
  const resolved = resolveToolActionAndParamRaw(tc, human, filePath, pathLabel);
  return {
    ...resolved,
    actionText: applyActionTense(resolved.actionText, tc.status),
    paramText: sanitizeParamText(resolved.paramText),
  };
}

function resolveToolActionAndParamRaw(
  tc: MessageToolCall,
  human: string,
  filePath?: string,
  pathLabel?: string
): ResolvedToolAction {
  const name = (tc.name || '').toLowerCase().replace(/[\s-]+/g, '_');
  const args = tc.arguments || '';
  const isError = tc.status === 'error';

  // 0. 失败终态时提炼错误概要
  if (isError && tc.output) {
    const lines = tc.output
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const firstLine = lines[0] || '执行失败';
    const cleanErr = firstLine.replace(/^\[[^\]]+\]\s*/, '');
    let action = human || '工具';
    if (name.includes('read') || name.includes('view')) action = '读取';
    else if (name.includes('write')) action = '写入';
    else if (name.includes('edit') || name.includes('replace')) action = '编辑';
    else if (name.includes('grep')) action = '搜索';
    else if (name.includes('find') || name.includes('glob')) action = '查找';
    else if (
      name.includes('url') ||
      name.includes('fetch') ||
      name.includes('browser')
    )
      action = '网页获取';
    return {
      actionText: action,
      paramText: cleanErr.length > 70 ? cleanErr.slice(0, 70) + '…' : cleanErr,
      isPath: false,
    };
  }

  // 0.1 专用领域意图解析（消除裸奔参数与 raw JSON）
  const domainAction = resolveDomainToolAction(name, args);
  if (domainAction) return domainAction;

  // 1. Shell 执行类
  if (
    isShellToolName(name) ||
    name.includes('bash') ||
    name.includes('powershell') ||
    name.includes('pwsh') ||
    name.includes('exec') ||
    name === 'run_command' ||
    name === 'terminal' ||
    name === 'shell'
  ) {
    const cmd = extractToolCommand(args) || toolCommandPreview(tc, 80);
    const action =
      name.includes('pwsh') || name.includes('powershell')
        ? 'Pwsh'
        : name.includes('bash')
          ? 'Bash'
          : '终端';
    return {
      actionText: action,
      paramText: cmd || extractFallbackParam(name, args),
      isPath: false,
    };
  }

  // 2. 差异对比类
  if (name.includes('diff')) {
    const p =
      pathLabel ||
      (filePath ? basename(filePath) : '') ||
      extractFallbackParam(name, args);
    return {
      actionText: '差异对比',
      paramText: p,
      isPath: Boolean(filePath || p),
    };
  }

  // 3. 文件属性查看类
  if (name === 'file_stat' || name.includes('stat')) {
    let p = pathLabel || (filePath ? basename(filePath) : '');
    if (!p && args) {
      try {
        const parsed = JSON.parse(args);
        const pathVal =
          parsed.path ||
          parsed.Path ||
          parsed.filepath ||
          parsed.filePath ||
          '';
        if (pathVal) p = basename(pathVal);
      } catch {
        /* ignore */
      }
    }
    return { actionText: '属性', paramText: p, isPath: Boolean(filePath || p) };
  }

  // 4. 文件读取类
  if (
    name === 'read_file' ||
    name === 'view_file' ||
    name === 'read_text_file' ||
    name === 'open_file' ||
    name === 'cat' ||
    (name.includes('read') &&
      !name.includes('url') &&
      !name.includes('resource')) ||
    (name.includes('view') && !name.includes('preview'))
  ) {
    const p = pathLabel || (filePath ? basename(filePath) : '');
    const lineRange = resolveReadFileLineRange(tc);
    const formattedParam = formatReadFileParam(p, lineRange);
    return {
      actionText: '读取',
      paramText: formattedParam,
      isPath: Boolean(filePath || p),
    };
  }

  // 5. 文件修改 / 代码替换类
  if (
    isEditToolName(name) ||
    name.includes('replace') ||
    name.includes('patch') ||
    name.includes('edit')
  ) {
    const p = pathLabel || (filePath ? basename(filePath) : '');
    return { actionText: '修改', paramText: p, isPath: Boolean(filePath || p) };
  }

  // 6. 文件写入 / 创建类
  if (
    name === 'write_file' ||
    name === 'write_to_file' ||
    name === 'create_file' ||
    (name.includes('write') && !name.includes('edit'))
  ) {
    const p = pathLabel || (filePath ? basename(filePath) : '');
    return { actionText: '写入', paramText: p, isPath: Boolean(filePath || p) };
  }

  // 7. 搜索与查询类
  if (name === 'web_search' || name === 'search_web') {
    let q = '';
    try {
      const p = JSON.parse(args);
      q = p.query || p.q || '';
    } catch {
      q = args;
    }
    return {
      actionText: '搜索网络',
      paramText: q ? `"${q}"` : '',
      isPath: false,
    };
  }

  if (name === 'grep_search' || name.includes('grep')) {
    let q = '';
    try {
      const p = JSON.parse(args);
      q = p.query || p.pattern || p.Query || '';
    } catch {
      q = args;
    }
    return {
      actionText: '搜索',
      paramText: q
        ? q.startsWith('"')
          ? q
          : `"${q}"`
        : extractFallbackParam(name, args),
      isPath: false,
    };
  }

  if (
    name === 'find_by_name' ||
    name.includes('glob') ||
    name.includes('find')
  ) {
    let ptn = '';
    try {
      const p = JSON.parse(args);
      ptn = p.pattern || p.Pattern || '';
    } catch {
      ptn = args;
    }
    return {
      actionText: '查找',
      paramText: ptn || extractFallbackParam(name, args),
      isPath: false,
    };
  }

  if (name === 'list_dir' || name.includes('listdir')) {
    let dir = '';
    try {
      const p = JSON.parse(args);
      dir = p.directorypath || p.DirectoryPath || p.path || p.dir || '';
    } catch {
      dir = args;
    }
    const pText = dir
      ? basename(dir) || dir
      : extractFallbackParam(name, args) || '.';
    return { actionText: '列出目录', paramText: pText, isPath: Boolean(dir) };
  }

  if (name.includes('tree') || name === 'project_tree') {
    return {
      actionText: '结构树',
      paramText: extractFallbackParam(name, args) || '.',
      isPath: false,
    };
  }

  // 8. 网络访问类
  if (
    name === 'read_url_content' ||
    name.startsWith('read_url') ||
    name.includes('fetch') ||
    name.includes('browser') ||
    name === 'read_browser_page'
  ) {
    let u = '';
    try {
      const p = JSON.parse(args);
      u = p.url || p.uri || p.Url || '';
    } catch {
      u = args;
    }
    return {
      actionText: '网页获取',
      paramText: u || extractFallbackParam(name, args),
      isPath: false,
    };
  }

  if (name.includes('subagent') || name.includes('agent')) {
    let desc = '';
    try {
      const p = JSON.parse(args);
      desc = p.task || p.prompt || p.role || '';
    } catch {
      desc = args;
    }
    return {
      actionText: '子任务',
      paramText: desc
        ? desc.length > 50
          ? desc.slice(0, 50) + '…'
          : desc
        : extractFallbackParam(name, args),
      isPath: false,
    };
  }

  if (name.includes('task') || name.includes('todo')) {
    return {
      actionText: '任务',
      paramText: summarizeTaskArgs(args) || extractFallbackParam(name, args),
      isPath: false,
    };
  }

  let act = human || '工具';
  let param = pathLabel || (filePath ? basename(filePath) : '');
  if (!param && args) {
    param = extractFallbackParam(name, args);
  }
  if (param && act.endsWith(param)) {
    act = act.slice(0, -param.length).trim();
    if (act.endsWith('·') || act.endsWith(':') || act.endsWith('-')) {
      act = act.slice(0, -1).trim();
    }
  }

  return {
    actionText: act || '工具',
    paramText: param,
    isPath: Boolean(filePath || param),
  };
}

/** 行头单权威文本源判定（HC1 · D-1） */
export function shouldShowHumanLabel(args: {
  human: string;
  humanSource: ToolHumanLabelSource;
  actionText: string;
  paramText: string;
}): boolean {
  const { human, humanSource, actionText, paramText } = args;
  if (!human || humanSource === 'args') return false;
  const norm = (s: string) => s.replace(/\s+/g, '');
  const humanNorm = norm(human);
  const combinedNorm = norm(
    paramText ? `${actionText} ${paramText}` : actionText
  );
  return !(
    humanNorm &&
    combinedNorm &&
    (combinedNorm.includes(humanNorm) || humanNorm.includes(combinedNorm))
  );
}

/** 解析工具调用的次要关键量度（直观易读中文，消除混乱符号） */
export function resolveToolSecondaryMeta(tc: MessageToolCall): string | null {
  const name = (tc.name || '').toLowerCase().replace(/[\s-]+/g, '_');
  const output = tc.output || '';

  // 1. 读取文件类
  if (
    name === 'read_file' ||
    name === 'view_file' ||
    name === 'read_text_file' ||
    name === 'open_file' ||
    name === 'cat' ||
    (name.includes('read') &&
      !name.includes('url') &&
      !name.includes('resource')) ||
    (name.includes('view') && !name.includes('preview'))
  ) {
    if (output) {
      const parsed = parseReadFileOutput(output, name);
      if (parsed) {
        if (
          parsed.startLine !== undefined &&
          parsed.endLine !== undefined &&
          parsed.totalLines
        ) {
          return t('tool.action.linesTotalCombined', '共 {total} 行', {
            total: parsed.totalLines,
          });
        }
        if (parsed.totalLines)
          return t('tool.action.linesTotal', '{total} 行', {
            total: parsed.totalLines,
          });
        if (parsed.code)
          return t('tool.action.linesCount', '{count} 行', {
            count: parsed.code.split('\n').length,
          });
      }
    }
    return null;
  }

  // 2. Grep 检索类
  if (name === 'grep_search' || name.includes('grep')) {
    if (output) {
      const parsed = parseGrepSearchOutput(output, name);
      if (parsed) {
        if (parsed.isEmpty) return '无匹配';
        return `${parsed.matchCount ?? parsed.matches.length} 处匹配`;
      }
    }
    return null;
  }

  if (
    name === 'file_stat' ||
    name.includes('stat') ||
    name === 'list_dir' ||
    name.includes('listdir')
  ) {
    return null;
  }

  return deriveFlatScalarSummary(tc);
}

/** 次级元数据的完整版（Tooltip / aria 用） */
export function resolveToolSecondaryMetaTitle(
  tc: MessageToolCall
): string | null {
  const name = (tc.name || '').toLowerCase().replace(/[\s-]+/g, '_');
  if (name === 'file_stat' || name.includes('stat')) {
    const output = tc.output || '';
    if (output) {
      const parsed = parseFileStatOutput(output);
      if (parsed) {
        return `${parsed.path} · ${parsed.kindZh} · ${parsed.sizeStr} · ${parsed.readonly ? '只读' : '可读写'} · 修改于 ${parsed.mtimeStr}`;
      }
    }
  }
  return null;
}
