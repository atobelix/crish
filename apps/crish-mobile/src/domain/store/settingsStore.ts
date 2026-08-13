// settingsStore（R2-14 第三波）：设置键值数据面（领域层 store）
// - 纯逻辑在 settingsReducers.ts（jest 直测），本文件只做一行转发 + 状态装配
//   （M5 §3.1 reducers 纪律）；分组与字段按 F6 规格（通用/通知/文件/外观）；
// - 数据面关系（接线注记，不重复造轮子）：
//   · 持久化 = kv-store（settings 表，M5 §3.6：persist 到 kv-store；mirror 分片排除——
//     本波四组均为本机偏好，镜像分片（permissionMode/usageSummary 等）不在本波，见
//     F6 §4.2 mirror「仅内存缓存，不持久化」）；真实实现 = SqlSettingsDao（R2-13），
//     wiring 层经 configureSettingsPersistence() 注入；测试按参数注入 fake；
//   · hydrate：启动时读 kv 全量回填（缺字段用默认值合并，M5 §7.1 步骤 3
//     settingsStore.hydrate）；读取失败不阻塞启动（保持默认值 + hydrated=true）；
//   · set/update：内存立即生效 + 经注入持久化接口异步写 kv（失败静默——本机偏好
//     写入失败不阻断交互，接线层可重试/上报）；get 返回当前分组快照；
//   · 双向同步项（回答风格/遥测开关）经 F6 §8.3 桌面确认通道由接线层编排，store 只
//     持本机值（pending 标记后续轮次）。
import { createStore, type StoreApi } from 'zustand/vanilla';
import { immer } from 'zustand/middleware/immer';
import {
  decodeSettingsGroup,
  defaultSettingsGroups,
  encodeSettingsGroup,
  mergeSettingsGroup,
  settingsGroupKey,
  type DeepPartial,
  type SettingsGroupName,
  type SettingsGroups,
} from './settingsReducers';

/** 持久化接口（kv-store 注入面；真实实现 = SqlSettingsDao，R2-13） */
export interface SettingsPersist {
  /** 读值（不存在返回 null） */
  get(key: string): Promise<string | null>;
  /** 写值（upsert：同 key 覆盖） */
  set(key: string, value: string): Promise<void>;
  /** 全部键值（hydrate 回填用） */
  getAll(): Promise<ReadonlyArray<{ key: string; value: string }>>;
}

export interface SettingsState {
  /** 四组设置（通用/通知/文件/外观；缺省值见 defaultSettingsGroups） */
  groups: SettingsGroups;
  /** 水合完成标志（kv 回填完成前组件显示默认值即可，不阻塞启动） */
  hydrated: boolean;

  /**
   * 启动水合：读 kv 全量回填（每组 JSON 解码 + 与默认值深合并，防缺字段）。
   * 读取/解析失败的分组保持默认值；persist 缺省走 configureSettingsPersistence 注入。
   */
  hydrate: (persist?: SettingsPersist) => Promise<void>;
  /** 读分组快照（类型安全：K 限定 SettingsGroupName，返回值随分组映射） */
  get: <K extends SettingsGroupName>(group: K) => SettingsGroups[K];
  /** 整组替换（内存立即生效 + 异步写 kv；persist 缺省走注入） */
  set: <K extends SettingsGroupName>(
    group: K,
    value: SettingsGroups[K],
    persist?: SettingsPersist
  ) => void;
  /** 局部合并（patch 覆盖提及字段，未提及保留；嵌套组可单字段补丁） */
  update: <K extends SettingsGroupName>(
    group: K,
    patch: DeepPartial<SettingsGroups[K]>,
    persist?: SettingsPersist
  ) => void;
}

/** 默认持久化实现（接线层启动时注入一次；测试按参数注入优先，同 authStore 模式） */
let defaultPersist: SettingsPersist | null = null;

/** 接线层注入默认持久化（SqlSettingsDao 组装实现见 SettingsPersist 注释；传 null 复位） */
export function configureSettingsPersistence(
  persist: SettingsPersist | null
): void {
  defaultPersist = persist;
}

function persistOf(persist?: SettingsPersist): SettingsPersist | null {
  return persist ?? defaultPersist;
}

/** 异步写 kv（失败静默：本机偏好写入失败不阻断交互；接线层可重试） */
function writeGroup(
  group: SettingsGroupName,
  value: unknown,
  persist?: SettingsPersist
): void {
  const p = persistOf(persist);
  if (!p) return;
  void p.set(settingsGroupKey(group), encodeSettingsGroup(value)).catch(() => {
    // 写入失败静默（本机偏好尽力持久化；不抛到交互路径）
  });
}

// 显式 StoreApi 标注（对齐 approvalStore：immer 中间件组合链推断类型引用外部 draft
// 类型无法在导出声明中命名，公共面以 StoreApi<SettingsState> 收敛）
export const settingsStore: StoreApi<SettingsState> =
  createStore<SettingsState>()(
    immer((set, get) => ({
      groups: defaultSettingsGroups(),
      hydrated: false,

      hydrate: async (persist) => {
        const p = persistOf(persist);
        if (!p) {
          set((s) => {
            s.hydrated = true;
          });
          return;
        }
        let rows: ReadonlyArray<{ key: string; value: string }> = [];
        try {
          rows = await p.getAll();
        } catch {
          // 读取失败不阻塞启动（M5 §7.1：保持默认值，hydrated 置位）
          set((s) => {
            s.hydrated = true;
          });
          return;
        }
        set((s) => {
          const defaults = defaultSettingsGroups();
          for (const group of Object.keys(defaults) as SettingsGroupName[]) {
            const raw = rows.find(
              (r) => r.key === settingsGroupKey(group)
            )?.value;
            if (raw === undefined) continue;
            const decoded = decodeSettingsGroup(raw);
            if (decoded === null || typeof decoded !== 'object') continue;
            // immer draft 泛型索引赋值收敛（同 set/update 手法）
            (s.groups as Record<string, unknown>)[group] = mergeSettingsGroup(
              defaults[group] as object,
              decoded as object
            );
          }
          s.hydrated = true;
        });
      },

      get: (group) => get().groups[group],

      set: (group, value, persist) => {
        set((s) => {
          // immer draft 泛型索引赋值收敛：分组键已在编译期校验，运行期字符串索引安全
          (s.groups as Record<string, unknown>)[group] = value;
        });
        writeGroup(group, value, persist);
      },

      update: (group, patch, persist) => {
        set((s) => {
          (s.groups as Record<string, unknown>)[group] = mergeSettingsGroup(
            s.groups[group] as object,
            patch as object
          ) as SettingsGroups[typeof group];
        });
        writeGroup(group, get().groups[group], persist);
      },
    }))
  );
