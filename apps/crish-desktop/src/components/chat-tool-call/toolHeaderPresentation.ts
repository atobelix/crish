/**
 * apps/crish-desktop/src/components/chat-tool-call/toolHeaderPresentation.ts
 *
 * 工具行头部展现语义解析与次要指标提炼（DIM-04 专项）
 * 纯业务逻辑模块，从 ToolCallHeader.tsx 解耦抽离以满足行数门禁 (≤ 400 行)
 */

import type { MessageToolCall } from '../../store/types';
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

      // 2. 提取前两项 key: 值——对象/数组只给「键名 + 类型占位」
      // （HC1 · D-4：禁止原始 JSON 进标签，如 tasks: [{...] 的线协议倾倒；
      //   R8 合并时以 HC1 版为准恢复，勿回退为 JSON.stringify 倾倒）
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

/**
 * 【R8/B2 动词时态表】行内行头的动词词干按工具状态变时态：
 * 成功 → 完成式（已读取），运行中 → 进行式（读取中）；
 * 失败 / 待确认保持词干（状态由行尾状态词承担，见 STATUS_WORD）。
 * 词干清单以 HC1 口径为准（2026-11-02 整波收口合并裁定）：grep 词干
 * 「搜索」、glob 词干「查找」；成功时态形以 R8 为准（已搜索 / 已查找）。
 * 名词行头（终端 / Bash / Pwsh / 属性 / 结构树 /
 * 子任务 / 任务 / 工具名）不分时态、任何状态下不变——分工：
 * 时态管动词行头，名词行头由行尾状态词承担。
 */
const VERB_TENSE: Record<string, { done: string; doing: string }> = {
  读取: { done: '已读取', doing: '读取中' },
  写入: { done: '已写入', doing: '写入中' },
  编辑: { done: '已编辑', doing: '编辑中' },
  修改: { done: '已修改', doing: '修改中' },
  列出目录: { done: '已列出目录', doing: '列出中' },
  搜索网络: { done: '已搜索', doing: '搜索中' },
  搜索: { done: '已搜索', doing: '搜索中' },
  查找: { done: '已查找', doing: '查找中' },
  网页获取: { done: '已获取', doing: '获取中' },
  差异对比: { done: '已对比', doing: '对比中' },
};

function applyActionTense(
  actionText: string,
  status: MessageToolCall['status'] | undefined
): string {
  const forms = VERB_TENSE[actionText];
  if (!forms) return actionText;
  if (status === 'success') return forms.done;
  if (status === 'running') return forms.doing;
  return actionText;
}

/**
 * 【R8/B3】task / todo 类工具的参数摘要：解析参数 JSON——
 * 任务数组 → 「N 个任务 · 首个任务标题」；单任务 → 其标题；
 * 解析不出结构时退回原文截断（与历史口径一致）。
 * 禁止把裸 JSON 直接贴进行头。
 */
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
    }
  } catch {
    // 非 JSON 参数：走下方原文截断
  }
  return trimmed.length > 50 ? trimmed.slice(0, 50) + '…' : trimmed;
}

/**
 * 按照 DIM-04 规范将工具调用解析为人类友好动作与核心参数。
 * 出口统一过 applyActionTense（B2 时态层）——分支内只产词干。
 */
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

  // 0. 失败终态时，若包含错误输出直接提炼错误概要展示于摘要行
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
        // ignore
      }
    }
    return {
      actionText: '属性',
      paramText: p,
      isPath: Boolean(filePath || p),
    };
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
    return {
      actionText: '读取',
      paramText: p,
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
    return {
      actionText: '修改',
      paramText: p,
      isPath: Boolean(filePath || p),
    };
  }

  // 6. 文件写入 / 创建类
  if (
    name === 'write_file' ||
    name === 'write_to_file' ||
    name === 'create_file' ||
    (name.includes('write') && !name.includes('edit'))
  ) {
    const p = pathLabel || (filePath ? basename(filePath) : '');
    return {
      actionText: '写入',
      paramText: p,
      isPath: Boolean(filePath || p),
    };
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
    return {
      actionText: '列出目录',
      paramText: pText,
      isPath: Boolean(dir),
    };
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

/**
 * 行头单权威文本源判定（HC1 · D-1）：human 是否在行内与 action+param 并列渲染。
 *
 * - human 为入参派生标签（source='args'）：与 action+param 同源同文，并列必然
 *   重复——恒不渲染（文本退守行级 aria-label 与 Tooltip）；
 * - human 为 explanation：仅在与 `action + param` 拼接不构成包含关系时并列；
 *   包含判断在去空白归一后双向进行（治旧「整段全等」弱去重漏检拼接相等），
 *   类型分支与通用分支共用本收口，不再各写一份。
 * （R8 合并时以 HC1 版为准恢复：ToolCallHeader.tsx 现行 import 依赖本导出。）
 */
export function shouldShowHumanLabel(args: {
  human: string;
  humanSource: ToolHumanLabelSource;
  actionText: string;
  paramText: string;
}): boolean {
  const { human, humanSource, actionText, paramText } = args;
  if (!human) return false;
  if (humanSource === 'args') return false;
  const norm = (s: string) => s.replace(/\s+/g, '');
  const humanNorm = norm(human);
  const combinedNorm = norm(
    paramText ? `${actionText} ${paramText}` : actionText
  );
  if (
    humanNorm &&
    combinedNorm &&
    (combinedNorm.includes(humanNorm) || humanNorm.includes(combinedNorm))
  ) {
    return false;
  }
  return true;
}

/**
 * 解析工具调用的次要关键量度（用于在摘要行中紧凑呈现：行数、匹配数、文件大小等）
 */
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
          parsed.totalLines &&
          parsed.endLine - parsed.startLine + 1 < parsed.totalLines
        ) {
          return `L${parsed.startLine}–${parsed.endLine} / ${parsed.totalLines} 行`;
        }
        if (parsed.totalLines) {
          return `${parsed.totalLines} 行`;
        }
        if (parsed.code) {
          const lines = parsed.code.split('\n').length;
          return `${lines} 行`;
        }
      }
    }
    // 如果 output 为空但入参指定了行范围
    if (tc.arguments) {
      try {
        const p = JSON.parse(tc.arguments);
        if (p.StartLine && p.EndLine) {
          return `L${p.StartLine}–${p.EndLine}`;
        }
      } catch {
        // ignore
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

  // 3. 文件属性查看类（用户裁决 · 2026-11-02：行头不展示冗余属性字符串，"没有必要显示"）
  if (name === 'file_stat' || name.includes('stat')) {
    return null;
  }

  // 4. 目录列表类（用户裁决 · 2026-11-02：行头不显示项数，"这个可以不用显示"）
  if (name === 'list_dir' || name.includes('listdir')) {
    return null;
  }

  // 5. 通用扁平标量（E1 决策序 9 的行内摘要来源，与政策函数共用
  //    同一派生 deriveFlatScalarSummary：这类行取消展开后，输出的
  //    完整紧凑形在此可见，不丢信息）
  return deriveFlatScalarSummary(tc);
}

/**
 * 次级元数据的完整版（Tooltip / aria 用）：stat 行给全字段 + 完整
 * 时间戳（E1 §6.2）；其余行返回 null——行内文本本身即完整信息。
 */
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
