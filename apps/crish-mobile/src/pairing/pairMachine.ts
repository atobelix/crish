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
// 密钥协商接线（R2-03 部分 2，D3 §4.4）：
// - submitCode 注入 generateKeys → sending-hello 前生成一次性对 + 长期对，
//   公钥经 base64 wire 形态注入 pair.hello（mobilePub/mobileLongPub）；
// - onHelloAck 注入 remotePub（pair.challenge.desktopPub）存入 state；
// - onPairOk 注入 deriveKeys（接线层经 crypto/derivePairingKeys +
//   noblePrimitives 提供）→ paired 前派生 token_key/enc_key/refresh_key，
//   产出 state.sessionKeys —— 连接层 signer 注入点（signer.ts
//   SignContext.tokenKey，接线层持久化后构造签名器）。
//
// 纯 reducer 纪律：本模块无任何副作用；协议构造/解析函数均为纯计算，
// generateKeys/deriveKeys 由事件注入（接线层提供，reducer 仅调用），
// 帧发送与令牌持久化等 IO 由接线层（WsGateway.invoke / secure-store）承担。

import type { PairHello, Platform } from '@crish/shared-types';
import { buildPairHello } from './pairProtocol';
import type { PairErrorInfo, PairOkResult } from './pairProtocol';
import { normalizePairCode } from '@/domain/pure/cxnCode';
import { base64Encode } from './crypto/keyAgreement';
import type { PairKeyMaterial, PairingTokenSet } from './crypto/keyAgreement';
import type { LocalKeys } from './crypto/primitives';

/** 状态机状态（对齐桌面端 naming；paired 为终态） */
export type PairState =
  | 'idle'
  | 'waiting-input'
  | 'sending-hello'
  | 'waiting-verify'
  | 'paired'
  | 'error'
  | 'locked';

/**
 * 密钥派生注入（R2-03 部分 2 接线点）：给定密钥协商材料全集返回三子钥。
 * 接线层注入 `(m) => derivePairingKeys(m, noblePrimitives)`（crypto/
 * keyAgreement.ts + noblePrimitives.ts）；reducer 只调用注入函数保持纯
 * reducer 纪律（与 buildPairHello 同风格的依赖注入面）。
 */
export type PairKeyDeriver = (material: PairKeyMaterial) => PairingTokenSet;

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
      /**
       * 密钥对生成注入（R2-03 部分 2 接线点）：sending-hello 前生成
       * 一次性对 + 长期对（D3 §4.4 第 1 步）。缺省不生成（hello 的
       * mobilePub/mobileLongPub 为空串，兼容旧行为）。
       */
      generateKeys?: () => LocalKeys;
    }
  | {
      type: 'onHelloAck';
      /**
       * 桌面 X25519 长期公钥（base64，pair.challenge.desktopPub；
       * R2-03 部分 2 接线点，onHelloAck 存 remotePub 供派生）。
       */
      remotePub?: string;
    }
  | {
      type: 'onPairOk';
      desktopId: string;
      ttl: number;
      token: string;
      /**
       * 桌面证书指纹（D3 §4.6 可选扩展：pair.ok 载荷 tlsFingerprint；
       * 透传到 result 供接线层收口持久化——当前桌面不下发则省略）。
       */
      tlsFingerprint?: string;
      /**
       * 密钥派生注入（R2-03 部分 2 接线点）：paired 前派生 token_key
       * 输出给连接层（signer.ts SignContext.tokenKey 注入点——接线层
       * 把 sessionKeys 持久化后构造签名器）。缺省不派生（旧行为）。
       */
      deriveKeys?: PairKeyDeriver;
    }
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
  /** 本地密钥对（一次性 + 长期，D3 §4.4 第 1 步；submitCode 时生成） */
  localKeys: LocalKeys | null;
  /** 桌面长期公钥（base64，pair.challenge.desktopPub；onHelloAck 存入） */
  pendingRemotePub: string | null;
  /** 配对派生三子钥（paired 前产出；连接层 signer 注入点，见事件注释） */
  sessionKeys: PairingTokenSet | null;
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
  localKeys: null,
  pendingRemotePub: null,
  sessionKeys: null,
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
      // R2-03 部分 2：sending-hello 前生成密钥对（一次性 + 长期），公钥经
      // base64 wire 形态注入 pair.hello（mobilePub/mobileLongPub）
      const localKeys = event.generateKeys ? event.generateKeys() : null;
      const hello = buildPairHello({
        code: normalized.data,
        deviceId: event.deviceId,
        deviceName: event.deviceName,
        platform: event.platform,
        mobilePub: localKeys
          ? base64Encode(localKeys.ephemeral.publicKey)
          : undefined,
        mobileLongPub: localKeys
          ? base64Encode(localKeys.longTerm.publicKey)
          : undefined,
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
        localKeys,
      };
    }
    case 'onHelloAck': {
      if (state.state !== 'sending-hello') break;
      // R2-03 部分 2：桌面公钥（pair.challenge.desktopPub）随 ack 存入，
      // 供 onPairOk 派生 token_key
      return {
        ...state,
        state: 'waiting-verify',
        changed: true,
        pendingRemotePub: event.remotePub ?? null,
      };
    }
    case 'onPairOk': {
      if (state.state !== 'waiting-verify') break;
      const result: PairOkResult = {
        desktopId: event.desktopId,
        ttl: event.ttl,
        token: event.token,
        ...(event.tlsFingerprint !== undefined
          ? { tlsFingerprint: event.tlsFingerprint }
          : {}),
      };
      if (event.deriveKeys) {
        // R2-03 部分 2：paired 前派生 token_key（密钥材料 = 本地密钥对 +
        // 桌面公钥 + 配对上下文）；材料缺失或派生失败 → error（本地错误，
        // 可重试——与 onPairError 相同的失败计数/重试语义）
        if (
          !state.localKeys ||
          !state.pendingRemotePub ||
          !state.pendingHello
        ) {
          return {
            ...state,
            state: 'error',
            changed: true,
            error: {
              kind: 'unknown',
              code: 'pair.key_material_missing',
              message: '密钥协商材料不完整（缺少本地密钥或桌面公钥）',
              retryable: true,
            },
            failedAttempts: state.failedAttempts + 1,
          };
        }
        try {
          const sessionKeys = event.deriveKeys({
            code: state.lastCode ?? '',
            desktopId: event.desktopId,
            mobilePub: state.pendingHello.mobilePub,
            mobileLongPub: state.pendingHello.mobileLongPub,
            remotePub: state.pendingRemotePub,
            localKeys: state.localKeys,
          });
          return {
            ...state,
            state: 'paired',
            changed: true,
            error: null,
            failedAttempts: 0,
            result,
            sessionKeys,
          };
        } catch (e) {
          return {
            ...state,
            state: 'error',
            changed: true,
            error: {
              kind: 'unknown',
              code: 'pair.key_agreement_failed',
              message: e instanceof Error ? e.message : '密钥派生失败',
              retryable: true,
            },
            failedAttempts: state.failedAttempts + 1,
          };
        }
      }
      // 未注入派生（旧行为兼容：配对完成但不产 token_key——连接层会因
      // sessionKeys 为 null 走未配对分支）
      return {
        ...state,
        state: 'paired',
        changed: true,
        error: null,
        failedAttempts: 0,
        result,
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
