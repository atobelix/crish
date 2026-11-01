// 会话导出 Markdown 拼装（G3；移动端本地实现——数据源 = C03
// readSessionEvents 分页回读的原始事件帧，不新增宿主命令）。
//
// 拼装口径（格式自洽，与桌面会话导出的「正文 + 工具摘要」同向）：
// - 标题 = 会话名（空缺回退「未命名会话」）；
// - 正文按事件时序：message-end 终态帧 → 「## 用户」/「## 助手」段，
//   正文取 message.blocks 中 text 块拼接（段落间空行），无 blocks 时
//   回退 message.content；流式 message-delta 是 message-end 的增量前
//   影，不重复计入；
// - 工具摘要：tool-start → 「- 工具：{toolName}」行；tool-end → 结果
//   首个非空行（剥 ANSI、截断 200 字符）作缩进续行；
// - 其余事件（run/agent 生命周期、审批、tool-update 进度）不进导出——
//   它们不是会话正文，不猜不编。
import type { JsonValue } from '@crish/shared-types';
import { readRecord, readString } from '@/domain/store/eventReducers';
import { stripAnsi } from './ansi';

/** 工具结果摘要单行上限（超出截断 + …） */
export const EXPORT_TOOL_OUTPUT_MAX = 200;

/** message-end 正文提取（导出全量版：段落拼接，不做预览式单行收敛） */
function messageText(frame: Record<string, unknown>): string {
  const message = readRecord(frame['message']);
  if (!message) return readString(frame, 'content') ?? '';
  const blocks = message['blocks'];
  if (Array.isArray(blocks)) {
    const parts: string[] = [];
    for (const block of blocks) {
      const b = readRecord(block);
      if (b && b['type'] === 'text') {
        const t = b['text'];
        if (typeof t === 'string' && t.trim() !== '') parts.push(t.trim());
      }
    }
    if (parts.length > 0) return parts.join('\n\n');
  }
  return readString(message, 'content') ?? readString(frame, 'content') ?? '';
}

/** 事件序列 → Markdown 文档（事件须已按 sequence 时序排列） */
export function buildSessionMarkdown(
  title: string | null | undefined,
  events: readonly JsonValue[]
): string {
  const heading = title?.trim() || '未命名会话';
  const sections: string[] = [`# ${heading}`];
  for (const raw of events) {
    const frame = readRecord(raw);
    if (!frame) continue;
    switch (frame['type']) {
      case 'message-end': {
        const message = readRecord(frame['message']);
        const role = message ? readString(message, 'role') : undefined;
        if (role !== 'user' && role !== 'assistant') break;
        const text = stripAnsi(messageText(frame)).trim();
        if (!text) break;
        sections.push(`## ${role === 'user' ? '用户' : '助手'}\n\n${text}`);
        break;
      }
      case 'tool-start': {
        const name = readString(frame, 'toolName') ?? '未知工具';
        sections.push(`- 工具：${name}`);
        break;
      }
      case 'tool-end': {
        const result = readRecord(frame['result']);
        const output = result ? readString(result, 'output') : undefined;
        const line = output
          ?.split('\n')
          .map((x) => x.trim())
          .find((x) => x !== '');
        if (line) {
          const cleaned = stripAnsi(line);
          const clipped =
            cleaned.length > EXPORT_TOOL_OUTPUT_MAX
              ? `${cleaned.slice(0, EXPORT_TOOL_OUTPUT_MAX)}…`
              : cleaned;
          sections.push(`  - 结果：${clipped}`);
        }
        break;
      }
      default:
        break;
    }
  }
  return `${sections.join('\n\n')}\n`;
}
