// 客户端幂等 id 生成（D4 §12.3 utils/id.ts：msgId / requestId）
// 计数 + 时间基 + 随机段组合，保证进程内唯一且短小
let seq = 0;

export function nextId(prefix = 'id'): string {
  seq = (seq + 1) % 0xffffff;
  const timePart = Date.now().toString(36);
  const seqPart = seq.toString(36);
  const randPart = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${timePart}${seqPart}${randPart}`;
}
