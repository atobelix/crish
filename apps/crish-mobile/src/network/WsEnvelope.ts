// DeviceEnvelope 帧类型（M5 §4.2 / D3 §5.3 / M6 §10.1）
// 协议真源 = crates/conex-types/contracts/device-protocol.json → 生成面
// packages/shared-types/src/generated/device（R0-03 产物，已入库）。本文件
// **禁止手抄第二套协议类型**：wire 类型全部引用生成面，仅以类型运算附加
// 本地入站形态（配对期 auth 可选，D3 §5.2 / mock-daemon envelope.ts 先例）。
// 生成面经相对路径引用（shared-types exports 仅暴露 "."，mock-daemon 同款做法）。

import type {
  DeviceEnvelope as ContractEnvelope,
  AuthHeader as ContractAuthHeader,
  Endpoint,
} from '../../../../packages/shared-types/src/generated/device/types';
import type { DeviceKind } from '../../../../packages/shared-types/src/generated/device/kinds';
import type { JsonValue } from '../../../../packages/shared-types/src/primitive-types';

/** 帧种类（生成面注册表 103 种 kind；新增 kind 经生成器自动跟进，本地不维护第二份清单） */
export type EnvelopeKind = DeviceKind;

/** 出站信封（生成面 DeviceEnvelope：v/kind/msgId/ts/from/to/auth/body 全必填） */
export type OutboundEnvelope = ContractEnvelope;

/**
 * 出站信封宽松形态（auth 可选：配对期帧无签名域 D3 §5.2；会话期由接线层
 * 经 signer 注入——R2-03 请求帧构建器接线点）。encodeFrame/decodeFrame
 * 以此为入参/出参基型（OutboundEnvelope 是其子型，可直接传入）。
 */
export type OutgoingEnvelope = Omit<ContractEnvelope, 'auth'> & {
  auth?: ContractAuthHeader;
};

/** 入站信封（组合：auth 可选化——配对期帧无签名域，D3 §5.2 配对期可选） */
export type InboundEnvelope = Omit<ContractEnvelope, 'auth'> & {
  auth?: ContractAuthHeader;
};

export type { ContractAuthHeader, ContractEnvelope, Endpoint, JsonValue };
