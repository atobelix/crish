// 配对流程状态机（R2-03 深化）：D3 §4.2 移动端状态机 + 桌面端状态命名对齐
//
// 状态序列对齐桌面端（pairing.rs status：idle/waiting-input/key-verify/...）：
//   idle → waiting-input → sending-hello → waiting-verify → paired
//                       （失败）→ error →（retry）→ waiting-input
//                       （失败次数达上限）→ locked →（reset）→ idle
//
// 与协议层的接线（任务书动作表）：
// - submitCode：normalizePairCode 校验 CXN 格式 → buildPairHello 构造 hello
//   （两者均为纯函数，直接引用即注入；无 IO 副作用）→ 进入 sending-hello；
//   换码（与上次提交的码不同）重置失败计数——本地镜像「单码失败上限」
//   （D3 §4.3 PAIR_MAX_ATTEMPTS = 5，服务端为权威计数，本地仅防无谓重试）；
// - onHelloAck：hello 被桌面接受（简化链 hello→ok 直接完成，pair_endpoint.rs），
//   完整链下对应 pair.challenge 到达；→ waiting-verify；
// - onPairOk：ok 帧解析结果（含 token 明文）存入 result → paired；
//   实际持久化（secure-store 写入）由接线层完成，reducer 只存状态；
// - onPairError：PairErrorInfo 映射错误码 → error（计数 +1，可重试）或
//   locked（too-many-attempts 或本地计数达上限，需 reset 重新开启配对）；
// - retry：error → waiting-input（保留计数与错误展示，用户可改码重提交）；
// - reset：locked/error 等非终态 → idle（清空全部）；paired 为终态拒绝一切。
//
// 纯 reducer 纪律：本模块无任何副作用；协议构造/解析函数均为纯计算，
// 帧发送与令牌持久化等 IO 由接线层（WsGateway.invoke / secure-store）承担。

import type {
  PairHello,
  Platform,
} from '../../../../packages/shared-types/src/generated/device/types';
import { buildPairHello } from './pairProtocol';
import type { PairErrorInfo, PairOkResult } from './pairProtocol';
import { normalizePairCode } from './cxnCode';

/** 状态机状态（对齐桌面端 naming；paired 为终态） */
export type PairState =
  | 'idle'
  | 'waiting-input'
  | 'sending-hello'
  | 'waiting-verify'
  | 'paired'
  | 'error'
  | 'locked';

/** 状态机事件（R2-03 动作表：submitCode/onHelloAck/onPairOk/onPairError/retry/reset） */
export type PairEvent =
  | { type: 'begin' }
  | {
      type: 'submitCode';
      /** 用户输入配对码（容错：大小写/前缀/分隔符，reducer 内标准化） */
      code: string;
      /** 设备 id（接线层生成或注入；缺省由 buildPairHello 自动生成） */
      deviceId?: string;
      /** 设备名（≤64） */
      deviceName: string;
      /** 端平台（可选） */
      platform?: Platform;
      /** X25519 一次性公钥（密钥协商接线点注入，R2-03 未覆盖项） */
      mobilePub?: string;
      /** 移动长期公钥（同上注入） */
      mobileLongPub?: string;
    }
  | { type: 'onHelloAck' }
  | { type: 'onPairOk'; desktopId: string; ttl: number; token: string }
  | { type: 'onPairError'; error: PairErrorInfo }
  | { type: 'retry' }
  | { type: 'reset' };

/** 状态机状态数据（含与协议层的接线产物） */
export interface PairMachineState {
  /** 当前状态 */
  state: PairState;
  /** 是否发生状态/数据变化（非法事件 → false，调用方可忽略） */
  changed: boolean;
  /** submitCode 本地格式校验错误（非法码提示；不消耗服务端失败次数） */
  inputError: string | null;
  /** 最近构造的 pair.hello 帧（接线层取出发送） */
  pendingHello: PairHello | null;
  /** 最近一次提交的标准化 12 位码（换码时重置失败计数） */
  lastCode: string | null;
  /** 本地镜像的失败计数（D3 §4.3 单码上限 5；服务端为权威） */
  failedAttempts: number;
  /** 最近一次配对错误（error/locked 态展示） */
  error: PairErrorInfo | null;
  /** 配对成功结果（含 token 明文，接线层负责持久化） */
  result: PairOkResult | null;
}

/** 初始状态（idle） */
export const PAIR_INITIAL_STATE: PairMachineState = {
  state: 'idle',
  changed: false,
  inputError: null,
  pendingHello: null,
  lastCode: null,
  failedAttempts: 0,
  error: null,
  result: null,
};

/** 单码失败上限（D3 §4.3 PAIR_MAX_ATTEMPTS = 5，与服务端一致） */
export const PAIR_MAX_ATTEMPTS = 5;

/** 派生：失败是否已达上限（超出重试边界 → locked） */
function isLockedAfter(failedAttempts: number): boolean {
  return failedAttempts >= PAIR_MAX_ATTEMPTS;
}

/**
 * 纯 reducer：state + event → 新状态。非法转换返回原状态（changed=false）。
 * 依赖注入面：normalizePairCode / buildPairHello 均为纯函数（协议层调用
 * 注入），帧发送与持久化等副作用在本模块之外。
 */
export function reducePairState(
  state: PairMachineState,
  event: PairEvent
): PairMachineState {
  switch (event.type) {
    case 'begin': {
      if (state.state !== 'idle') break;
      return { ...PAIR_INITIAL_STATE, state: 'waiting-input', changed: true };
    }
    case 'submitCode': {
      if (state.state !== 'waiting-input') break;
      const normalized = normalizePairCode(event.code);
      if (!normalized.ok) {
        // 本地格式校验失败：不消耗服务端失败次数，停留等待输入
        return { ...state, changed: true, inputError: normalized.error };
      }
      const hello = buildPairHello({
        code: normalized.data,
        deviceId: event.deviceId,
        deviceName: event.deviceName,
        platform: event.platform,
        mobilePub: event.mobilePub,
        mobileLongPub: event.mobileLongPub,
      });
      if (!hello.ok) {
        return { ...state, changed: true, inputError: hello.error };
      }
      // 换码（与上次提交不同）→ 本地失败计数重置（新码 = 新会话语义）
      const failedAttempts =
        state.lastCode === normalized.data ? state.failedAttempts : 0;
      return {
        ...state,
        state: 'sending-hello',
        changed: true,
        inputError: null,
        pendingHello: hello.data,
        lastCode: normalized.data,
        failedAttempts,
        error: null,
      };
    }
    case 'onHelloAck': {
      if (state.state !== 'sending-hello') break;
      return { ...state, state: 'waiting-verify', changed: true };
    }
    case 'onPairOk': {
      if (state.state !== 'waiting-verify') break;
      return {
        ...state,
        state: 'paired',
        changed: true,
        error: null,
        failedAttempts: 0,
        result: {
          desktopId: event.desktopId,
          ttl: event.ttl,
          token: event.token,
        },
      };
    }
    case 'onPairError': {
      if (state.state !== 'sending-hello' && state.state !== 'waiting-verify')
        break;
      const info = event.error;
      const failedAttempts = state.failedAttempts + 1;
      // 服务端已锁定（pair.too_many_attempts）或本地计数达上限 → locked
      if (info.kind === 'too-many-attempts' || isLockedAfter(failedAttempts)) {
        return {
          ...state,
          state: 'locked',
          changed: true,
          error: info,
          failedAttempts,
        };
      }
      return {
        ...state,
        state: 'error',
        changed: true,
        error: info,
        failedAttempts,
      };
    }
    case 'retry': {
      if (state.state !== 'error') break;
      // 回等待输入：保留失败计数（同码继续累计）与错误展示（提示用户改码）
      return {
        ...state,
        state: 'waiting-input',
        changed: true,
        inputError: null,
      };
    }
    case 'reset': {
      if (state.state === 'idle' || state.state === 'paired') break;
      return { ...PAIR_INITIAL_STATE, changed: true };
    }
  }
  // 非法转换：保留全部字段，仅标记本次未变化（对齐骨架 changed=false 语义）
  return { ...state, changed: false };
}
