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
} from '../../api/toolPresentation';
import { isEditToolName, isShellToolName } from '../../api/toolFeedback';
import {
  parseReadFileOutput,
  parseGrepSearchOutput,
  parseFileStatOutput,
  parseListDirOutput,
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

      // 2. 提取前两项 key: val
      const entries = Object.entries(obj).filter(
        ([_, v]) => v !== undefined && v !== null
      );
      if (entries.length > 0) {
        const parts = entries.slice(0, 2).map(([k, v]) => {
          const vStr = typeof v === 'object' ? JSON.stringify(v) : String(v);
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
 * 按照 DIM-04 规范将工具调用解析为人类友好动作与核心参数
 */
export function resolveToolActionAndParam(
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
    else if (name.includes('grep')) action = 'Grep';
    else if (name.includes('find') || name.includes('glob')) action = 'Glob';
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
      actionText: 'Grep',
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
      actionText: 'Glob',
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
      paramText: args
        ? args.length > 50
          ? args.slice(0, 50) + '…'
          : args
        : extractFallbackParam(name, args),
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

  // 3. 文件属性查看类
  if (name === 'file_stat' || name.includes('stat')) {
    if (output) {
      const parsed = parseFileStatOutput(output);
      if (parsed) {
        return (
          parsed.sizeStr.split(' ')[0] +
          ' ' +
          (parsed.sizeStr.split(' ')[1] || '')
        );
      }
    }
    return null;
  }

  // 4. 目录列表类
  if (name === 'list_dir' || name.includes('listdir')) {
    if (output) {
      const parsed = parseListDirOutput(output, name);
      if (parsed) {
        if (parsed.isEmpty) return '空目录';
        return `${parsed.items.length} 项`;
      }
    }
    return null;
  }

  return null;
}
