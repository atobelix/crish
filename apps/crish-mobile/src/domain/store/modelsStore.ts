// modelsStore（M2 模型面共享 store）：桌面全局默认模型的手机侧投影——
// 可选列表 + 当前全局默认 + 拉取/切换状态，单一真源。此前模型状态是每个
// 屏幕各自挂载的 useComposerContextVm 的本地 useState：在会话页切换模型后
// 仍挂载的主页实例不更新、显示旧选中态（审计 A.3-3）；提升为共享 store 后
// 主页与会话页订阅同一份，一处切换、处处一致。纯逻辑在 modelsReducers.ts
// （jest 直测），本文件只做一行转发 + 状态装配（M5 §3.1 reducers 纪律）。
import { createStore, type StoreApi } from 'zustand/vanilla';
import { immer } from 'zustand/middleware/immer';
import type { ActiveModelInfo, ModelEntry } from '@crish/shared-types';
import {
  applyModelSwitched,
  applyModelSwitchFailed,
  applyModelsLoaded,
  applyModelsLoadFailed,
  beginModelSwitch,
  beginModelsLoad,
  createModelsData,
  endModelSwitch,
  type ModelsData,
} from './modelsReducers';

export interface ModelsState extends ModelsData {
  /** 拉取开始（无列表 → loading；有列表静默重拉 → 呈现不动） */
  markLoadStarted: () => void;
  /** 拉取成功（列表 + 全局默认整体替换 + 打点数据龄） */
  markLoaded: (
    models: readonly ModelEntry[],
    activeModel: ActiveModelInfo | null,
    nowMs?: number
  ) => void;
  /** 拉取失败（无列表 → error 态 + 错误码；有列表 → 静默保留） */
  markLoadFailed: (code: string) => void;
  /** 切换开始 */
  markSwitchStarted: () => void;
  /** 切换收尾（成败共用） */
  markSwitchEnded: () => void;
  /** 切换成功（以服务端回传为准：默认替换 + 列表对号翻转 + 数据龄刷新） */
  markSwitched: (activeModel: ActiveModelInfo, nowMs?: number) => void;
  /** 切换失败（现状不漂移，仅落错误码） */
  markSwitchFailed: (code: string) => void;
  /** 连接断开 / 换机：整面复位（旧连接的模型投影不带入新连接，设备分区纪律） */
  reset: () => void;
}

function nowDefault(): number {
  return Date.now();
}

// 显式 StoreApi 标注（对齐 sessionStore：immer 中间件组合链推断类型引用外部
// draft 类型无法在导出声明中命名，公共面以 StoreApi<ModelsState> 收敛）
export const modelsStore: StoreApi<ModelsState> = createStore<ModelsState>()(
  immer((set) => ({
    ...createModelsData(),

    markLoadStarted: () =>
      set((s) => {
        Object.assign(s, beginModelsLoad(s));
      }),

    markLoaded: (models, activeModel, nowMs = nowDefault()) =>
      set((s) => {
        Object.assign(s, applyModelsLoaded(s, models, activeModel, nowMs));
      }),

    markLoadFailed: (code) =>
      set((s) => {
        Object.assign(s, applyModelsLoadFailed(s, code));
      }),

    markSwitchStarted: () =>
      set((s) => {
        Object.assign(s, beginModelSwitch(s));
      }),

    markSwitchEnded: () =>
      set((s) => {
        Object.assign(s, endModelSwitch(s));
      }),

    markSwitched: (activeModel, nowMs = nowDefault()) =>
      set((s) => {
        Object.assign(s, applyModelSwitched(s, activeModel, nowMs));
      }),

    markSwitchFailed: (code) =>
      set((s) => {
        Object.assign(s, applyModelSwitchFailed(s, code));
      }),

    reset: () =>
      set((s) => {
        Object.assign(s, createModelsData());
      }),
  }))
);
