// 本地回显块身份缓存（时间线身份专项登记项，U5 rider 落地）：
// 远端会话里用户刚发出、尚未被事件窗口确认的消息以 localPrompts
// 回显在时间线尾部。回显 prompt 一经追加即不可变，故按其 id 缓存
// 投影出的 TimelineBlock，text/atMs/status 未变时复用同一对象——流式期间
// entries 每次变化都会重跑时间线投影，若回显块每次重铸新对象，
// 可见行级的 memo 必然失效、整列重渲。
// R5：回显携带投递状态（受理即 pending，ACK 转 sent，失败转 failed 或撤除），
// 状态变化视为身份变化（缓存重铸，行级更新呈现状态提示）。
import type { TimelineBlock } from '@/presentation/timeline/buildTimeline';

/** 回显 prompt（远端引擎的本地发送回显条目） */
export interface LocalPromptEcho {
  id: string;
  text: string;
  atMs: number;
  /** 投递状态：pending = 已受理待 ACK；sent = 仓储已受理（真 runId 已关联）；failed = 发送失败待重发 */
  status: 'pending' | 'sent' | 'failed';
}

export function createLocalPromptEchoCache(): (
  prompt: LocalPromptEcho
) => TimelineBlock {
  const cache = new Map<
    string,
    { text: string; atMs: number; status: LocalPromptEcho['status']; block: TimelineBlock }
  >();
  return (prompt) => {
    const hit = cache.get(prompt.id);
    if (
      hit &&
      hit.text === prompt.text &&
      hit.atMs === prompt.atMs &&
      hit.status === prompt.status
    ) {
      return hit.block;
    }
    const block: TimelineBlock = {
      kind: 'message',
      id: prompt.id,
      role: 'user',
      text: prompt.text,
      streaming: false,
      atMs: prompt.atMs,
      ...(prompt.status !== 'sent'
        ? { delivery: prompt.status }
        : {}),
    };
    cache.set(prompt.id, {
      text: prompt.text,
      atMs: prompt.atMs,
      status: prompt.status,
      block,
    });
    return block;
  };
}
