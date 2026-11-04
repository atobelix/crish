// modelsStore 纯逻辑 reducers（M5 §3.1：集合更新纯函数，store 动作只转发，jest 直测）
// 覆盖：模型列表拉取四态（idle/loading/loaded/error）、当前全局默认、切换标记、
// 错误码、数据龄（loadedAtMs）与超龄判定（M2 拉取制度化的数据面）。
import type { ActiveModelInfo, ModelEntry } from '@crish/shared-types';

/** 模型列表拉取状态（与 Composer 既有四态口径一致） */
export type ModelsStatus = 'idle' | 'loading' | 'loaded' | 'error';

/** 模型面数据（store 状态的数据部分；动作转发见 modelsStore） */
export interface ModelsData {
  /** 可选模型列表（未拉取为 null；桌面统一模型树投影，C38） */
  models: readonly ModelEntry[] | null;
  /** 拉取状态四态 */
  status: ModelsStatus;
  /** 当前全局默认（桌面真源投影；未设置/未拉取为 null） */
  activeModel: ActiveModelInfo | null;
  /** 切换（C39）进行中标记 */
  switching: boolean;
  /**
   * 最近一次需用户感知的命令错误码：无列表时的拉取失败（error 态呈现）
   * 与切换失败共用——与 M2 前 VM 的 modelsError 单槽语义一致。有列表时
   * 的后台重拉失败不写此槽（数据保留、下次打开仍判超龄重试，不打扰呈现）。
   */
  error: string | null;
  /** 最近一次列表成功拉取时刻 ms（未成功过 = null；超龄判定数据面） */
  loadedAtMs: number | null;
}

/**
 * 模型数据保鲜期 ms（M2 拉取制度化）：Sheet 打开时数据龄超过此值即静默重拉。
 * 桌面改全局默认没有任何推送通道到手机（审计 A.3-3），只能靠打开 Sheet 时的
 * 龄检收敛；30s 是「桌面刚改完、切回手机打开 Sheet 大概率已超龄」与「短时间
 * 反复打开不反复打命令面」之间的取舍。
 */
export const MODELS_STALE_MS = 30_000;

export function createModelsData(): ModelsData {
  return {
    models: null,
    status: 'idle',
    activeModel: null,
    switching: false,
    error: null,
    loadedAtMs: null,
  };
}

/**
 * 拉取开始：无列表 → loading 呈现；已有列表（超龄静默重拉）→ 呈现原样不动
 * （列表不闪烁、不回退加载态），成败由后续 apply 决定。
 */
export function beginModelsLoad(data: ModelsData): ModelsData {
  if (data.models !== null) return data;
  if (data.status === 'loading') return data;
  return { ...data, status: 'loading' };
}

/** 拉取成功：列表 + 全局默认 + 拉取时刻整体替换，错误清零 */
export function applyModelsLoaded(
  data: ModelsData,
  models: readonly ModelEntry[],
  activeModel: ActiveModelInfo | null,
  nowMs: number
): ModelsData {
  return {
    ...data,
    models,
    status: 'loaded',
    activeModel,
    error: null,
    loadedAtMs: nowMs,
  };
}

/**
 * 拉取失败：无列表 → error 态 + 错误码（Sheet 失败面呈现并可重试）；
 * 有列表（后台静默重拉失败）→ 数据原样保留（loadedAtMs 不动，下次打开
 * 仍判超龄重试），不写 error、不打扰正在看的列表。
 */
export function applyModelsLoadFailed(
  data: ModelsData,
  code: string
): ModelsData {
  if (data.models !== null) return data;
  return { ...data, status: 'error', error: code };
}

/** 切换开始（switching 标记置位） */
export function beginModelSwitch(data: ModelsData): ModelsData {
  return data.switching ? data : { ...data, switching: true };
}

/** 切换收尾（成败路径共用：switching 标记清除） */
export function endModelSwitch(data: ModelsData): ModelsData {
  return data.switching ? { ...data, switching: false } : data;
}

/**
 * 切换成功：以服务端回传的全局默认为准——activeModel 替换、列表 active
 * 标记翻转、错误清零、数据龄刷新（刚切换完即最新，不必立刻重拉）。
 */
export function applyModelSwitched(
  data: ModelsData,
  activeModel: ActiveModelInfo,
  nowMs: number
): ModelsData {
  return {
    ...data,
    activeModel,
    models: data.models
      ? data.models.map((m) => ({
          ...m,
          active:
            m.providerId === activeModel.providerId &&
            m.modelId === activeModel.modelId,
        }))
      : data.models,
    error: null,
    loadedAtMs: nowMs,
  };
}

/** 切换失败：现状不漂移（标签与对号不动），仅落错误码供 Sheet 呈现 */
export function applyModelSwitchFailed(
  data: ModelsData,
  code: string
): ModelsData {
  return { ...data, error: code };
}

/** 数据龄 ms（从未成功拉取 → Infinity，恒判超龄） */
export function modelsAgeMs(data: ModelsData, nowMs: number): number {
  if (data.loadedAtMs === null) return Number.POSITIVE_INFINITY;
  return Math.max(0, nowMs - data.loadedAtMs);
}

/** 是否超龄（Sheet 打开时的静默重拉判据；从未拉取 = 超龄） */
export function isModelsStale(data: ModelsData, nowMs: number): boolean {
  return modelsAgeMs(data, nowMs) > MODELS_STALE_MS;
}

/**
 * 当前全局默认是否在可选集内（M3 注脚判据）：宿主会如实回传已停用/已删除的
 * activeModel（可选集不含它）——此时 Sheet 无一行选中，需注脚说明而非静默。
 * 未设置默认（activeModel=null）→ false（走「未设默认」独立态，不用本注脚）。
 */
export function isActiveModelSelectable(data: ModelsData): boolean {
  const active = data.activeModel;
  if (!active || data.models === null) return false;
  return data.models.some(
    (m) => m.providerId === active.providerId && m.modelId === active.modelId
  );
}
