/**
 * 工具卡片与终端指令格式化与展示纯函数。
 */

import type { MessageToolCall, SessionMessage } from '../../store/layoutStore';
import {
  isEditToolName,
  isShellToolName,
  looksLikeDirectoryListing,
  sanitizeToolDisplayOutput,
} from '../toolFeedback';
export { isShellToolName } from '../toolFeedback';
import type { ToolRowTone } from './toolPresentationTypes';

/** 仅真正会话中断才隐藏，勿匹配「工具未完成」等收口文案 */
const HIDE_TOOL_RE = /上次会话中断|会话中断|interrupted|cancelled by user/i;

/** 仅真正会话中断才隐藏（timelineNormalizer 过滤用） */
export function isInterruptedTool(tc: MessageToolCall): boolean {
  if (tc.status !== 'error') return false;
  return HIDE_TOOL_RE.test(tc.output || '');
}

/** 从 arguments 抽出命令/路径 */
export function extractToolCommand(args: string): string {
  if (!args?.trim()) return '';
  const raw = args.trim();
  if (!raw.startsWith('{') && !raw.startsWith('[')) return raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      if ('parameters' in (parsed as object) || 'toolName' in (parsed as object)) {
        const p = parsed as Record<string, unknown>;
        const inner = p.parameters ?? p.input;
        if (inner && typeof inner === 'object') {
          return extractToolCommand(JSON.stringify(inner));
        }
        if (typeof p.command === 'string' && p.command.trim()) return p.command.trim();
        if (typeof p.summary === 'string' && p.summary.trim()) return p.summary.trim();
      }
      // 与 extractFilePathFromToolArgs 路径键对齐，避免 file_path 等漏标
      for (const key of [
        'command',
        'cmd',
        'path',
        'filePath',
        'file_path',
        'target_file',
        'targetFile',
        'filename',
        'file',
        'url',
        'uri',
        'query',
        'pattern',
      ]) {
        const v = (parsed as Record<string, unknown>)[key];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
      if (typeof (parsed as { content?: string }).content === 'string') {
        const c = (parsed as { content: string }).content.trim();
        return c.slice(0, 80) + (c.length > 80 ? '…' : '');
      }
    }
  } catch {
    /* plain */
  }
  return raw;
}

/** 运行中 / 空占位输出（不进预览、不撑开行高） */
export function isPlaceholderToolOutput(output: string | undefined | null): boolean {
  if (!output) return true;
  const t = output.trim();
  if (!t) return true;
  return /^(执行中|运行中)…?$/.test(t);
}

/** 纯终态词，无实质内容（完成态行上用勾/叉表达，不占展开体） */
export function isTrivialToolOutput(output: string | undefined | null): boolean {
  if (!output) return true;
  const t = output.trim();
  if (!t) return true;
  if (isPlaceholderToolOutput(t)) return true;
  return /^(完成|OK|ok|Done|done|失败|failed|已拒绝|已取消|cancelled|canceled)$/i.test(t);
}

/** 折叠行预览可截断；展开区请用 fullToolOutput */
function truncateToolOutput(output: string, maxLines = 16, maxChars = 1600): string {
  if (!output) return '';
  // 运行中占位不展示；纯终态词也不作预览噪音
  if (isPlaceholderToolOutput(output) || isTrivialToolOutput(output)) return '';
  let text = sanitizeToolDisplayOutput(output);
  if (!text) return '';
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…（已截断）';
  const lines = text.split('\n');
  if (lines.length > maxLines) {
    return lines.slice(0, maxLines).join('\n') + `\n…（共 ${lines.length} 行）`;
  }
  return text;
}

/** 展开区完整正文（仅清洗，不截断） */
export function fullToolOutput(output: string): string {
  if (!output) return '';
  if (isPlaceholderToolOutput(output)) return '';
  // 纯终态词：展开体不重复「完成」（由行尾状态表达）
  if (isTrivialToolOutput(output)) return '';
  const text = sanitizeToolDisplayOutput(output);
  return text || '';
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || p;
}

/** 从工具参数取可点路径展示名（basename） */
export function toolPathDisplayName(filePath: string): string {
  return basename(filePath);
}

/**
 * git shortstat 摘要行（无 unified body 时仍给折叠行 ±）。
 * 例：`1 file changed, 3 insertions(+), 1 deletion(-)`
 * 或缺侧：`2 files changed, 5 insertions(+)` / `1 file changed, 2 deletions(-)`
 */
export function parseGitShortstat(text: string): { add: number; del: number } | null {
  if (!text) return null;
  // 允许前后有空白/前缀日志；取最后一次匹配（多次 summary 时以终态为准）
  const re =
    /(\d+)\s+files?\s+changed(?:\s*,\s*(\d+)\s+insertions?\(\+\))?(?:\s*,\s*(\d+)\s+deletions?\(-\))?/gi;
  let m: RegExpExecArray | null = null;
  let last: RegExpExecArray | null = null;
  while ((m = re.exec(text)) != null) last = m;
  if (!last) {
    // 无 files changed 头时的残段：`3 insertions(+), 1 deletion(-)`
    const loose = text.match(
      /(?:^|[\s,])(\d+)\s+insertions?\(\+\)(?:\s*,\s*(\d+)\s+deletions?\(-\))?/i,
    );
    const onlyDel = !loose
      ? text.match(/(?:^|[\s,])(\d+)\s+deletions?\(-\)/i)
      : null;
    if (loose) {
      const a = Number(loose[1]) || 0;
      const d = Number(loose[2]) || 0;
      if (a === 0 && d === 0) return null;
      return { add: a, del: d };
    }
    if (onlyDel) {
      const d = Number(onlyDel[1]) || 0;
      if (d === 0) return null;
      return { add: 0, del: d };
    }
    return null;
  }
  const add = Number(last[2]) || 0;
  const del = Number(last[3]) || 0;
  if (add === 0 && del === 0) return null;
  return { add, del };
}

/** 是否像 unified / apply_patch 文本（才扫 +/- 行，避免日志误伤） */
function looksLikeUnifiedOrPatchText(lines: string[]): boolean {
  return lines.some(
    (l) =>
      l.startsWith('diff --git ') ||
      /^@@\s/.test(l) ||
      l.startsWith('+++ ') ||
      l.startsWith('--- ') ||
      // apply_patch / V4A 风格
      /^\*{3}\s+(Begin Patch|Update File|Add File|Delete File|End Patch)/i.test(l) ||
      l.startsWith('*** Begin Patch') ||
      l.startsWith('*** Update File:') ||
      l.startsWith('*** Add File:'),
  );
}

/** 是否应跳过的 +/- 伪 diff 行（文件头、binary 提示等） */
function isDiffMetaPlusMinusLine(line: string): boolean {
  if (line.startsWith('+++') || line.startsWith('---')) return true;
  // binary / 重命名提示偶尔带 + 号但非内容行
  if (/^\+\+\+ \//.test(line) || /^--- \//.test(line)) return true;
  return false;
}

/**
 * 编辑类工具行内 +N / −M。
 * 优先 structured diffs（按文件：缺计数时从 changes 补）；
 * 无则从 unified / apply_patch 输出扫；再退到 git shortstat。
 * 目录列表输出绝不计为 ±，防 ls/dir 误伤。
 */
export function toolDiffLineStats(tc: MessageToolCall): { add: number; del: number } | null {
  let add = 0;
  let del = 0;
  if (tc.diffs?.length) {
    for (const d of tc.diffs) {
      // 非有限数当 0，避免 NaN 污染合计
      let dAdd = Number.isFinite(d.additions) ? Math.max(0, d.additions) : 0;
      let dDel = Number.isFinite(d.deletions) ? Math.max(0, d.deletions) : 0;
      // 按文件：缺侧计数用 changes 补；流式时 additions 先到 deletions 仍 0 也能出 ±
      if (d.changes?.length) {
        let cAdd = 0;
        let cDel = 0;
        for (const c of d.changes) {
          if (c.type === 'addition') cAdd += 1;
          else if (c.type === 'deletion') cDel += 1;
        }
        if (dAdd === 0 && dDel === 0) {
          dAdd = cAdd;
          dDel = cDel;
        } else {
          if (dAdd === 0 && cAdd > 0) dAdd = cAdd;
          if (dDel === 0 && cDel > 0) dDel = cDel;
        }
      }
      add += dAdd;
      del += dDel;
    }
  }
  if (add === 0 && del === 0 && tc.output && !isPlaceholderToolOutput(tc.output)) {
    // 去 BOM + 统一换行，避免 CRLF/脏头导致 shortstat / @@ 失配
    const text = tc.output.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    // 目录列表的 Mode/d----- 行绝不能当 diff
    if (!looksLikeDirectoryListing(text)) {
      const lines = text.split('\n');
      if (looksLikeUnifiedOrPatchText(lines)) {
        for (const line of lines) {
          if (!line) continue;
          // 跳过 patch 元数据与 \ No newline
          if (line.startsWith('\\') || line.startsWith('***')) continue;
          if (line.startsWith('+') && !isDiffMetaPlusMinusLine(line)) add += 1;
          else if (line.startsWith('-') && !isDiffMetaPlusMinusLine(line)) del += 1;
        }
        // 仅有 @@ 头、无 body 时：从 hunk 头估增减（new,old 计数）
        if (add === 0 && del === 0) {
          for (const line of lines) {
            const m = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s@@/);
            if (!m) continue;
            const oldN = m[2] != null ? Number(m[2]) : 1;
            const newN = m[4] != null ? Number(m[4]) : 1;
            if (!Number.isFinite(oldN) || !Number.isFinite(newN)) continue;
            // 粗估：净增 / 净减（无法还原真实行时至少给非零提示）
            if (newN > oldN) add += newN - oldN;
            else if (oldN > newN) del += oldN - newN;
          }
        }
      }
      // 无 +/- body 时：git commit/apply 的 shortstat 仍给折叠行角标
      if (add === 0 && del === 0) {
        const short = parseGitShortstat(text);
        if (short) {
          add = short.add;
          del = short.del;
        }
      }
    }
  }
  if (add === 0 && del === 0) return null;
  // 出口再钳一次，保证折叠行 ± 非负整数
  return normalizeToolDiffStat({ add, del });
}

/**
 * 折叠行 ± 成对数字（非负有限整数）。展示与 title/aria 共用，避免只见 + 不见 −。
 * NaN / Infinity / 负数一律钳为 0。
 */
export function normalizeToolDiffStat(stats: { add: number; del: number }): {
  add: number;
  del: number;
} {
  const clamp = (n: unknown): number => {
    const v = typeof n === 'number' ? n : Number(n);
    if (!Number.isFinite(v) || v < 0) return 0;
    return Math.floor(v);
  };
  return {
    add: clamp(stats?.add),
    del: clamp(stats?.del),
  };
}

/**
 * 折叠行 ± 文案：始终成对展示（含 0）。
 * 例：+3 −1、+0 −2（减号用 U+2212，与 UI .del 一致）
 */
export function formatToolDiffStat(stats: { add: number; del: number }): string {
  const { add: a, del: d } = normalizeToolDiffStat(stats);
  return `+${a} −${d}`;
}

/**
 * 是否有可展示的 ± 角标（折叠行用）。
 * 与 toolDiffLineStats 同真源，避免 UI 各写一套判空。
 */
export function toolHasDiffStat(tc: MessageToolCall): boolean {
  const s = toolDiffLineStats(tc);
  return Boolean(s && (s.add > 0 || s.del > 0));
}

/**
 * 工具行默认是否展开。
 * 契约：完成态 / 短结果 / 错误 / diffs / running 一律默认折叠，防流式高度抖动。
 * 用户点击后由 expandedTools 覆盖（见 resolveToolRowOpen）。
 */
export function isToolRowDefaultOpen(
  _tc?: {
    status?: string;
    output?: string | undefined;
    diffs?: unknown[] | undefined;
  } | null,
): boolean {
  return false;
}

/**
 * 解析工具行是否展开：用户显式状态优先，否则走默认折叠契约。
 * expandedTools 无该 key → 默认折叠（false）；有 key → 用其布尔值。
 */
export function resolveToolRowOpen(
  expandedTools: Record<string, boolean> | null | undefined,
  toolId: string,
  tc?: {
    status?: string;
    output?: string | undefined;
    diffs?: unknown[] | undefined;
  } | null,
): boolean {
  if (expandedTools != null && Object.prototype.hasOwnProperty.call(expandedTools, toolId)) {
    return Boolean(expandedTools[toolId]);
  }
  return isToolRowDefaultOpen(tc);
}

/** 行视觉态：固定类名，流式切换不改布局骨架 */
export function toolRowTone(status: MessageToolCall['status'] | undefined): ToolRowTone {
  if (status === 'running') return 'running';
  if (status === 'error') return 'error';
  if (status === 'pending_approval') return 'pending';
  if (status === 'success') return 'success';
  return 'idle';
}

/**
 * 是否有值得点击展开的实质结果。
 * 纯「完成」/空输出不展开，避免折叠行噪音与高度抖动。
 */
export function toolHasExpandableBody(tc: MessageToolCall): boolean {
  if (tc.status === 'running' || tc.status === 'pending_approval') return false;
  if (tc.diffs && tc.diffs.length > 0) return true;
  if (extractImageRefs(tc.output || '').length > 0) return true;
  const raw = tc.output || '';
  if (isPlaceholderToolOutput(raw) || isTrivialToolOutput(raw)) return false;
  return Boolean(sanitizeToolDisplayOutput(raw).trim());
}

/** 只读/查询类工具（timelineNormalizer 折叠展示用） */
export function isInspectTool(tc: MessageToolCall): boolean {
  if (tc.status === 'pending_approval') return false;
  const n = (tc.name || '').toLowerCase();
  if (isEditToolName(n)) return false;
  if (isShellToolName(n)) {
    const cmd = extractToolCommand(tc.arguments || '').toLowerCase();
    if (/^(pwd|ls|dir|cat|type|head|tail|git\s+status|git\s+diff|git\s+log|echo|whoami|hostname)\b/.test(cmd)) {
      return true;
    }
    if (/\b(rm|del|move|copy|set-content|out-file|write|install|npm\s+i|mkdir)\b/i.test(cmd)) {
      return false;
    }
    return true;
  }
  return (
    n.includes('read') ||
    n.includes('grep') ||
    n.includes('search') ||
    n.includes('list') ||
    n.includes('glob') ||
    n.includes('stat')
  );
}

/**
 * 是否有可展示结果（含终态标记）。
 * 展开交互请用 toolHasExpandableBody，避免空「完成」撑开。
 */
export function toolHasDisplayableResult(tc: MessageToolCall): boolean {
  if (tc.status === 'running' || tc.status === 'pending_approval') return false;
  if (toolHasExpandableBody(tc)) return true;
  return tc.status === 'success' || tc.status === 'error';
}

/** 是否像「人能读」的说明（非命令、非 JSON）——优先作摘要行 */
function isHumanExplanation(text: string, toolName: string): boolean {
  const t = text.trim();
  if (!t || t === toolName || t === '需要确认') return false;
  if (t.startsWith('{') || t.startsWith('[')) return false;
  // 纯路径/命令串
  if (/^[\w./\\:-]+\s+[\w./\\:-]+/.test(t) && !/[\u4e00-\u9fff]/.test(t)) return false;
  // 含中文：允许更长意图句（展示时再截断）
  if (/[\u4e00-\u9fff]/.test(t)) return t.length >= 2 && t.length <= 240;
  // 英文短说明（非路径）
  if (/^[A-Za-z]/.test(t) && t.length >= 6 && t.length <= 160 && !/[\\/]{2,}/.test(t)) {
    if (/^(ls|cd|cat|mkdir|rm|cp|mv|git|npm|pnpm|yarn)\b/i.test(t)) return false;
    return true;
  }
  return false;
}

/**
 * 模型 explanation 若只是动作模板（运行命令/查看文件…），丢弃，再回退 args。
 * 真有意图的句子一律保留给摘要行。
 */
function isGenericExplanationSpam(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  // 纯动作模板（无具体意图）
  if (
    /^(正在)?(查看|浏览|修改|搜索|访问|读取|写入|列出|创建|运行)(文件|目录|代码|网络|内容|命令|工具)?$/.test(
      t,
    )
  ) {
    return true;
  }
  // 「查看 foo.ts」「正在查看 bar」——只有动作+路径，不是意图说明
  if (/^正在?(查看|浏览|修改|搜索|访问|读取|写入|运行)\s+\S{1,80}$/.test(t)) return true;
  if (
    /^(创建目录|列出目录|列出目录内容|运行命令|运行终端命令|查看文件内容|查看文件|修改文件|写入文件|切换工作目录)(\s+\S+)?$/.test(
      t,
    )
  ) {
    return true;
  }
  if (/^正在?(创建目录|列出目录|查看文件|修改文件|写入文件|运行命令|访问网络)\b/.test(t) && t.length < 24) {
    return true;
  }
  if (/^使用工具处理\s+\S+$/.test(t)) return true;
  if (/^调用\s+[\w\s.-]+$/.test(t)) return true;
  return false;
}

/** 摘要行展示截断 */
function clipToolLabel(text: string, max = 80): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + '…';
}

/** 去掉前导 cd / 取链式命令中真正干活的一段（便于人话） */
function primaryShellSegment(cmd: string): string {
  let s = cmd.replace(/\s+/g, ' ').trim();
  if (!s) return s;

  // 反复剥掉前导 cd / Set-Location / pushd（cd foo && npm i）
  const cdHead =
    /^(?:cd|Set-Location|sl|pushd)\s+(?:\/[dD]\s+)?(?:"[^"]+"|'[^']+'|[^\s&|;]+)\s*(?:&&|;)\s*/i;
  while (cdHead.test(s)) {
    s = s.replace(cdHead, '');
  }

  // 仍有 && / ; 链：取最后一个非 cd 段（多半是实际操作）
  if (/\s*(?:&&|;)\s*/.test(s)) {
    const parts = s
      .split(/\s*(?:&&|;)\s*/)
      .map((p) => p.trim())
      .filter(Boolean)
      .filter((p) => !/^(?:cd|Set-Location|sl|pushd)\b/i.test(p));
    if (parts.length) s = parts[parts.length - 1]!;
  }

  // PowerShell / bash 管道：用管道第一段做主意图（| Select-Object 等多为过滤）
  if (/\s\|\s/.test(s) && !/^\s*aws\b/i.test(s)) {
    const head = s.split(/\s\|\s/)[0]?.trim();
    if (head) s = head;
  }

  return s.trim();
}

/** 抽出 powershell/pwsh -Command/-c 内层脚本 */
function unwrapPowerShellCommand(cmd: string): string {
  const s = cmd.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const m = s.match(
    /^(?:powershell|pwsh)(?:\.exe)?\b(?:\s+-[A-Za-z]+)*=?(?:\s+"([^"]*)"|\s+'([^']*)'|\s+(.+))?$/i,
  );
  if (!m) {
    const m2 = s.match(
      /(?:powershell|pwsh)(?:\.exe)?\b[\s\S]*?-(?:Command|c)\s+(?:"([^"]*)"|'([^']*)'|(.+))$/i,
    );
    if (!m2) return s;
    return (m2[1] || m2[2] || m2[3] || '').trim();
  }
  return (m[1] || m[2] || m[3] || '').trim() || s;
}

/**
 * 把终端/shell 命令翻译成用户一眼能懂的说明。
 * 技术原文仍由 toolCommandPreview / tool-row-cmd 展示。
 */
export function humanizeShellCommand(cmd: string): string {
  const full = cmd.replace(/\s+/g, ' ').trim();
  if (!full) return '运行命令';
  const unwrapped =
    /^(?:powershell|pwsh)\b/i.test(full) ? unwrapPowerShellCommand(full) || full : full;
  const raw = primaryShellSegment(unwrapped);
  if (!raw) return '运行命令';
  const lower = raw.toLowerCase();

  // 包管理 / 脚本（npm / pnpm / yarn）
  if (/\b(npm|pnpm|yarn)\s+(ci|install|i)(\s|$)/i.test(raw)) {
    const rest = raw.replace(/^.*\b(?:ci|install|i)\s*/i, '').trim();
    const pkg = rest.split(/\s+/).find((t) => t && !t.startsWith('-'));
    return pkg ? `安装依赖 ${pkg}` : '安装项目依赖';
  }
  if (/\b(npm|pnpm|yarn)\s+add\s+/i.test(raw)) {
    const pkg = raw.replace(/^.*\badd\s+/i, '').split(/\s+/).find((t) => t && !t.startsWith('-'));
    return pkg ? `安装依赖 ${pkg}` : '安装项目依赖';
  }
  if (/\b(npm|pnpm|yarn)\s+run\s+([\w:-]+)/i.test(raw) || /\b(npm|pnpm|yarn)\s+([\w:-]+)\b/i.test(raw)) {
    const m = raw.match(/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?([\w:-]+)/i);
    const script = m?.[1]?.toLowerCase();
    const skip = !script || script === 'i' || script === 'install' || script === 'ci' || script === 'add';
    if (!skip) {
      if (script === 'build' || script === 'prod') return '构建项目';
      if (script === 'dev' || script === 'start') return '启动开发服务';
      if (script === 'test' || script.startsWith('test:')) return '运行测试';
      if (script === 'lint' || script.startsWith('lint')) return '检查代码规范';
      if (script === 'typecheck' || script === 'tsc') return '检查类型';
      return `运行脚本 ${script}`;
    }
  }
  if (/\bnpx\s+/i.test(raw)) {
    const tool = raw.replace(/^.*\bnpx\s+/i, '').split(/\s+/)[0];
    return tool ? `运行工具 ${tool}` : '运行命令行工具';
  }
  if (/\b(pnpm|yarn)\s+dlx\s+/i.test(raw)) {
    const tool = raw.replace(/^.*\bdlx\s+/i, '').split(/\s+/)[0];
    return tool ? `运行工具 ${tool}` : '运行命令行工具';
  }

  // Bun
  if (/\bbun\s+(ci|install|i)(\s|$)/i.test(raw)) {
    const rest = raw.replace(/^.*\b(?:ci|install|i)\s*/i, '').trim();
    const pkg = rest.split(/\s+/).find((t) => t && !t.startsWith('-'));
    return pkg ? `安装依赖 ${pkg}` : '安装项目依赖';
  }
  if (/\bbun\s+add\s+/i.test(raw)) {
    const pkg = raw.replace(/^.*\badd\s+/i, '').split(/\s+/).find((t) => t && !t.startsWith('-'));
    return pkg ? `安装依赖 ${pkg}` : '安装项目依赖';
  }
  if (/\bbun\s+x\s+/i.test(raw) || /\bbunx\s+/i.test(raw)) {
    const tool = raw.replace(/^.*\b(?:bun\s+x|bunx)\s+/i, '').split(/\s+/)[0];
    return tool ? `运行工具 ${tool}` : '运行命令行工具';
  }
  if (/\bbun\s+(run\s+)?(test|build|dev|start|lint|typecheck)\b/i.test(raw)) {
    const m = raw.match(/\bbun\s+(?:run\s+)?([\w:-]+)/i);
    const script = m?.[1]?.toLowerCase();
    if (script === 'build') return '构建项目';
    if (script === 'dev' || script === 'start') return '启动开发服务';
    if (script === 'test' || script?.startsWith('test')) return '运行测试';
    if (script === 'lint' || script?.startsWith('lint')) return '检查代码规范';
    if (script === 'typecheck' || script === 'tsc') return '检查类型';
  }
  if (/\bbun\s+run\s+([\w:-]+)/i.test(raw)) {
    const script = raw.match(/\bbun\s+run\s+([\w:-]+)/i)?.[1];
    return script ? `运行脚本 ${script}` : '运行脚本';
  }
  if (/\bbun\b/i.test(raw)) return '执行 Bun 命令';

  // PHP Composer
  if (/\bcomposer\s+install\b/i.test(raw)) return '安装 PHP 依赖';
  if (/\bcomposer\s+require\b/i.test(raw)) {
    const pkg = raw.replace(/^.*\brequire\s+/i, '').split(/\s+/).find((t) => t && !t.startsWith('-'));
    return pkg ? `添加 PHP 依赖 ${pkg}` : '添加 PHP 依赖';
  }
  if (/\bcomposer\s+update\b/i.test(raw)) return '更新 PHP 依赖';
  if (/\bcomposer\b/i.test(raw)) return '执行 Composer 命令';

  // Python 包 / 脚本
  if (/\b(pip3?|python\s+-m\s+pip|py\s+-m\s+pip)\s+(install|i)\b/i.test(raw)) {
    const rest = raw.replace(/^.*\b(?:install|i)\s*/i, '').trim();
    const pkg = rest.split(/\s+/).find((t) => t && !t.startsWith('-'));
    return pkg ? `安装 Python 包 ${pkg}` : '安装 Python 依赖';
  }
  if (/\b(pip3?|python\s+-m\s+pip)\s+uninstall\b/i.test(raw)) return '卸载 Python 包';
  if (/\b(pip3?|python\s+-m\s+pip)\s+list\b/i.test(raw)) return '查看已装 Python 包';
  if (/\bpython\b|\bpy\b/i.test(lower) && /\.py\b/i.test(raw)) return '运行 Python 脚本';
  if (/\bpytest\b/i.test(raw)) return '运行 Python 测试';

  // Go
  if (/\bgo\s+test\b/i.test(raw)) return '运行 Go 测试';
  if (/\bgo\s+build\b/i.test(raw)) return '构建 Go 项目';
  if (/\bgo\s+run\b/i.test(raw)) return '运行 Go 程序';
  if (/\bgo\s+mod\b/i.test(raw)) return '管理 Go 依赖';
  if (/\bgo\s+get\b/i.test(raw)) return '获取 Go 依赖';
  if (/\bgo\s+fmt\b|\bgo\s+vet\b/i.test(raw)) return '检查 Go 代码';
  if (/\bgo\s+/i.test(raw)) return '执行 Go 命令';

  // Rust
  if (/\bcargo\s+run\b/i.test(raw)) return '运行 Rust 程序';
  if (/\bcargo\s+test\b/i.test(raw)) return '运行 Rust 测试';
  if (/\bcargo\s+clippy\b/i.test(raw)) return '检查 Rust 代码';
  if (/\bcargo\s+fmt\b/i.test(raw)) return '格式化 Rust 代码';
  if (/\bcargo\s+check\b/i.test(raw)) return '检查 Rust 编译';
  if (/\bcargo\s+build\b/i.test(raw)) return '构建 Rust 项目';
  if (/\bcargo\s+add\b/i.test(raw)) return '添加 Rust 依赖';
  if (/\bcargo\s+/i.test(raw)) return '执行 Cargo 命令';
  if (/\brustc\b/i.test(raw)) return '编译 Rust 源码';

  // .NET
  if (/\bdotnet\s+test\b/i.test(raw)) return '运行 .NET 测试';
  if (/\bdotnet\s+build\b/i.test(raw)) return '构建 .NET 项目';
  if (/\bdotnet\s+run\b/i.test(raw)) return '运行 .NET 程序';
  if (/\bdotnet\s+restore\b/i.test(raw)) return '还原 .NET 依赖';
  if (/\bdotnet\s+publish\b/i.test(raw)) return '发布 .NET 项目';
  if (/\bdotnet\s+/i.test(raw)) return '执行 .NET 命令';

  // CMake / Make
  if (/\bcmake\b/i.test(raw)) {
    if (/\b--build\b/i.test(raw) || /\s+--build\b/i.test(raw)) return '用 CMake 构建';
    return '配置 CMake 工程';
  }
  if (/^make\b/i.test(raw) || /\bmake\s+[\w-]+/i.test(raw)) {
    const t = raw.match(/^make\s+([\w.-]+)/i)?.[1];
    if (t && t !== '-j' && !t.startsWith('-')) return `执行 make ${t}`;
    return '执行 Make 构建';
  }

  // Git
  if (/\bgit\s+status\b/i.test(raw)) return '查看代码变更状态';
  if (/\bgit\s+diff\b/i.test(raw)) return '查看文件差异';
  if (/\bgit\s+log\b/i.test(raw)) return '查看提交历史';
  if (/\bgit\s+add\b/i.test(raw)) return '暂存改动';
  if (/\bgit\s+commit\b/i.test(raw)) return '创建提交';
  if (/\bgit\s+push\b/i.test(raw)) return '推送到远程';
  if (/\bgit\s+pull\b/i.test(raw)) return '拉取远程更新';
  if (/\bgit\s+checkout\b|\bgit\s+switch\b/i.test(raw)) return '切换分支';
  if (/\bgit\s+branch\b/i.test(raw)) return '查看或管理分支';
  if (/\bgit\s+clone\b/i.test(raw)) return '克隆仓库';
  if (/\bgit\s+fetch\b/i.test(raw)) return '获取远程更新';
  if (/\bgit\s+merge\b|\bgit\s+rebase\b/i.test(raw)) return '合并分支';
  if (/\bgit\s+stash\b/i.test(raw)) return '贮藏工作区改动';
  if (/\bgit\s+reset\b/i.test(raw)) return '重置 Git 状态';
  if (/\bgit\s+restore\b/i.test(raw)) return '还原文件改动';
  if (/\bgit\s+revert\b/i.test(raw)) return '回退某次提交';
  if (/\bgit\s+show\b/i.test(raw)) return '查看提交详情';
  if (/\bgit\s+/i.test(raw)) return '执行 Git 操作';

  // 云 / 集群 / 远程
  if (/\bkubectl\b/i.test(raw)) {
    if (/\bget\b/i.test(raw)) return '查询 Kubernetes 资源';
    if (/\bapply\b/i.test(raw)) return '应用 Kubernetes 配置';
    if (/\blogs\b/i.test(raw)) return '查看集群日志';
    if (/\bdescribe\b/i.test(raw)) return '查看 Kubernetes 详情';
    if (/\bdelete\b/i.test(raw)) return '删除 Kubernetes 资源';
    if (/\bexec\b/i.test(raw)) return '进入集群容器';
    return '执行 Kubernetes 操作';
  }
  if (/\baws\b/i.test(raw)) {
    if (/\bs3\b/i.test(raw)) return '操作 AWS S3';
    if (/\bec2\b/i.test(raw)) return '操作 AWS EC2';
    if (/\blambda\b/i.test(raw)) return '操作 AWS Lambda';
    if (/\bsts\b/i.test(raw)) return '查询 AWS 身份';
    return '执行 AWS 命令';
  }
  if (/^ssh\b/i.test(raw) || /\bssh\s+/i.test(raw)) return '通过 SSH 连接远程';
  if (/^scp\b/i.test(raw) || /\bscp\s+/i.test(raw)) return '通过 SCP 传输文件';
  if (/\bdocker\b/i.test(raw)) {
    if (/\bps\b/i.test(raw)) return '查看 Docker 容器';
    if (/\bbuild\b/i.test(raw)) return '构建 Docker 镜像';
    if (/\bcompose\b/i.test(raw) || /\b-compose\b/i.test(raw)) return '运行 Docker Compose';
    if (/\blogs\b/i.test(raw)) return '查看 Docker 日志';
    return '运行 Docker 相关命令';
  }

  // 权限
  if (/^chmod\b/i.test(raw) || /\bchmod\s+/i.test(raw)) return '修改文件权限';
  if (/^chown\b/i.test(raw) || /\bchown\s+/i.test(raw)) return '修改文件所有者';

  // 编译 / 检查 / 测试
  if (/\btsc\b/i.test(raw) || /\btypescript\b/i.test(raw)) return '检查 TypeScript 类型';
  if (/\beslint\b/i.test(raw)) return '运行 ESLint 检查';
  if (/\bprettier\b/i.test(raw)) return '格式化代码';
  if (/\bvitest\b|\bjest\b/i.test(raw)) return '运行测试';
  if (/\bnode\b/i.test(lower) && /\.m?js\b/i.test(raw)) return '运行 Node 脚本';

  // 文件浏览 / 读写（含 PowerShell 别名）
  if (
    /^(ls|dir|ll|Get-ChildItem|gci)\b/i.test(raw) ||
    /\bGet-ChildItem\b/i.test(raw) ||
    (/\bls\s+/i.test(raw) && !/\bnpm\b/i.test(raw))
  ) {
    return '列出目录内容';
  }
  if (/^(cat|type|Get-Content|gc|head|tail)\b/i.test(raw) || /\bGet-Content\b/i.test(raw)) {
    const file = raw.split(/\s+/).find((p) => /[./\\]/.test(p) && !p.startsWith('-'));
    return file ? `查看 ${basename(file)}` : '查看文件内容';
  }
  if (/^(rm|del|Remove-Item|ri)\b/i.test(raw) || /\bRemove-Item\b/i.test(raw)) return '删除文件或目录';
  if (/^(cp|copy|Copy-Item)\b/i.test(raw) || /\bCopy-Item\b/i.test(raw)) return '复制文件';
  if (/^(mv|move|Move-Item|ren|Rename-Item)\b/i.test(raw) || /\bMove-Item\b|\bRename-Item\b/i.test(raw)) {
    return '移动或重命名';
  }
  if (/^(mkdir|md|New-Item)\b/i.test(raw) || /\bNew-Item\b/i.test(raw)) {
    const dir = raw
      .split(/\s+/)
      .slice(1)
      .find((p) => p && !p.startsWith('-') && !/^-(ItemType|Force|Path)$/i.test(p));
    const clean = dir?.replace(/^['"]|['"]$/g, '');
    return clean ? `创建目录 ${basename(clean)}` : '创建目录';
  }
  if (/^(cd|Set-Location|sl|pushd|popd)\b/i.test(raw)) {
    const dir = raw.split(/\s+/).slice(1).find((p) => p && !p.startsWith('-') && !/^\/[dD]$/i.test(p));
    const clean = dir?.replace(/^['"]|['"]$/g, '');
    return clean ? `切换到 ${basename(clean)}` : '切换工作目录';
  }

  // 搜索
  if (/\brg\b|\bgrep\b|\bfindstr\b|\bSelect-String\b|\bfind\b/i.test(raw)) {
    const q = raw.match(/['"]([^'"]{1,40})['"]/) || raw.match(/\s(-e\s+)?(\S{2,40})\s*$/);
    const term = q?.[1] || q?.[2];
    return term && !term.startsWith('-') ? `搜索「${term}」` : '搜索代码';
  }

  // 网络 / 进程
  if (/\bcurl\b|\bwget\b|\bInvoke-WebRequest\b|\bInvoke-RestMethod\b/i.test(raw)) return '请求网络资源';
  if (/\bGet-Process\b|\bStop-Process\b|(^|\s)ps(\s|$)/i.test(raw)) return '查看或管理进程';
  if (/\bGet-Service\b|\bStart-Service\b|\bStop-Service\b/i.test(raw)) return '管理 Windows 服务';
  if (/\bGet-ComputerInfo\b|\bGet-CimInstance\b|\bGet-WmiObject\b/i.test(raw)) return '查询系统信息';
  if (/\bStopwatch\b|\bMeasure-Command\b/i.test(raw)) return '测量执行耗时';
  if (/\bNew-Item\b.*-ItemType\s+File\b|\bSet-Content\b|\bOut-File\b|\bAdd-Content\b/i.test(raw)) {
    return '写入文件';
  }
  if (/\bSelect-Object\b|\bWhere-Object\b|\bForEach-Object\b|\bSort-Object\b/i.test(raw)) {
    return '处理命令输出';
  }

  const psInner = unwrapPowerShellCommand(full);
  if (psInner && psInner !== full) {
    const innerLabel = humanizeShellCommand(psInner);
    if (innerLabel && innerLabel !== '运行命令') return innerLabel;
  }
  if (/^powershell\b|^pwsh\b/i.test(full)) {
    const short = (psInner || full).replace(/\s+/g, ' ').trim();
    if (short.length > 48) return `运行脚本 ${short.slice(0, 47)}…`;
    return short ? `运行 ${short}` : '运行 PowerShell';
  }

  return '运行命令';
}

/**
 * 从工具名 + args 生成具体执行含义（不依赖 explanation）。
 */
function toolLabelFromArgs(tc: MessageToolCall): string {
  const name = (tc.name || 'tool').toLowerCase();
  const cmd = extractToolCommand(tc.arguments || '');

  if (
    isShellToolName(name) ||
    name.includes('bash') ||
    name.includes('shell') ||
    name.includes('exec') ||
    name.includes('powershell')
  ) {
    return cmd ? humanizeShellCommand(cmd) : '运行终端命令';
  }
  if (
    isEditToolName(name) ||
    name.includes('write') ||
    name.includes('edit') ||
    name.includes('patch') ||
    name.includes('apply')
  ) {
    const isWrite =
      /\bwrite\b/.test(name) ||
      name.includes('create') ||
      name === 'write_file' ||
      name === 'create_file';
    if (isWrite && !name.includes('edit') && !name.includes('patch') && !name.includes('replace')) {
      return cmd ? `写入 ${basename(cmd)}` : '写入文件';
    }
    return cmd ? `修改 ${basename(cmd)}` : '修改文件';
  }
  if (name.includes('read') || name.includes('cat') || name.includes('view') || name.includes('open_file')) {
    return cmd ? `查看 ${basename(cmd)}` : '查看文件';
  }
  if (name.includes('list') || name.includes('glob') || name.includes('dir') || name.includes('ls')) {
    if (cmd && cmd !== '.' && cmd !== './') {
      const short = cmd.length > 36 ? '…' + cmd.slice(-34) : cmd;
      return `浏览 ${short}`;
    }
    return '浏览目录';
  }
  if (name.includes('grep') || name.includes('search') || name.includes('find') || name.includes('rg')) {
    const q = cmd.replace(/^.*(?:pattern|query)["']?\s*[:=]\s*["']?/i, '').slice(0, 32);
    if (cmd && cmd.length < 40) return `搜索 ${cmd}`;
    if (q && !q.startsWith('{')) return `搜索「${q}」`;
    return '搜索代码';
  }
  if (name.includes('web') || name.includes('fetch') || name.includes('http') || name.includes('browser')) {
    if (cmd && /^https?:\/\//i.test(cmd)) {
      try {
        const host = new URL(cmd).hostname;
        return host ? `访问 ${host}` : '访问网络';
      } catch {
        /* fallthrough */
      }
    }
    return '访问网络';
  }
  if (name === 'run_subagent' || name.includes('subagent')) {
    try {
      const parsed = tc.arguments?.trim().startsWith('{')
        ? (JSON.parse(tc.arguments) as Record<string, unknown>)
        : null;
      const desc =
        (typeof parsed?.description === 'string' && parsed.description.trim()) ||
        (typeof parsed?.prompt === 'string' && parsed.prompt.trim().slice(0, 40)) ||
        '';
      if (desc) return `协作子任务：${desc.length > 40 ? desc.slice(0, 39) + '…' : desc}`;
    } catch {
      /* plain */
    }
    return '启动协作子任务';
  }
  if (name.includes('git')) {
    return cmd ? humanizeShellCommand(cmd.startsWith('git') ? cmd : `git ${cmd}`) : '执行 Git 操作';
  }
  if (name.includes('mcp')) return '调用扩展服务';
  if (name.includes('memory')) return '读写记忆';
  if (name.includes('todo') || name.includes('plan')) return '更新任务计划';

  if (cmd) {
    const short = basename(cmd);
    if (short && short.length < 48) return short === cmd ? `处理 ${short}` : `处理 ${short}`;
  }
  const n = tc.name || '工具';
  const pretty = n.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return pretty ? `调用 ${pretty}` : '调用工具';
}

/**
 * 摘要行人话：优先 AI explanation（意图说明）。
 */
export function toolHumanLabel(tc: MessageToolCall): string {
  const exp = (tc.explanation || '').trim();
  const name = tc.name || '';

  const expLooksLikeRawCmd =
    /^(powershell|pwsh|cmd(?:\.exe)?|bash|sh|zsh)\b/i.test(exp) ||
    (/^[\w./\\:-]+\s+/.test(exp) && exp.length > 48 && !/[\u4e00-\u9fff]/.test(exp));

  if (
    exp &&
    !expLooksLikeRawCmd &&
    !isGenericExplanationSpam(exp) &&
    isHumanExplanation(exp, name)
  ) {
    return clipToolLabel(exp);
  }
  if (
    exp &&
    !expLooksLikeRawCmd &&
    /[\u4e00-\u9fff]/.test(exp) &&
    exp.length >= 8 &&
    !isGenericExplanationSpam(exp)
  ) {
    return clipToolLabel(exp.replace(/^正在/, ''));
  }

  return clipToolLabel(toolLabelFromArgs(tc));
}

/**
 * 次要技术预览：真实命令/路径。
 */
export function toolCommandPreview(tc: MessageToolCall, max = 72): string {
  const cmd = extractToolCommand(tc.arguments || '');
  if (!cmd) return '';
  const human = toolHumanLabel(tc);
  let one = cmd.replace(/\s+/g, ' ').trim();
  if (/^(?:powershell|pwsh)\b/i.test(one)) {
    const inner = unwrapPowerShellCommand(one);
    if (inner && inner.length < one.length) one = inner;
  }
  if (human === one) return '';
  if (human.includes(one)) return '';
  return one.length <= max ? one : one.slice(0, max - 1) + '…';
}

/** 折叠行结果预览（一行） */
export function toolResultPreview(tc: MessageToolCall, max = 72): string {
  if (tc.status === 'running' || tc.status === 'pending_approval') return '';
  const raw = truncateToolOutput(tc.output || '', 2, max + 20);
  if (!raw) return '';
  const line = raw.split('\n').find((l) => l.trim()) || raw;
  const one = line.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : one.slice(0, max - 1) + '…';
}

/** 清洗协作 agent 的 summary */
export function humanizeAgentSummary(
  raw: string | undefined | null,
  status?: string,
): string {
  const fallback =
    status === 'running'
      ? '执行中…'
      : status === 'failed'
        ? '未完成'
        : status === 'stopped'
          ? '已停止'
          : status === 'completed'
            ? '已完成'
            : '暂无摘要';
  if (!raw?.trim()) return fallback;
  let t = raw.replace(/\r\n/g, '\n').trim();
  t = t
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => {
      if (!l) return false;
      if (/^mode=\w+/i.test(l)) return false;
      if (/turns=\d+.*tools=\d+/i.test(l)) return false;
      if (/Tools ran; model did not/i.test(l)) return false;
      if (/^No final text response/i.test(l)) return false;
      if (/upstream may have errored/i.test(l)) return false;
      return true;
    })
    .join('\n');
  t = t.replace(/^(.+?)\s+completed(?:\s*\([^)]*\))?\.?\s*/i, '');
  t = t.replace(/^(.+?)\s+failed:\s*/i, '');
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) return fallback;
  return t.length > 120 ? `${t.slice(0, 119)}…` : t;
}

export function assistantCopyText(msg: SessionMessage): string {
  const raw = (msg.text || '').trim();
  if (raw) return raw;
  return (msg.blocks || [])
    .filter((b) => b.type === 'text' && (b.content || '').trim())
    .map((b) => (b.content || '').trim())
    .join('\n\n');
}

export function extractImageRefs(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.matchAll(/!\[[^\]]*]\(([^)\s]+)\)/g)) if (m[1]) out.push(m[1]);
  for (const m of text.matchAll(
    /(?:^|[\s"'`])((?:[A-Za-z]:)?[\\/][^\s"'`]+\.(?:png|jpe?g|gif|webp|svg)|(?:\.\/|\/)[^\s"'`]+\.(?:png|jpe?g|gif|webp|svg))/gi,
  )) {
    if (m[1]) out.push(m[1]);
  }
  return [...new Set(out)].slice(0, 8);
}
