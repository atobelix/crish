/**
 * 工具行展开政策（E1 · 展开必要性与侧栏承载审计定案）。
 *
 * 全仓唯一的展开决策点：任何工具行「可否内联展开 / 取消展开 /
 * 改道侧栏」只许经 resolveToolExpansionPolicy 判定，禁止第二处
 * 平行谓词。toolHasExpandableBody 仅保留其布尔投影（=== 'inline'）。
 *
 * 决策序（先命中先定，审计 §4）：
 *  1. 审批 pending_approval → 不进本政策（审批独立口径），兜底 none；
 *  2. 后台活跃（BG5 占位信封且 callId 匹配）→ none，状态条即完整呈现；
 *  3. 错误：有非平凡诊断输出 → inline（必须就地可读），否则 none；
 *  4. 可解析 diff 的成功 edit/write → side-diff（整行改道差异面板）；
 *  5. 成功 read → none（既定模型：路径点击去文件面板）；
 *  6. 可解析 file_stat 成功 → none（属性已由行头摘要承载，见 §6 前置）；
 *  7. 空结构化结果（grep 无匹配 / list_dir 空）→ none（行头有空摘要）；
 *  8. 仅入参体（终态输出空/占位/平凡）→ none（入参不是结果）；
 *  9. 扁平标量输出：能派生完整行内摘要 → none，派生不出落 10；
 * 10. 其余有内容者 → inline（shell 记录 / grep 命中 / 非空目录 /
 *     网络抓取 / 图片 / 长或嵌套 JSON / 通用日志）。
 *
 * 运行态附则：运行中的行保留实时展开（流式输出 / 完整入参可见），
 * 终态分类在完成时生效；唯读取类沿历史口径——运行中亦无展开体
 * （旧谓词中 read 检查先于 running 分支，本函数以 5' 位保持等价）。
 *
 * 注：本模块与 toolCardPresenter 互相引用（后者 re-export 本模块、
 * 本模块借用其 extractImageRefs / isReadFileToolName）——引用均为
 * 函数声明，调用发生在运行时，模块初始化期无求值依赖。
 */

import type { FileDiff, MessageToolCall } from '../../store/layoutStore';
import {
  isEditToolName,
  isShellToolName,
  resolveToolDiffs,
  sanitizeToolDisplayOutput,
} from '../toolFeedbackDiff';
import { parseToolBackgroundPlaceholder } from '../toolBackgroundApi';
import { extractImageRefs, isReadFileToolName } from './toolCardPresenter';
import {
  isPlaceholderToolOutput,
  isTrivialToolOutput,
} from './toolOutputSanitizer';

/** 展开政策三态：无展开体 / 内联展开 / 改道侧栏差异面板 */
export type ToolExpansionPolicy = 'none' | 'inline' | 'side-diff';

/** 工具名归一（与全仓口径一致：小写、空白/连字符转下划线） */
function toolNameOf(tc: MessageToolCall): string {
  return (tc.name || '').toLowerCase().replace(/[\s-]+/g, '_');
}

/**
 * 一处派生（审计 §7）：本行可改道的解析 diff 列表——结构化
 * tc.diffs 优先，否则由输出文本解析 / 入参合成（resolveToolDiffs
 * 内部口径）。政策判定、行头改道目标、diff 统计三处共用本派生，
 * 禁止平行再解析。
 */
export function resolveToolCallDiffs(tc: MessageToolCall): FileDiff[] {
  return resolveToolDiffs({
    name: tc.name || '',
    args: tc.arguments,
    output: tc.output,
    structuredDiffs: tc.diffs,
  });
}

/** BG5 后台活跃：output 为 BG2 占位信封且 callId 与本行一致 */
export function isToolBackgroundActive(tc: MessageToolCall): boolean {
  const ph = parseToolBackgroundPlaceholder(tc.output);
  return Boolean(ph && ph.callId === tc.id);
}

/** 净化后仍有实质内容（非空、非占位、非平凡终态词） */
function hasNonTrivialOutput(tc: MessageToolCall): boolean {
  const raw = tc.output || '';
  if (isPlaceholderToolOutput(raw) || isTrivialToolOutput(raw)) return false;
  return sanitizeToolDisplayOutput(raw).trim().length > 0;
}

/**
 * grep 空结果（与 components 层 parseGrepSearchOutput 的空态口径对齐：
 * 裸标记 `(no matches)`，或信封 header 声明 matches: 0 且正文为空）。
 * 本层只做线格式判定，不复制组件层的匹配解析。
 */
function isEmptyGrepResult(tc: MessageToolCall): boolean {
  if (!toolNameOf(tc).includes('grep')) return false;
  const raw = tc.output || '';
  if (!raw.trim()) return false;
  if (raw.trim() === '(no matches)') return true;
  const dividerIdx = raw.indexOf('\n---\n');
  if (dividerIdx >= 0) {
    const header = raw.slice(0, dividerIdx);
    const body = raw.slice(dividerIdx + 5).trim();
    if (/^matches:\s*0$/im.test(header) && (!body || body === '(no matches)')) {
      return true;
    }
  }
  return false;
}

/** list_dir 空目录（引擎线标记 `(empty directory)`） */
function isEmptyListDirResult(tc: MessageToolCall): boolean {
  const n = toolNameOf(tc);
  if (n !== 'list_dir' && !n.includes('listdir')) return false;
  return (tc.output || '').trim() === '(empty directory)';
}

/**
 * file_stat 线格式可解析性（与 components 层 parseFileStatOutput
 * 同一线格式正则；本层只判可解析与否，字段解析仍归组件层）。
 */
const FILE_STAT_WIRE_RE =
  /^([\s\S]+?):\s*(file|directory|other)\s*\nsize:\s*(\d+)\s*bytes\s*\nmtime:\s*(\d+)\s*ms\s*\nreadonly:\s*(true|false)/i;

function isFileStatTool(tc: MessageToolCall): boolean {
  const n = toolNameOf(tc);
  return n === 'file_stat' || n.includes('stat');
}

/** 扁平标量 JSON：标量本身，或元素/值全为标量的一层数组/对象 */
function isFlatScalarJsonValue(v: unknown): boolean {
  if (v === null) return true;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return true;
  if (Array.isArray(v)) {
    return v.every(
      (x) =>
        x === null ||
        typeof x === 'string' ||
        typeof x === 'number' ||
        typeof x === 'boolean'
    );
  }
  if (t === 'object') {
    return Object.values(v as Record<string, unknown>).every(
      (x) =>
        x === null ||
        typeof x === 'string' ||
        typeof x === 'number' ||
        typeof x === 'boolean'
    );
  }
  return false;
}

/**
 * 行内摘要长度上限：摘要必须是输出的完整紧凑形（单行全文或扁平
 * JSON 的紧凑序列化），超长即不派生——不许截断藏信息（决策序 9）。
 */
export const FLAT_SCALAR_SUMMARY_MAX_CHARS = 48;

/**
 * 决策序 9 的摘要派生（行头 resolveToolSecondaryMeta 的兜底分支与
 * 本政策共用同一实现）：终态输出为单行结果或扁平标量 JSON 且
 * 紧凑形 ≤ 上限时返回该紧凑形，否则 null。
 *
 * 体裁排除（按审计 §5 按体裁判，不按名字一刀切之外的专条优先）：
 * shell 是执行记录、edit/read/grep/stat/list 各有专条、网络抓取
 * 内容即结果——均不走标量取消。
 */
export function deriveFlatScalarSummary(tc: MessageToolCall): string | null {
  const n = toolNameOf(tc);
  if (
    isShellToolName(n) ||
    isEditToolName(n) ||
    isReadFileToolName(n) ||
    n.includes('grep') ||
    n.includes('stat') ||
    n === 'list_dir' ||
    n.includes('listdir') ||
    n.includes('fetch') ||
    n.includes('browser') ||
    n.includes('url')
  ) {
    return null;
  }
  const raw = tc.output || '';
  if (isPlaceholderToolOutput(raw) || isTrivialToolOutput(raw)) return null;
  const cleaned = sanitizeToolDisplayOutput(raw).trim();
  if (!cleaned) return null;
  // JSON 形态（单行或多行整体）：扁平标量 → 紧凑序列化即摘要；
  // 嵌套 JSON 直接出局，不许落到单行文本兜底（内容型输出）
  if (cleaned.startsWith('{') || cleaned.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(cleaned);
      if (isFlatScalarJsonValue(parsed)) {
        const compact = JSON.stringify(parsed);
        if (compact && compact.length <= FLAT_SCALAR_SUMMARY_MAX_CHARS) {
          return compact;
        }
      }
      return null;
    } catch {
      // 形似 JSON 但不可解析 → 落到单行文本口径
    }
  }
  // 单行纯文本结果（ack 类）：全文即摘要
  if (!cleaned.includes('\n')) {
    return cleaned.length <= FLAT_SCALAR_SUMMARY_MAX_CHARS ? cleaned : null;
  }
  return null;
}

/** 工具行展开政策：唯一决策点（决策序见文件头） */
export function resolveToolExpansionPolicy(
  tc: MessageToolCall
): ToolExpansionPolicy {
  // 1. 审批：不进本政策（审批行由审批分支独立渲染），兜底 none
  if (tc.status === 'pending_approval') return 'none';
  // 2. 后台活跃：BG5 状态条即完整呈现，占位信封原始 JSON 绝不进展开体
  if (isToolBackgroundActive(tc)) return 'none';
  // 5'. 读取类（非错误）：源码不内联——置于运行态之前，保持旧谓词
  //     「read 检查先于 running 分支」的历史口径
  if (isReadFileToolName(tc.name || '') && tc.status !== 'error') {
    return 'none';
  }
  // 运行态附则：有流式输出或非平凡入参的行保留实时展开
  if (tc.status === 'running') {
    return (tc.arguments && tc.arguments.trim().length > 2) ||
      (tc.output && tc.output.trim())
      ? 'inline'
      : 'none';
  }
  // 3. 错误：非平凡诊断输出必须就地可读；空/平凡则无展开
  if (tc.status === 'error') {
    return hasNonTrivialOutput(tc) ? 'inline' : 'none';
  }
  // 以下仅剩成功终态（状态联合 running|success|error|pending_approval）
  // 4. 可解析 diff 的 edit/write → 改道侧栏差异面板
  if (isEditToolName(tc.name || '') && resolveToolCallDiffs(tc).length > 0) {
    return 'side-diff';
  }
  // 6. 可解析 file_stat → 属性已进行头摘要（§6 前置），无展开
  if (isFileStatTool(tc) && FILE_STAT_WIRE_RE.test(tc.output || '')) {
    return 'none';
  }
  // 7. 空结构化结果：行头「无匹配 / 空目录」摘要即完整信息
  if (isEmptyGrepResult(tc) || isEmptyListDirResult(tc)) return 'none';
  // 8. 仅入参体：终态输出为空/占位/平凡 → 入参不是结果，无展开
  //    （旧谓词「入参长度 > 2 即展开」在此物理退役）
  if (!hasNonTrivialOutput(tc)) return 'none';
  // 图片输出是内容本体 → 内联（决策序 10 的内容先行项）
  if (extractImageRefs(tc.output || '').length > 0) return 'inline';
  // 9. 扁平标量：能派生完整行内摘要才取消，派生不出落 10 兜底
  if (deriveFlatScalarSummary(tc) !== null) return 'none';
  // 10. 其余有内容者 → 内联
  return 'inline';
}
