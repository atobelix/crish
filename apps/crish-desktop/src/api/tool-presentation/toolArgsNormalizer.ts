/**
 * 工具入参深度解包与标准化处理器（支持 PascalCase、snake_case、嵌套及双重 JSON）。
 */

export interface ExtractedToolArgs {
  /** 规范化后的键值映射表（统一转为小写键索引，原键值亦保留） */
  props: Record<string, unknown>;
  /** 提取出的核心命令/路径/动作字符串 */
  primaryTarget?: string;
  /** 原始解包后的入参对象 */
  rawObject?: Record<string, unknown>;
  /** 是否解析出有效的键值对象 */
  isObject: boolean;
}

/** 路径提取工具：提取文件名或相对基准 */
export function basename(pathStr: string): string {
  if (!pathStr) return '';
  const normalized = pathStr.replace(/\\/g, '/').replace(/\/+$/, '');
  const segments = normalized.split('/');
  return segments[segments.length - 1] || normalized;
}

/** 从工具参数取可点路径展示名（basename） */
export function toolPathDisplayName(filePath: string): string {
  return basename(filePath);
}

/**
 * 深度解析工具参数，具备多层解包、双重 JSON 容错与全生态命名映射能力
 */
export function parseToolArgsSafe(argsStr?: string | null): ExtractedToolArgs {
  if (!argsStr || !argsStr.trim()) {
    return { props: {}, isObject: false };
  }
  const raw = argsStr.trim();
  let parsed: unknown = null;

  try {
    parsed = JSON.parse(raw);
    // 容错：如果解析出的结果仍是 JSON 字符串，二次解析
    if (
      typeof parsed === 'string' &&
      (parsed.trim().startsWith('{') || parsed.trim().startsWith('['))
    ) {
      try {
        parsed = JSON.parse(parsed.trim());
      } catch {
        /* keep original parsed */
      }
    }
  } catch {
    // 容错：尝试解开双重转义的 JSON 字符串
    try {
      const unescaped = JSON.parse(`"${raw}"`);
      if (
        typeof unescaped === 'string' &&
        (unescaped.trim().startsWith('{') || unescaped.trim().startsWith('['))
      ) {
        parsed = JSON.parse(unescaped.trim());
      }
    } catch {
      /* plain text string */
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { props: { _raw: raw }, primaryTarget: raw, isObject: false };
  }

  const obj = parsed as Record<string, unknown>;
  // 多层解包：解开 parameters / input / Arguments / tool_args 容器
  const inner =
    (obj.parameters &&
    typeof obj.parameters === 'object' &&
    !Array.isArray(obj.parameters)
      ? (obj.parameters as Record<string, unknown>)
      : null) ||
    (obj.input && typeof obj.input === 'object' && !Array.isArray(obj.input)
      ? (obj.input as Record<string, unknown>)
      : null) ||
    (obj.Arguments &&
    typeof obj.Arguments === 'object' &&
    !Array.isArray(obj.Arguments)
      ? (obj.Arguments as Record<string, unknown>)
      : null) ||
    (obj.arguments &&
    typeof obj.arguments === 'object' &&
    !Array.isArray(obj.arguments)
      ? (obj.arguments as Record<string, unknown>)
      : null) ||
    (obj.tool_args &&
    typeof obj.tool_args === 'object' &&
    !Array.isArray(obj.tool_args)
      ? (obj.tool_args as Record<string, unknown>)
      : null) ||
    obj;

  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(inner)) {
    props[k.toLowerCase()] = v; // 小写键归一化
    props[k] = v; // 保留原始键名
  }

  // 优先级检索核心目标（路径 / 命令 / 查询词 / 任务ID / 动作 / 目标文件）
  let target: string | undefined;
  const targetKeys = [
    'commandline',
    'command_line',
    'command',
    'cmd',
    'script',
    'absolutepath',
    'absolute_path',
    'directorypath',
    'directory_path',
    'targetfile',
    'target_file',
    'filepath',
    'file_path',
    'path',
    'filename',
    'file',
    'query',
    'pattern',
    'searchpath',
    'search_path',
    'taskid',
    'task_id',
    'action',
    'url',
    'uri',
    'role',
    'typename',
    'prompt',
  ];

  for (const k of targetKeys) {
    const v = props[k];
    if (typeof v === 'string' && v.trim()) {
      target = v.trim();
      break;
    }
  }

  if (!target && typeof props.content === 'string') {
    const c = props.content.trim();
    target = c.slice(0, 80) + (c.length > 80 ? '…' : '');
  }

  return {
    props,
    primaryTarget: target,
    rawObject: inner,
    isObject: true,
  };
}

/**
 * 从 arguments 抽出命令/路径（绝对不返回未脱敏的 raw JSON）
 */
export function extractToolCommand(args: string): string {
  const extracted = parseToolArgsSafe(args);
  if (extracted.primaryTarget) {
    return extracted.primaryTarget;
  }
  // 若是对象但未匹配到主键，严禁直接返回 raw JSON 字符串
  if (extracted.isObject) {
    return '';
  }
  return args ? args.trim() : '';
}

/** 提取工作目录 CWD */
export function extractToolCwd(argsStr?: string | null): string | undefined {
  const extracted = parseToolArgsSafe(argsStr);
  const cwd =
    extracted.props.cwd ||
    extracted.props.workingdir ||
    extracted.props.working_dir ||
    extracted.props.directory;
  return typeof cwd === 'string' && cwd.trim() ? cwd.trim() : undefined;
}
