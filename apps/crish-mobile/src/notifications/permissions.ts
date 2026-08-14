// 通知权限封装 + 状态管理（R3-04）：Android 13+ POST_NOTIFICATIONS / iOS 通知
// - getPermissionsAsync 查询、requestPermissionsAsync 请求（Android 13+ 系统弹窗、
//   iOS 首请 alert/badge/sound），统一折叠为三态 undetermined/granted/denied
//   （D7 §7.5：iOS PROVISIONAL/EPHEMERAL 亦计入 granted，横幅可展示；拒绝引导
//   openNotificationSettingsAsync 属 UI 层职责，本层不引 UI）；
// - 顺序铁律（D7 §7.5 / M8 §4.2.3）：请求前先建渠道——系统弹窗依赖至少一个已存在
//   渠道，request() 内部自保证（幂等），调用方无需感知；
// - 引导时机（D7 §7.5）：配对完成后/首次 P0 推送前由 UI 层调 request()；
//   本层 init 只 refresh 不弹窗（不打扰冷启动）。
import { createStore } from 'zustand/vanilla';
import {
  getPermissionsAsync,
  requestPermissionsAsync,
} from 'expo-notifications';
import { registerChannelsAsync } from './channels';

/** 权限三态（UI 引导/开关数据面；对齐 expo PermissionStatus 折叠） */
export type NotificationPermissionStatus =
  'undetermined' | 'granted' | 'denied';

export interface NotificationPermissionState {
  /** 当前权限三态（初始 undetermined = 未查询） */
  status: NotificationPermissionStatus;
  /** 是否已查询过（false 时 UI 不展示引导卡，避免误导，R2UX 诚实化纪律） */
  checked: boolean;
  /** 查询中标志（UI 可展示轻量加载） */
  refreshing: boolean;
  /** 测试/接线用：直接置位（如用户从系统设置返回后回读） */
  setStatus: (status: NotificationPermissionStatus) => void;
  /** 查询当前权限（不弹窗；失败回退 undetermined 不阻塞） */
  refresh: () => Promise<NotificationPermissionStatus>;
  /** 请求权限（已授权则静默返回；未授权 → 先建渠道再弹系统框） */
  request: () => Promise<NotificationPermissionStatus>;
}

/** 权限响应结构子集（expo NotificationPermissionsStatus 的结构兼容面；测试免枚举构造） */
export interface PermissionStatusLike {
  status: string;
  granted: boolean;
}

/** 权限响应 → 三态折叠（granted 布尔为最终裁决） */
export function mapPermissionStatus(
  perms: PermissionStatusLike
): NotificationPermissionStatus {
  if (perms.granted) return 'granted';
  if (perms.status === 'denied') return 'denied';
  return 'undetermined';
}

export const notificationPermissionStore =
  createStore<NotificationPermissionState>()((set) => ({
    status: 'undetermined',
    checked: false,
    refreshing: false,

    setStatus: (status) => set({ status, checked: true }),

    refresh: async () => {
      set({ refreshing: true });
      try {
        const perms = await getPermissionsAsync();
        const status = mapPermissionStatus(perms);
        set({ status, checked: true, refreshing: false });
        return status;
      } catch {
        // 原生模块不可用（Web/模拟器边界）→ 不阻塞启动，回退未查询态
        set({ refreshing: false });
        return 'undetermined';
      }
    },

    request: async () => {
      const current = await getPermissionsAsync();
      if (current.granted) {
        const status = mapPermissionStatus(current);
        set({ status, checked: true });
        return status;
      }
      // 顺序铁律（D7 §7.5）：渠道先建（幂等）再请求——否则 Android 13+ 弹窗不出现
      await registerChannelsAsync();
      const perms = await requestPermissionsAsync();
      const status = mapPermissionStatus(perms);
      set({ status, checked: true });
      return status;
    },
  }));
