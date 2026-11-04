// 网关命令统一执行链（R4 批次6 自 filesRepository/quickRunWiring/runControlWiring
// 三处复制粘贴提炼）：invoke → 生成面解析 → 错误归一化。
//
// 错误归一化语义（各域 Error 类保持自有类型名与测试/VM 消费面不变）：
// - GatewayError（transport.closed / cmd.timeout / 服务端 error 帧）→ 透传 code/retryable 包装；
// - 响应解析失败 / 非 GatewayError 异常 → internal（不可重试）；
// - 解析失败在发送链之外处理（不与网络错误捕获竞争，无需 own-error 重抛判定）。
//
// 网关来源（H1 陈旧捕获根治）：第一参接受实例或解析函数——
// - 实例：测试 mock / 同代装配直注（仓储生命周期与网关同代，如 FeedBridge 的 monitor）；
// - 解析函数：生产命令域（六域 wiring 单例）传入 observationWiring 的当代
//   解析器，每次 invoke 现取当前代网关。命令域 context 单例跨接线换代存活，
//   若捕获装配时那一代 gateway，换代后其发送闭包指向已 disconnect 的 client、
//   帧被静默吞掉，无人 abort → 恰好满 10s 以 cmd.timeout 失败且进程内永不
//   自愈（模型/技能列表长期不可用的根因）；
// - 解析为 null（接线不存在 / 连接未 open）→ 立即以 transport.closed 快速
//   失败，绝不把帧发进虚空干等超时。
import { WsGateway, GatewayError } from '@/network/WsGateway';
import { createLogger } from '@/adapters/platform/logger';
import type { ParseResult } from '@crish/shared-types';

const log = createLogger('gatewayCommand');

/** 未知错误兜底码（解析失败 / 非 GatewayError 异常；各域常量同值单一来源） */
export const GATEWAY_COMMAND_INTERNAL = 'internal';

/** 无当代网关时的快速失败错误码（与 WsGateway 未接线 invoke 同码同文案口径） */
export const GATEWAY_NOT_CONNECTED_CODE = 'transport.closed';

/** 网关解析函数：调用时解析当代网关；无可用网关（未接线 / 未 open）→ null */
export type GatewayResolver = () => WsGateway | null;

/** 网关来源：实例直注或每次 invoke 现取的解析函数（见文件头 H1 口径） */
export type GatewaySource = WsGateway | GatewayResolver;

/** 命令错误包装器（域错误类构造器的统一形状，如 new FilesCommandError(c, m, r)） */
export type CommandErrorWrapper<E extends Error> = (
  code: string,
  message: string,
  retryable: boolean
) => E;

/**
 * 统一执行链：解析当代网关 → gateway.invoke → parse → data；错误经 wrapError
 * 归一化为域错误类。parse 使用生成面解析器（M5 §1.3 不手写第二套字段校验），
 * 签名兼容 ParseResult<T>。
 */
export async function invokeCommand<T, E extends Error>(
  source: GatewaySource,
  req: { kind: string; body: unknown },
  label: string,
  parse: (raw: unknown) => ParseResult<T>,
  wrapError: CommandErrorWrapper<E>,
  timeoutMs?: number
): Promise<T> {
  const gateway = typeof source === 'function' ? source() : source;
  if (!gateway) {
    // 无当代网关（接线已拆 / 连接未 open）：立即诚实失败，不发虚空帧
    throw wrapError(
      GATEWAY_NOT_CONNECTED_CODE,
      '连接未就绪，无法发送请求',
      true
    );
  }
  let raw: unknown;
  try {
    raw = await gateway.invoke(req.kind, req.body, timeoutMs);
  } catch (e) {
    if (e instanceof GatewayError) {
      if (e.code === 'cmd.timeout') {
        // 可观测性留痕：命令面超时此前全链路零日志，logcat 无从溯源（H1 教训）
        log.warn(`命令 invoke 超时（${label}）：${e.code} ${e.message}`);
      }
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
