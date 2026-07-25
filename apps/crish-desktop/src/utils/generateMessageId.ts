/**
 * 消息 ID 生成器。
 *
 * 格式: {role}-{Date.now().toString(36)}-{crypto.randomUUID().slice(0,8)}-{counter}
 * counter 为单调递增 16 位计数器（0-65535），同帧多次调用时递增消除毫秒级碰撞。
 */

let _counter = 0;

/**
 * 生成全局唯一的消息 ID。
 *
 * @param role 消息发送方角色
 * @returns 格式化的消息 ID
 */
export function generateMessageId(role: 'user' | 'assistant' | 'tool'): string {
  const ts = Date.now().toString(36);
  const rand = crypto.randomUUID().slice(0, 8);
  const seq = nextLocalSeq();
  return `${role}-msg-${ts}-${rand}-${seq.toString(16).padStart(4, '0')}`;
}

/**
 * 内部单调计数器，0-65535 循环。
 * 同一帧内多次调用时每次递增，确保相同毫秒内的 ID 唯一性。
 */
function nextLocalSeq(): number {
  const current = _counter;
  _counter = (_counter + 1) & 0xFFFF;
  return current;
}

/**
 * 重置计数器（测试用）。
 */
export function resetCounter(): void {
  _counter = 0;
}
