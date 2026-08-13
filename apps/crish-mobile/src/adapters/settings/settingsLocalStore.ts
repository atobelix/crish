// 设置页本机偏好（R2-06 部分 3 接线；通知偏好 + 文件缩略图开关）：
//
// - 通知偏好：审批通知/事件通知场景级开关（F6 §10.1；「所有通知偏好存本机，
//   不写回桌面」F6 §10.3；D7 §4.3 静默/偏好本地判定）；默认开（F6 §10.2 默认值：
//   审批请求默认开——审批不能漏，D7 §3.3 S1）；
// - 文件：缩略图仅 Wi-Fi 加载开关（R2UX-06-03，默认开——省移动流量）；
// - 存储面：适配层 vanilla store（内存态，模块单例）；持久化 seam 注记——
//   R2-14b settingsStore（notify/appearance 分片，F6 §4.2）落地后迁入 domain，
//   经 settingsDao（src/db/dao/settingsDao.ts 键值表）持久化；本层对外接口
//   （useSettingsLocalStore / setPreference / LOCAL_PREFERENCE_* 常量）保持兼容，
//   文件浏览缩略图消费侧（files 域 R2UX-06-03 联动）届时订阅同一数据面。
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { createStore } from 'zustand/vanilla';
import { immer } from 'zustand/middleware/immer';

/** 本机偏好键（F6 §4.2 notify/appearance 分片子集，本轮落地三项） */
export type LocalPreferenceKey =
  'approvalNotifications' | 'eventNotifications' | 'thumbnailWifiOnly';

/** 默认值（审批/事件通知默认开，F6 §10.2；缩略图仅 Wi-Fi 默认开，R2UX-06-03） */
export const LOCAL_PREFERENCE_DEFAULTS: Record<LocalPreferenceKey, boolean> = {
  approvalNotifications: true,
  eventNotifications: true,
  thumbnailWifiOnly: true,
};

/** 展示元数据（label/description/testID 单一真源，页面与测试共用） */
export interface LocalPreferenceMeta {
  label: string;
  description: string;
  testID: string;
}

export const LOCAL_PREFERENCE_META: Record<
  LocalPreferenceKey,
  LocalPreferenceMeta
> = {
  approvalNotifications: {
    label: '审批通知',
    description: '桌面工具执行待确认时提醒（F6 §10.1）',
    testID: 'setting-approval-notifications',
  },
  eventNotifications: {
    label: '事件通知',
    description: '任务完成 / 异常等事件提醒（F6 §10.1）',
    testID: 'setting-event-notifications',
  },
  thumbnailWifiOnly: {
    label: '缩略图仅 Wi-Fi 加载',
    description: '移动网络下不加载缩略图，节省流量（R2UX-06-03）',
    testID: 'setting-thumbnail-wifi',
  },
};

interface SettingsLocalState {
  prefs: Record<LocalPreferenceKey, boolean>;
  /** 更新单项偏好（upsert 语义；R2-14b 迁入 settingsStore 后动作面不变） */
  setPreference: (key: LocalPreferenceKey, value: boolean) => void;
}

/** 本机偏好存储（适配层单例；R2-14b 迁入 settingsStore 前为内存态） */
export const settingsLocalStore = createStore<SettingsLocalState>()(
  immer((set) => ({
    prefs: { ...LOCAL_PREFERENCE_DEFAULTS },
    setPreference: (key, value) =>
      set((s) => {
        s.prefs[key] = value;
      }),
  }))
);

/** 本机偏好订阅绑定（对齐 useAppStore 模式；selector 经 useShallow 稳定引用） */
export const useSettingsLocalStore = <T>(
  selector: (s: SettingsLocalState) => T
): T => useStore(settingsLocalStore, useShallow(selector));

/** 测试隔离：本机偏好复位（仅测试调用） */
export function resetSettingsLocalStoreForTest(): void {
  settingsLocalStore.setState({ prefs: { ...LOCAL_PREFERENCE_DEFAULTS } });
}
