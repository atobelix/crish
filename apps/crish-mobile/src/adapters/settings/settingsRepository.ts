// 设置域命令仓库（R2-06 设置接线；settingsCommands B5 批命令面）：
//
// 职责（对齐 M5 §1.2 repository 组合纪律：仓库 = 命令构造 + 网络发送 + 响应解析）：
// - 命令发送唯一入口：getSettings（C28 设置镜像拉取）/ setSettings（C29 非安全
//   设置变更，key 白名单恒 3 键 responseStyle/enableAnalytics/enableCrashTelemetry，
//   M6 §4.5.2；其余键桌面端 settings.key_denied 拒绝）/ queryPresence（C32 桌面
//   在场查询，「关于」页桌面连接信息数据面）；
// - 响应解析复用 settingsCommands.parseSettingsCommandResult（生成面解析器，
//   M5 §1.3 组合纪律：不手写第二套字段校验），解析失败 → SettingsCommandError；
// - 错误归一化：GatewayError（transport.closed / cmd.timeout / 服务端 error 帧）
//   → SettingsCommandError{code, message, retryable}（对齐 filesRepository 先例）；
// - 注入模式：gateway 实例构造注入（测试 mock；生产 = observationWiring 单例网关，
//   经 settingsWiring.getSettingsContext 装配，filesWiring 同风格）。
//
// 接线注记（R2-14b）：settingsStore 落地后，本机偏好（通知/外观/缩略图）由
// settingsStore 分片承载（F6 §4.2），本仓库保持「桌面设置镜像/同步」命令面职责，
// 读侧给 getSettings 镜像（F6 §3.2 只读参考），写侧给 setSettings 白名单键同步。

import { WsGateway, GatewayError } from '@/network/WsGateway';
import {
  buildGetSettingsRequest,
  buildQueryPresenceRequest,
  buildSetSettingsRequest,
  parseSettingsCommandResult,
} from '@/domain/repositories/settingsCommands';
import type {
  SettingsCommandName,
  SettingsCommandRequest,
  SettingsCommandResultMap,
} from '@/domain/repositories/settingsCommands';
import type {
  GetSettingsParams,
  GetSettingsResult,
  PresenceResult,
  SetSettingsParams,
  SetSettingsResult,
} from '../../../../../packages/shared-types/src/generated/device/types';

// ── 错误类型 ──────────────────────────────────────────────────────────────

/** 设置域命令错误（code = 协议错误码 / 本地映射码，F4 附录 B 同款 UI 层映射） */
export class SettingsCommandError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = 'SettingsCommandError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** 未知错误兜底码（解析失败 / 非 GatewayError 异常） */
export const SETTINGS_ERROR_INTERNAL = 'internal';

// ── 仓库接口（注入 mock 面；VM/接线层只依赖接口不依赖实现） ────────────────

export interface SettingsRepository {
  /** C28 设置镜像拉取（keys 白名单子集可选；apiKey 脱敏由桌面端保证） */
  getSettings(params?: GetSettingsParams): Promise<GetSettingsResult>;
  /** C29 非安全设置变更（key 白名单恒 3 键；两态响应 applied/pending，M6 §4.5.2） */
  setSettings(params: SetSettingsParams): Promise<SetSettingsResult>;
  /** C32 桌面在场查询（「关于」桌面连接信息 + 版本号数据面） */
  queryPresence(): Promise<PresenceResult>;
}

// ── 网关实现 ──────────────────────────────────────────────────────────────

/** 经 WsGateway.invoke 发送设置命令并解析响应（注入 gateway，测试可注入假网关） */
export class GatewaySettingsRepository implements SettingsRepository {
  constructor(private readonly gateway: WsGateway) {}

  getSettings(params?: GetSettingsParams): Promise<GetSettingsResult> {
    return this.invoke('getSettings', buildGetSettingsRequest(params));
  }

  setSettings(params: SetSettingsParams): Promise<SetSettingsResult> {
    return this.invoke('setSettings', buildSetSettingsRequest(params));
  }

  queryPresence(): Promise<PresenceResult> {
    return this.invoke('queryPresence', buildQueryPresenceRequest());
  }

  /** 统一执行链：invoke → 生成面解析 → 错误归一化（解析失败/未知异常 → internal） */
  private async invoke<T extends SettingsCommandName>(
    command: T,
    req: SettingsCommandRequest
  ): Promise<SettingsCommandResultMap[T]> {
    try {
      const raw: unknown = await this.gateway.invoke(req.kind, req.body);
      const parsed = parseSettingsCommandResult(command, raw);
      if (!parsed.ok) {
        throw new SettingsCommandError(
          SETTINGS_ERROR_INTERNAL,
          `响应解析失败（${command}）：${parsed.error}`,
          false
        );
      }
      return parsed.data;
    } catch (e) {
      if (e instanceof SettingsCommandError) throw e;
      if (e instanceof GatewayError) {
        throw new SettingsCommandError(e.code, e.message, e.retryable);
      }
      throw new SettingsCommandError(
        SETTINGS_ERROR_INTERNAL,
        e instanceof Error ? e.message : '未知错误',
        false
      );
    }
  }
}
