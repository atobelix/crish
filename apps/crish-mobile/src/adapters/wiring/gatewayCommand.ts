// 网关命令统一执行链（R4 批次6 自 filesRepository/quickRunWiring/runControlWiring
// 三处复制粘贴提炼）：invoke → 生成面解析 → 错误归一化。
//
// 错误归一化语义（各域 Error 类保持自有类型名与测试/VM 消费面不变）：
// - GatewayError（transport.closed / cmd.timeout / 服务端 error 帧）→ 透传 code/retryable 包装；
// - 响应解析失败 / 非 GatewayError 异常 → internal（不可重试）；
// - 解析失败在发送链之外处理（不与网络错误捕获竞争，无需 own-error 重抛判定）。
import { WsGateway, GatewayError } from '@/network/WsGateway';
import type { ParseResult } from '@crish/shared-types';

/** 未知错误兜底码（解析失败 / 非 GatewayError 异常；各域常量同值单一来源） */
export const GATEWAY_COMMAND_INTERNAL = 'internal';

/** 命令错误包装器（域错误类构造器的统一形状，如 new FilesCommandError(c, m, r)） */
export type CommandErrorWrapper<E extends Error> = (
  code: string,
  message: string,
  retryable: boolean
) => E;

/**
 * 统一执行链：gateway.invoke → parse → data；错误经 wrapError 归一化为域错误类。
 * parse 使用生成面解析器（M5 §1.3 不手写第二套字段校验），签名兼容 ParseResult<T>。
 */
export async function invokeCommand<T, E extends Error>(
  gateway: WsGateway,
  req: { kind: string; body: unknown },
  label: string,
  parse: (raw: unknown) => ParseResult<T>,
  wrapError: CommandErrorWrapper<E>
): Promise<T> {
  let raw: unknown;
  try {
    raw = await gateway.invoke(req.kind, req.body);
  } catch (e) {
    if (e instanceof GatewayError) {
      throw wrapError(e.code, e.message, e.retryable);
    }
    throw wrapError(
      GATEWAY_COMMAND_INTERNAL,
      e instanceof Error ? e.message : '未知错误',
      false
    );
  }
  const parsed = parse(raw);
  if (!parsed.ok) {
    throw wrapError(
      GATEWAY_COMMAND_INTERNAL,
      `响应解析失败（${label}）：${parsed.error}`,
      false
    );
  }
  return parsed.data;
}
