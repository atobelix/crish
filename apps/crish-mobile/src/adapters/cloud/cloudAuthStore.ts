// 云端账号 store（R4 批次4 自 domain/store 收编至 adapters/cloud）：
//
// 收编理由（R4 勘察 D-1）：原实现在 domain 层直接 new CloudAuthClient()（domain→network
// 反向依赖，全仓唯一分层违例），且 accessToken/refreshToken 明文进 store 状态面
// （违反 authStore「状态层不存明文」纪律）。收编后：
// - 归位 adapters/cloud（依赖方向：适配层 → 网络/领域，与 wiring 同层）；
// - 令牌明文只经模块内闭包流转（不进状态快照，不进 devtools/日志面）；
// - client 构造注入（configureCloudAuthClient；测试注入 fake，缺省真实客户端）；
// - 登录态为进程内会话级（重启需重登——与既有行为一致；持久化登录待
//   AC-account-center 方案落地后按令牌分治设计引入，不提前伪造）。
//
// 宗旨（沿承原注释）：「一切麻烦的东西在我们这，用户最好是点点就能完成的那种最好了」——
// 手机登录同一账号后自动发现在线电脑，为免扫码直连提供数据面。
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { immer } from 'zustand/middleware/immer';
import {
  CloudAuthClient,
  DEFAULT_AUTH_URL,
  type MobileCloudDevice,
  type MobileUserProfile,
} from '@/network/cloudAuthClient';

export interface CloudAuthState {
  isLoggedIn: boolean;
  user: MobileUserProfile | null;
  devices: MobileCloudDevice[];
  /** 最近活跃桌面端（platform 启发式判定；null = 未发现） */
  onlineDesktop: MobileCloudDevice | null;
  loading: boolean;
  error: string | null;

  login: (email: string, pass: string) => Promise<void>;
  logout: () => void;
  fetchDevices: () => Promise<void>;
  /** 申请访问在线桌面的中继票据（诚实上抛：服务端未实现时 404 错误原样外抛） */
  requestTicketForDesktop: () => Promise<{
    ticket: string;
    relayUrl: string;
    exp: number;
  }>;
  clearError: () => void;
}

/** 令牌闭包（状态面不存明文；模块内私有，随 logout/进程退出销毁） */
let accessToken: string | null = null;
let refreshToken: string | null = null;

/** 缺省客户端（可经 configureCloudAuthClient 注入 fake 覆盖；测试隔离用 null 复位） */
let defaultClient: CloudAuthClient = new CloudAuthClient();

/** 注入云端账号客户端（测试 fake / 特殊装配；传 null 复位缺省真实客户端） */
export function configureCloudAuthClient(client: CloudAuthClient | null): void {
  defaultClient = client ?? new CloudAuthClient();
}

function clientOf(): CloudAuthClient {
  return defaultClient;
}

/** 桌面端判定（platform 启发式：desktop/windows/macos/linux 命中优先，缺省取首台） */
export function pickOnlineDesktop(
  devices: readonly MobileCloudDevice[]
): MobileCloudDevice | null {
  const desktop = devices.find((d) => {
    const p = d.platform.toLowerCase();
    return (
      p.includes('desktop') ||
      p.includes('windows') ||
      p.includes('macos') ||
      p.includes('mac') ||
      p.includes('linux')
    );
  });
  return desktop ?? (devices.length > 0 ? devices[0]! : null);
}

function clearTokens(): void {
  accessToken = null;
  refreshToken = null;
}

export const cloudAuthStore: StoreApi<CloudAuthState> =
  createStore<CloudAuthState>()(
    immer((set) => ({
      isLoggedIn: false,
      user: null,
      devices: [],
      onlineDesktop: null,
      loading: false,
      error: null,

      login: async (email, pass) => {
        set((s) => {
          s.loading = true;
          s.error = null;
        });
        try {
          // 令牌只进闭包（不进状态面）；错误如实上抛（login 契约：缺字段 = 契约破坏报错）
          const result = await clientOf().login(email, pass);
          accessToken = result.accessToken;
          refreshToken = result.refreshToken;
          set((s) => {
            s.isLoggedIn = true;
            s.user = result.user;
            s.loading = false;
            s.error = null;
          });
        } catch (err: unknown) {
          clearTokens();
          const msg = err instanceof Error ? err.message : String(err);
          set((s) => {
            s.loading = false;
            s.error = msg;
          });
          throw err;
        }
      },

      logout: () => {
        clearTokens();
        set((s) => {
          s.isLoggedIn = false;
          s.user = null;
          s.devices = [];
          s.onlineDesktop = null;
          s.error = null;
        });
      },

      fetchDevices: async () => {
        if (accessToken === null) return;
        try {
          const devs = await clientOf().listDevices(accessToken);
          set((s) => {
            s.devices = devs;
            s.onlineDesktop = pickOnlineDesktop(devs);
          });
        } catch (err: unknown) {
          // 设备列表失败：留痕 error（登录后轮询/重进设置页可重试），不静默
          const msg = err instanceof Error ? err.message : String(err);
          set((s) => {
            s.error = msg;
          });
        }
      },

      requestTicketForDesktop: async () => {
        const desktop = cloudAuthStore.getState().onlineDesktop;
        if (accessToken === null || desktop === null) {
          throw new Error('未检测到可用的在线电脑（请先登录并确认桌面端在线）');
        }
        // 服务端未实现该路由（生产 404）→ 错误如实上抛，禁止伪造兜底（client 契约）
        return clientOf().getClientRelayTicket(accessToken, desktop.id);
      },

      clearError: () => {
        set((s) => {
          s.error = null;
        });
      },
    }))
  );

/** refreshToken 读取（令牌刷新面预留；无令牌返回 null） */
export function getCloudRefreshToken(): string | null {
  return refreshToken;
}

/** 云端账号订阅绑定（适配层唯一 React 入口；selector 经 useShallow 稳定引用） */
export const useCloudAuthStore = <T>(selector: (s: CloudAuthState) => T): T =>
  useStore(cloudAuthStore, useShallow(selector));

/** 登录服务地址（关于/诊断展示用；来自 client 常量单一真源） */
export { DEFAULT_AUTH_URL };
