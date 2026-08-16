/**
 * 会话事件「信封解包」纯函数（T3：前端消息类型单源化 · D1/D7）。
 *
 * 职责：只做「信封 type/event 抽取」——把 orchestrator / daemon 会话事件信封
 * 收敛为内层事件对象，交给权威解析面 `parseBridgeEvent`。
 * 解包 ≠ 解析：本模块不读取任何 message / block / tool 字段内容。
 *
 * 两种信封形态（与 live 桥同协议语义，禁止只认一种导致重放丢工具卡）：
 * 1. `{ type:'runtime-event', payload:{ event:{...} } }` —— 嵌套信封；
 * 2. 顶层摊平的 `message*` / `tool*` 事件直通。
 *
 * 与 `resolveEventType`（eventParser.ts:89-97，type/event/kind 别名）语义合并：
 * 「信封 type 抽取」这一个小职责统一在 chat-bridge 域；本函数拿内层 event，
 * 内层 event 本身再交 `parseBridgeEvent` 走生成解析器（strict → 宽容归一）。
 */
import { isRecord } from './eventParserShared';

export type EnvelopeUnpackResult = { event: unknown } | null;

/**
 * 从会话事件信封中解出「内层事件对象」。
 * - runtime-event 嵌套：优先 `payload.event`，兜底 `payload` / 顶层 `event`；解析失败返回 null。
 * - 顶层摊平 message* / tool*：原样返回。
 * - 其余（run 级 / 未知 / 空）返回 null（调用方据此跳过，不当作解析路径）。
 */
export function unwrapOrchestratorEnvelope(ev: unknown): EnvelopeUnpackResult {
  if (!isRecord(ev)) return null;
  if (ev.type === 'runtime-event') {
    const payload = isRecord(ev.payload) ? ev.payload : ev;
    const nested = isRecord(payload.event)
      ? payload.event
      : isRecord(ev.event)
        ? ev.event
        : null;
    if (!nested) return null;
    return { event: nested };
  }
  // 顶层摊平：message* / tool* 事件（live 桥与 daemon 回放同协议形态；
  // 只放行 message* 会导致会话恢复丢工具卡 —— tool-start/tool-end 被当 run 级事件跳过）
  const t = String(ev.type ?? '').trim();
  if (t.startsWith('message') || t.startsWith('tool')) return { event: ev };
  return null;
}
