import { createStore } from 'zustand/vanilla';
import { immer } from 'zustand/middleware/immer';

// 配对状态：与 D4 §4.4.1 authStore 对齐（unpaired | pairing | paired | token_expired）
export type PairState = 'unpaired' | 'pairing' | 'paired' | 'token_expired';

export interface AuthState {
  pairState: PairState;
  /** 水合完成标志：secure-store 读取完成前不跳转路由（D4 §5.0 SplashGate） */
  hydrated: boolean;
  deviceId: string | null;
  host: string | null;
  /** 启动水合：骨架期无真实读取；R2-03 接入 secure-store（令牌）与 kv-store（host） */
  hydrate: () => Promise<void>;
  markPaired: (meta: { deviceId: string; host: string }) => void;
  /** 令牌过期/吊销 → 引导重新配对（保留 SQLite 缓存数据，D4 §5.2） */
  markTokenExpired: () => void;
  /** 移除本机：清凭据回未配对态 */
  revokeLocal: () => void;
}

// 领域层 store（M4 §2.5 裁决修正 8）：vanilla createStore + immer，零 React 依赖
export const authStore = createStore<AuthState>()(
  immer((set) => ({
    pairState: 'unpaired',
    hydrated: false,
    deviceId: null,
    host: null,
    hydrate: async () => {
      // 骨架：无真实 secure-store 读取；R2-03 在此接入令牌水合
      set((s) => {
        s.hydrated = true;
      });
    },
    markPaired: (meta) =>
      set((s) => {
        s.pairState = 'paired';
        s.deviceId = meta.deviceId;
        s.host = meta.host;
      }),
    markTokenExpired: () =>
      set((s) => {
        s.pairState = 'token_expired';
      }),
    revokeLocal: () =>
      set((s) => {
        s.pairState = 'unpaired';
        s.deviceId = null;
        s.host = null;
      }),
  }))
);
