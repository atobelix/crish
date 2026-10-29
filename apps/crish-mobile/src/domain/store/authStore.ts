// authStore（M5 §3.1.1 / D4 §4.4.1 / D4 §5.2）：配对状态 + 令牌生命周期（领域层 store）
// 纯逻辑在 authReducers.ts（jest 直测），本文件只做状态装配与一行转发（M5 §3.1 reducers 纪律）
//
// 数据面关系（接线注记）：
// - 密钥材料（token_key/refresh_key/设备密钥对）**不落本 store**——secure-store 持有
//   （src/db/secureStore.ts，R2-13 已交付）。本 store 只记录「密钥材料存在性」
//   hasKeyMaterial；密钥明文仅经注入的持久化接口流转，状态层不存明文；
// - 持久化经注入的 AuthPersist 接口：真实实现由接线层（R2-03，adapters/wiring）用
//   secureStore.loadPairingCredential / savePairingCredential / clearPairing 组装后
//   经 configureAuthPersistence() 一次性注入；测试直接按参数注入 fake（持久化接口注入）；
// - hydrate 完成前不跳转路由（D4 §5.0 SplashGate；M5 §7.1 启动状态机步骤 2）。
import { createStore } from 'zustand/vanilla';
import { immer } from 'zustand/middleware/immer';
import type { PairingCredential } from '../../db/secureStore';
import { transitionPairState } from './authReducers';

// 配对状态：与 D4 §4.4.1 authStore 对齐（unpaired | pairing | paired | token_expired）
export type PairState = 'unpaired' | 'pairing' | 'paired' | 'token_expired';

/** 配对流程阶段（D3 §4.2 移动端状态机摘要；UI 表单/流程展示用） */
export type PairingStage = 'entered' | 'verifying' | 'failed' | 'succeeded';

/** 配对流程元数据（host/port/code 输入状态 + 流程阶段，任务书 pairingMeta） */
export interface PairingMeta {
  /** 桌面主机（IP/域名；resolveWsUrl 消费，D4 §6.3） */
  host: string;
  /** 网关端口（裁决 P-1：8765） */
  port: number;
  /** 配对码（CXN-XXXX-XXXX-XXXX 标准化前原文，D3 §4.1） */
  code: string;
  /** 流程阶段 */
  stage: PairingStage;
}

/** 令牌元数据（D4 §5.2：访问令牌 24h / refresh 30 天；明文在 secure-store） */
export interface TokenMeta {
  /** 是否持有令牌材料（token_key/refresh_key） */
  hasToken: boolean;
  /** 令牌签发时刻 ms（pair.ok ttl 语义；null = 未知） */
  issuedAt: number | null;
  /** 令牌有效时长 ms（null = 未知/长期） */
  ttlMs: number | null;
}

/** 配对身份元数据（onPaired / hydrate 注入；非敏感，SQLite device_meta 同源，M5 §5.2） */
export interface AuthIdentityMeta {
  /** 本机设备 id（移动端生成 UUID，D3 §4.5） */
  deviceId: string;
  /** 桌面 Hub id（pair.ok 返回，D3 §4.8） */
  desktopId: string;
  /** 桌面连接主机（wss://host:8765 的 host 段，observationWiring 消费） */
  host: string;
  /** 桌面网关端口（自定义端口冷启动恢复） */
  port?: number;
}

/**
 * 持久化接口（secure-store 注入面，M5 §6.3）：
 * 接线层组装：load → secureStore.loadPairingCredential(driver)；
 * save → secureStore.savePairingCredential(driver, cred)；
 * clear → secureStore.clearPairing(driver)。
 * 本 store 零 db 运行时依赖（M5 §2.3 状态层不得 import 存储层实现，仅 import type）。
 */
export interface AuthPersist {
  /** 读配对凭据（核心 4 密钥位缺一 → null，不部分恢复，M5 §6.3 注意 4） */
  load(): Promise<PairingCredential | null>;
  /** 写配对凭据（配对成功才落库，M5 §6.2） */
  save(cred: PairingCredential): Promise<void>;
  /** 清空配对凭据（全清 pair.* 与 device.keypair.*，M5 §6.2 移除本机语义） */
  clear(): Promise<void>;
}

export interface AuthState {
  pairState: PairState;
  /** 水合完成标志：secure-store 读取完成前不跳转路由（D4 §5.0 SplashGate） */
  hydrated: boolean;
  deviceId: string | null;
  desktopId: string | null;
  /** 桌面连接主机（未配对 = null；observationWiring 据此决定是否启动连接） */
  host: string | null;
  /** 桌面网关端口（未配对 = null；缺省 8765） */
  port: number | null;
  /** 配对流程元数据（host/port/code/阶段）；null = 未在进行配对 */
  pairingMeta: PairingMeta | null;
  /** 令牌元数据（hasToken/issuedAt/ttl；密钥明文在 secure-store） */
  token: TokenMeta;
  /** 密钥材料存在性（secure-store 核心 4 密钥位齐备；不存密钥明文） */
  hasKeyMaterial: boolean;

  /**
   * 启动水合（M5 §7.1 步骤 2）：经注入持久化读取配对凭据——
   * 有完整凭据 → 'paired' + hasKeyMaterial=true；无凭据/读取失败 → 'unpaired'（不阻塞启动）。
   * persist 缺省走 configureAuthPersistence 注入的默认实现；meta 提供时回填身份字段
   * （接线层从 SQLite device_meta 读取；「有凭据但 desktopId 与 device_meta 不一致 →
   * unpaired」的脏数据兜底由接线层比较后处理，M5 §7.1 步骤 2 注）。
   */
  hydrate: (persist?: AuthPersist, meta?: AuthIdentityMeta) => Promise<void>;
  /** 配对状态转移（经 transitionPairState 合法性校验；非法转移保持原状态） */
  setPairState: (state: PairState) => void;
  /** 配对流程元数据更新（partial 合并；host/port/code/stage 增量写，首次写缺省 8765 端口） */
  setPairingMeta: (meta: Partial<PairingMeta>) => void;
  /**
   * 配对成功收口（pair.ok 已收，D3 §4.8）：
   * - 可选注入 persist + 完整凭据 → 先写 secure-store（注记：配对完成前不落库，M5 §6.2；
   *   写入失败 → 状态不变并上抛，由接线层捕获引导重试）；
   * - 状态面：pairState='paired' + 身份/令牌元数据 + hasKeyMaterial=true
   *   （不变量：paired ⟹ hasKeyMaterial；令牌 hasToken 恒 true）。
   */
  onPaired: (
    meta: AuthIdentityMeta,
    token: Omit<TokenMeta, 'hasToken'>,
    opts?: { persist?: AuthPersist; cred?: PairingCredential }
  ) => Promise<void>;
  /**
   * 解除配对（被动事件：auth.revoked / auth.unknown_desktop / 刷新失败，M5 §6.2）：
   * 状态面 → unpaired + 身份/令牌/密钥存在性清空；persist 提供时尽力清 secure-store
   * （清除失败不阻断状态复位，M5 §6.2「无论成败」）。SQLite 业务缓存保留（D4 §5.2）。
   */
  onUnpaired: (persist?: AuthPersist) => Promise<void>;
  /**
   * 清除本地配对状态（主动：用户「移除本机」/ 重新配对前重置）：
   * 纯内存动作——secure-store 清理由接线层先行调用 secureStore.clearPairing(driver)
   * （移除本机语义：无论桌面撤销成败都全清，M5 §6.2），再触发本动作复位内存态。
   */
  clearPairing: () => void;
  /** 令牌过期/吊销（刷新失败，M5 §4.3.5）→ 引导重新配对（保留 SQLite 缓存，D4 §5.2）；
   *  仅 paired 可进入（经转移表校验），身份/令牌元数据保留供重新配对预填。 */
  markTokenExpired: () => void;
}

function emptyToken(): TokenMeta {
  return { hasToken: false, issuedAt: null, ttlMs: null };
}

/** 默认持久化实现（接线层启动时注入一次；测试按参数注入优先） */
let defaultPersist: AuthPersist | null = null;

/** 接线层注入默认持久化（secure-store 组装实现见 AuthPersist 注释；传 null 复位） */
export function configureAuthPersistence(persist: AuthPersist | null): void {
  defaultPersist = persist;
}

function persistOf(persist?: AuthPersist): AuthPersist | null {
  return persist ?? defaultPersist;
}

/** immer draft 就地清理（clearPairing / onUnpaired 共用复位面） */
function resetPairingState(s: AuthState): void {
  s.pairState = 'unpaired';
  s.deviceId = null;
  s.desktopId = null;
  s.host = null;
  s.port = null;
  s.pairingMeta = null;
  s.token = emptyToken();
  s.hasKeyMaterial = false;
}

// 领域层 store（M4 §2.5 裁决修正 8）：vanilla createStore + immer，零 React 依赖
export const authStore = createStore<AuthState>()(
  immer((set) => ({
    pairState: 'unpaired',
    hydrated: false,
    deviceId: null,
    desktopId: null,
    host: null,
    port: null,
    pairingMeta: null,
    token: emptyToken(),
    hasKeyMaterial: false,

    hydrate: async (persist, meta) => {
      const p = persistOf(persist);
      let hasKeys = false;
      let pairState: PairState = 'unpaired';
      if (p) {
        try {
          const cred = await p.load();
          if (cred) {
            hasKeys = true;
            pairState = 'paired';
          }
        } catch {
          // 读取失败 → 视为未配对（M5 §7.1：secure-store 读取失败不阻塞启动，走配对引导）
          hasKeys = false;
          pairState = 'unpaired';
        }
      }
      set((s) => {
        s.pairState = pairState;
        s.hasKeyMaterial = hasKeys;
        s.hydrated = true;
        if (meta && pairState === 'paired') {
          s.deviceId = meta.deviceId;
          s.desktopId = meta.desktopId;
          s.host = meta.host;
          s.port = meta.port ?? null;
        }
      });
    },

    setPairState: (state) =>
      set((s) => {
        s.pairState = transitionPairState(s.pairState, state);
      }),

    setPairingMeta: (meta) =>
      set((s) => {
        if (!s.pairingMeta) {
          // 首次写入：缺省值（端口 8765 = 裁决 P-1），stage 缺省 entered
          s.pairingMeta = {
            host: meta.host ?? '',
            port: meta.port ?? 8765,
            code: meta.code ?? '',
            stage: meta.stage ?? 'entered',
          };
          return;
        }
        if (meta.host !== undefined) s.pairingMeta.host = meta.host;
        if (meta.port !== undefined) s.pairingMeta.port = meta.port;
        if (meta.code !== undefined) s.pairingMeta.code = meta.code;
        if (meta.stage !== undefined) s.pairingMeta.stage = meta.stage;
      }),

    onPaired: async (meta, token, opts) => {
      const p = opts?.persist ?? defaultPersist;
      if (opts?.cred && p) {
        // 写入 secure-store 注记：配对完成前不落库（M5 §6.2）；
        // 写入失败 → 状态不变 + 上抛（接线层捕获，引导重新落库/重试）
        await p.save(opts.cred);
      }
      set((s) => {
        s.pairState = 'paired';
        s.deviceId = meta.deviceId;
        s.desktopId = meta.desktopId;
        s.host = meta.host;
        s.port = meta.port ?? null;
        // 配对成功 = 令牌材料落库 → hasToken 恒 true（D4 §5.2 令牌生命周期起点）
        s.token = {
          hasToken: true,
          issuedAt: token.issuedAt,
          ttlMs: token.ttlMs,
        };
        s.hasKeyMaterial = true;
        if (s.pairingMeta) s.pairingMeta.stage = 'succeeded';
      });
    },

    onUnpaired: async (persist) => {
      const p = persistOf(persist);
      if (p) {
        try {
          await p.clear();
        } catch {
          // 清除失败不阻断状态复位（M5 §6.2「无论成败」）
        }
      }
      set((s) => {
        resetPairingState(s);
      });
    },

    clearPairing: () =>
      set((s) => {
        resetPairingState(s);
      }),

    markTokenExpired: () =>
      set((s) => {
        s.pairState = transitionPairState(s.pairState, 'token_expired');
      }),
  }))
);
