/**
 * 流式细碎 tool_calls 分片聚合器
 * 针对 SSE 流中可能极度细碎的 delta.tool_calls（如单字符 arguments 累加、分片到达的 id 与 name），按 index 进行稳定聚合。
 * 纯状态类 / 纯函数组，零外部 IO 依赖，支持 JSON 截断容错修复。
 * 对齐方案文档：docs/mobile-web-search-and-sandbox/04-分维-移动端本地Agent循环与通用端侧工具体系方案.md §2
 */

export interface AccumulatedToolCall {
  index: number;
  id: string;
  name: string;
  argumentsString: string;
  /** 兼容别名（对齐 §2.3.3） */
  arguments?: string;
  parsedArguments?: Record<string, any>;
  /** 兼容别名（对齐 §2.3.3） */
  parsedArgs?: Record<string, any>;
  isValidJson: boolean;
}

export interface ToolCallChunkItem {
  index?: number | string;
  id?: string;
  name?: string;
  argumentsDelta?: string;
  argumentsString?: string;
  arguments?: string | Record<string, unknown>;
  function?: {
    id?: string;
    name?: string;
    arguments?: string | Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * 针对流式分片中的 id 或 name 进行增量拼接或去重更新
 * 支持以下模式：
 * 1. 分片片段到达（例如 id: "call_" 随后 "abc" -> "call_abc"）
 * 2. 累积分片到达（例如 id: "call_" 随后 "call_abc" -> "call_abc"）
 * 3. 冗余全量到达（例如 id: "call_abc" 随后 "call_abc" -> "call_abc"）
 */
export function appendOrUpdateStreamString(
  existing: string,
  incoming: string | undefined | null
): string {
  if (!incoming) return existing;
  if (!existing) return incoming;
  if (existing === incoming) return existing;
  if (incoming.startsWith(existing)) return incoming;
  if (existing.startsWith(incoming) && incoming.length > 1) return existing;
  return existing + incoming;
}

/**
 * 截断或不完整 JSON 容错修复算法
 * 针对大模型在流式生成过程中被提前截断（例如 max_tokens 耗尽、网络中断、提前结束等）输出的不完整 JSON，
 * 尝试通过符号栈与语法自愈将其补全为可解析的有效 JSON 字符串。
 */
export function repairTruncatedJson(raw: string): string {
  let s = raw.trim();
  if (!s) return '{}';

  // 1. 剥离 Markdown 代码块（如 ```json ... ```）
  if (s.startsWith('```')) {
    s = s
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
  }

  // 2. 如果不以 { 或 [ 开头，但包含冒号（形如 "query": "xxx"），尝试补齐外层大括号
  if (!s.startsWith('{') && !s.startsWith('[')) {
    if (s.includes(':')) {
      s = '{' + s;
    }
  }

  // 3. 遍历符号栈：追踪字符串与开闭括号
  let inString = false;
  let isEscaped = false;
  const stack: ('{' | '[')[] = [];

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (ch === '\\') {
        isEscaped = true;
      } else if (ch === '"') {
        inString = false;
      }
    } else {
      if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        stack.push('{');
      } else if (ch === '[') {
        stack.push('[');
      } else if (ch === '}') {
        if (stack.length > 0 && stack[stack.length - 1] === '{') {
          stack.pop();
        }
      } else if (ch === ']') {
        if (stack.length > 0 && stack[stack.length - 1] === '[') {
          stack.pop();
        }
      }
    }
  }

  // 4. 字符串截断自愈：若在引号内部截断，补齐闭合引号
  if (inString) {
    if (isEscaped) {
      // 截断在转义斜杠处，去掉悬挂反斜杠
      s = s.slice(0, -1);
    }
    s += '"';
    inString = false;
  }

  // 5. 符号外部未完成语法自愈
  s = s.trimEnd();

  // 若以冒号结尾（如 {"key": ），补齐 null
  if (s.endsWith(':')) {
    s += 'null';
  }

  // 若以逗号结尾（如 {"a": 1, 或 [1, 2, ），去掉末尾逗号
  s = s.replace(/,\s*$/, '');

  // 布尔值与 null 未完成字符自愈（如 : tr -> : true）
  s = s
    .replace(/:\s*tr(?:u(?:e)?)?$/i, ': true')
    .replace(/:\s*fa(?:l(?:s(?:e)?)?)?$/i, ': false')
    .replace(/:\s*nu(?:l(?:l)?)?$/i, ': null');

  // 未完成的浮点数（如 : 123. ）
  s = s.replace(/:\s*(\d+)\.\s*$/, ': $1');

  // 6. 逆序补齐所有未闭合的括号与大括号
  let closing = '';
  for (let i = stack.length - 1; i >= 0; i--) {
    closing += stack[i] === '{' ? '}' : ']';
  }

  const candidate = s + closing;
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    // 7. 特殊自愈：如果末尾悬挂未配对的属性名（如 {"query": "test", "extra"）
    if (
      s.endsWith('"') &&
      stack.length > 0 &&
      stack[stack.length - 1] === '{'
    ) {
      const candidateWithColon = s + ': null' + closing;
      try {
        JSON.parse(candidateWithColon);
        return candidateWithColon;
      } catch {
        const candidateWithoutKey = s.replace(/,?\s*"[^"]*"$/, '') + closing;
        try {
          JSON.parse(candidateWithoutKey);
          return candidateWithoutKey;
        } catch {
          // 保持原 candidate
        }
      }
    }
  }

  return candidate;
}

/**
 * 尝试解析工具调用参数字符串，支持空字符串和截断容错
 */
export function parseToolArguments(argsString: string): {
  isValidJson: boolean;
  parsedArguments?: Record<string, any>;
} {
  const trimmed = argsString.trim();
  if (trimmed === '') {
    return {
      isValidJson: true,
      parsedArguments: {},
    };
  }

  // 1. 尝试直接标准解析
  try {
    const direct = JSON.parse(trimmed);
    if (
      direct !== null &&
      typeof direct === 'object' &&
      !Array.isArray(direct)
    ) {
      return {
        isValidJson: true,
        parsedArguments: direct as Record<string, any>,
      };
    }
    if (Array.isArray(direct)) {
      return {
        isValidJson: true,
        parsedArguments: { items: direct },
      };
    }
    return {
      isValidJson: true,
      parsedArguments: { value: direct },
    };
  } catch {
    // 进入容错修复流程
  }

  // 2. 尝试自动修复截断 JSON
  try {
    const repaired = repairTruncatedJson(trimmed);
    const parsed = JSON.parse(repaired);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
    ) {
      return {
        isValidJson: true,
        parsedArguments: parsed as Record<string, any>,
      };
    }
    if (Array.isArray(parsed)) {
      return {
        isValidJson: true,
        parsedArguments: { items: parsed },
      };
    }
    return {
      isValidJson: true,
      parsedArguments: { value: parsed },
    };
  } catch {
    // 3. 彻底无法解析
    return {
      isValidJson: false,
      parsedArguments: undefined,
    };
  }
}

/**
 * 内部单个工具调用的流式累加状态
 */
interface InternalAccumulatorEntry {
  id: string;
  name: string;
  argumentsString: string;
}

/**
 * 流式细碎 tool_calls 分片聚合器
 */
export class StreamingToolCallAccumulator {
  private map = new Map<number, InternalAccumulatorEntry>();

  /**
   * 摄入流式 chunk 中的 tool_calls 数组
   * @param chunkToolCalls SSE chunk choice.delta.tool_calls 分片列表
   */
  feedChunk(chunkToolCalls: any[]): void {
    if (!chunkToolCalls) return;

    const items = Array.isArray(chunkToolCalls)
      ? chunkToolCalls
      : [chunkToolCalls];
    if (items.length === 0) return;

    for (let i = 0; i < items.length; i++) {
      const raw = items[i];
      if (!raw || typeof raw !== 'object') continue;

      const index =
        typeof raw.index === 'number'
          ? raw.index
          : typeof raw.index === 'string' && !isNaN(Number(raw.index))
            ? Number(raw.index)
            : i;

      const existing: InternalAccumulatorEntry = this.map.get(index) ?? {
        id: '',
        name: '',
        argumentsString: '',
      };

      // 提取 id（支持顶级 id 或 function.id）
      const rawId =
        typeof raw.id === 'string'
          ? raw.id
          : typeof raw.function?.id === 'string'
            ? raw.function.id
            : undefined;
      if (rawId) {
        existing.id = appendOrUpdateStreamString(existing.id, rawId);
      }

      // 提取 name（支持 function.name 或顶级 name）
      const rawName =
        typeof raw.function?.name === 'string'
          ? raw.function.name
          : typeof raw.name === 'string'
            ? raw.name
            : undefined;
      if (rawName) {
        existing.name = appendOrUpdateStreamString(existing.name, rawName);
      }

      // 提取 arguments 增量（支持 function.arguments、argumentsDelta、argumentsString 或 arguments）
      const rawArgs =
        raw.function?.arguments ??
        raw.argumentsDelta ??
        raw.argumentsString ??
        raw.arguments;

      if (typeof rawArgs === 'string') {
        existing.argumentsString += rawArgs;
      } else if (rawArgs !== null && typeof rawArgs === 'object') {
        try {
          existing.argumentsString = JSON.stringify(rawArgs);
        } catch {
          // 忽略序列化失败
        }
      }

      this.map.set(index, existing);
    }
  }

  /**
   * 摄入单个 chunk 的 deltas（对齐方案 §2.3.3 pushDeltas）
   */
  pushDeltas(deltas: readonly any[]): void {
    this.feedChunk(deltas as any[]);
  }

  /**
   * 是否已累积到工具调用
   */
  hasCalls(): boolean {
    return this.map.size > 0;
  }

  /**
   * 是否已累积到工具调用（对齐方案 §2.3.3 hasToolCalls）
   */
  hasToolCalls(): boolean {
    return this.map.size > 0;
  }

  /**
   * 获取当前累积的工具调用数量
   */
  size(): number {
    return this.map.size;
  }

  /**
   * 获取流结束或 finish_reason === 'tool_calls' 时的完整聚合调用列表
   * 自动按 index 升序排列、补齐缺失的 id、尝试解析并容错修复 arguments JSON
   */
  getCompletedCalls(): AccumulatedToolCall[] {
    const list: AccumulatedToolCall[] = [];
    const sortedIndices = Array.from(this.map.keys()).sort((a, b) => a - b);

    for (const index of sortedIndices) {
      const entry = this.map.get(index)!;

      // 若模型未返回 id，自动补齐稳定唯一 id
      if (!entry.id || entry.id.trim() === '') {
        entry.id = `call_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 7)}`;
      }

      const { isValidJson, parsedArguments } = parseToolArguments(
        entry.argumentsString
      );

      list.push({
        index,
        id: entry.id,
        name: entry.name,
        argumentsString: entry.argumentsString,
        arguments: entry.argumentsString,
        parsedArguments,
        parsedArgs: parsedArguments,
        isValidJson,
      });
    }

    return list;
  }

  /**
   * 获取最终整理校验后的工具调用列表（对齐方案 §2.3.3 finalize）
   */
  finalize(): AccumulatedToolCall[] {
    return this.getCompletedCalls();
  }

  /**
   * 重置清空聚合器状态
   */
  reset(): void {
    this.map.clear();
  }
}
