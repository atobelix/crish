# Task-A 状态机底座与内存缓存实施方案

> **文档标识**：`docs/model-capability/plans/01-Task-A-状态机底座与内存缓存实施方案.md`  
> **制定时间**：2026-09-03  
> **责任角色**：Task-A 状态机与性能底座工程师  
> **独立物理文件域**：  
> • `apps/crish-desktop/src/api/modelCatalogMeta.ts`（核心改造）  
> • `apps/crish-desktop/src/api/modelCatalogMeta.test.ts`（全新单测）  
> • `apps/crish-desktop/src/api/uiEvents.ts`（事件契约前置增补，5 行）  
> **执行标准**：开箱即用，代码完整精确，执行 Agent 可直接据此编码与落盘，绝无盲目猜测。

---

## 一、 背景痛点与审计裁决回顾

在前期方案审查与红蓝审计（参考 [`docs/model-capability/plan-reviews/06-状态机与单源契约深度审计.md`](file:///c:/Software/conex/docs/model-capability/plan-reviews/06-%E7%8A%B6%E6%80%81%E6%9C%BA%E4%B8%8E%E5%85%A8%E6%BA%90%E5%A5%91%E7%BA%A6%E6%B7%B1%E5%BA%A6%E5%AE%A1%E8%AE%A1.md)）中，指出了系统在模型元数据读写层的两项核心技术隐患：

1. **SEC-03 性能灾难：$O(N \cdot M)$ 同步反序列化风暴（The JSON.parse Blizzard）**：
   - 既有 `modelCatalogMeta.ts` 的 `loadMap()` 每次执行均裸调 `localStorage.getItem('crish_model_meta_v1')` 与 `JSON.parse(raw)`。
   - 在前端引入 `metaTick` 响应式心跳与级联下拉过滤（`ModelsCascadeSelect`、`ModelBadgePickerMenu`、`ModelList`）后，单次用户点击 Switch 会在单帧内产生 **670 次** 以上的 `getModelMeta` 密集调用；叠加双重触发问题，调用量激增至 **1,340 次**。
   - 每次反序列化 60KB 的 JSON 字符串约耗时 0.15ms，累计引发 **>200ms 的主线程严重同步阻塞**，导致明显的掉帧、UI 卡死与输入延迟。
2. **状态写入失步：缺乏原子事件广播**：
   - `setModelEnabled` 等修改操作仅更新了 LocalStorage，未向全站 UI 事件总线派发通知，依赖粗粒度的组件重拉或失步，导致顶栏徽标、级联菜单无法实时获知模型启停状态。
3. **缺少独立单元测试资产**：
   - 既有仓库中仅有 `modelCatalog.test.ts`，未为元数据存储层设立独立的单测套件，缺乏性能压测与跨窗口边界防护。

---

## 二、 内存镜像缓存架构设计（MemoryMetaCache Architecture）

### 2.1 架构拓扑与内存镜像生命周期

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    modelCatalogMeta.ts 内存镜像数据流拓扑                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  [调用方：getModelMeta / formatModelDisplayName]                            │
│                         │                                                   │
│                         ▼ (1. 优先读取)                                     │
│          ┌─────────────────────────────┐                                    │
│          │  memoryMetaCache (内存单例) │ ◄────────┐                         │
│          └─────────────────────────────┘          │ (写穿透同步)            │
│                 │ (命中: <0.2ms)                  │                         │
│                 │                                 │                         │
│                 ▼ (未命中/冷启动时)               │                         │
│          ┌─────────────────────────────┐          │                         │
│          │    loadMap() 同步反序列化   │          │                         │
│          └─────────────────────────────┘          │                         │
│                         │                         │                         │
│                         ▼                         │                         │
│          ┌─────────────────────────────┐          │                         │
│          │   LocalStorage 持久化存储   │ ─────────┘                         │
│          └─────────────────────────────┘                                    │
│                         ▲                                                   │
│                         │                                                   │
│  [跨标签/多窗口 StorageEvent] ─── (key 匹配) ──▶ 标记 memoryMetaCache = null │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 性能数学模型与耗时量化对比

设系统启用的服务商数 $P = 15$，平均每服务商模型数 $M = 20$，全系统 $N = 300$ 个模型，LocalStorage JSON 体积为 $60 \text{ KB}$。单次操作触发 670 次 `getModelMeta`：

| 方案 | 单次读取机制 | 670 次累计耗时 | 主线程阻塞（60Hz 帧率） | 评级 |
| :--- | :--- | :--- | :--- | :--- |
| **重构前** | 裸调 `localStorage.getItem` + `JSON.parse` | $\approx \mathbf{201 \text{ ms}}$ | 阻塞 **>12 帧**（长任务警告） | 致命性能隐患 |
| **重构后（Task-A）** | 内存单例 `memoryMetaCache[k]` 直读（$O(1)$） | $\mathbf{< 0.2 \text{ ms}}$ | 占用 **0.01 帧**（丝滑零延迟） | **提升 1,000 倍** |

### 2.3 缓存失效与跨窗口一致性（Multi-Window StorageEvent）

1. **同进程写穿透（Write-Through）**：
   - 任何写操作（`upsertModelMeta`）在写入 LocalStorage 的同时，立即将最新的 `map` 赋予 `memoryMetaCache`，实现同进程内绝对实时的强一致性。
2. **跨窗口/跨标签页事件监听**：
   - 在具备 `window` 环境下注册 `storage` 事件监听：
     ```typescript
     if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
       window.addEventListener('storage', (e: StorageEvent) => {
         if (e.key === META_KEY) {
           memoryMetaCache = null; // 外部修改时标记过期，下一次读取重新反序列化
         }
       });
     }
     ```
3. **测试重置接口**：
   - 导出 `resetModelMetaCache(): void`，使单元测试 `beforeEach` 能够安全重置状态，杜绝测试用例间的数据污染。

---

## 三、 事件总线广播契约（uiEvents 'model-meta-changed'）

### 3.1 载荷契约定义

在 `apps/crish-desktop/src/api/uiEvents.ts` 的 `UiEventMap` 中新增 `'model-meta-changed'` 事件：

```typescript
export type UiEventMap = {
  // ... 既有事件
  /** 活动服务商/模型已切换（设置页或底栏 Picker） */
  'model-changed': { profileId: string; model: string };
  /** 服务商列表/密钥/模型表变更（设置页保存后刷新选择器） */
  'profiles-changed': void;

  /**
   * 模型元数据变更事件（启用/禁用、展示名、上下文长度、能力标签等）。
   * 触发时驱动各级 Picker、CascadeSelect、SettingsTab 进行增量响应式刷新。
   */
  'model-meta-changed': {
    profileId: string;
    model: string;
    enabled: boolean;
    displayName?: string;
  };
  // ...
};
```

同时必须将 `'model-meta-changed'` 追加至常量白名单 `UI_EVENT_NAMES` 数组中。

### 3.2 广播触发位置与原子保障

所有对元数据的写入统一收敛于 `upsertModelMeta`。在调用 `saveMap(map)` 完成落盘后，立即执行派发：

```typescript
// 派发 UI 响应式广播
emitUiEvent('model-meta-changed', {
  profileId,
  model,
  enabled: next.enabled !== false,
  displayName: next.displayName,
});
```

由此保证以下外露 API 均具备原子持久化与事件广播能力：
- `setModelEnabled(profileId, model, enabled)` ➔ 广播 `enabled: boolean`；
- `setModelDisplayName(profileId, model, displayName)` ➔ 广播更新后的展示名；
- `setModelContextLength`、`setModelCapability`、`setModelThinkingLevel` ➔ 同步广播；
- `upsertModelMetaExport`（供 IPC 扫描使用）➔ 同步广播。

---

## 四、 精确代码落地实现（Implementation Blueprint）

### 4.1 契约前置补丁：`apps/crish-desktop/src/api/uiEvents.ts`

执行 Agent 需在 `apps/crish-desktop/src/api/uiEvents.ts` 中增补以下定义（若尚未添加）：

```typescript
// === 在 UiEventMap 接口中追加 (约第 39 行) ===
  /** 模型元数据变更事件（启用/禁用、展示名、能力标签变更） */
  'model-meta-changed': {
    profileId: string;
    model: string;
    enabled: boolean;
    displayName?: string;
  };

// === 在 UI_EVENT_NAMES 数组中追加 (约第 98 行) ===
  'model-changed',
  'profiles-changed',
  'model-meta-changed', // 追加至此
  'focus-composer',
```

### 4.2 核心改造：`apps/crish-desktop/src/api/modelCatalogMeta.ts`

请执行 Agent 严格使用以下完整代码覆盖 `apps/crish-desktop/src/api/modelCatalogMeta.ts`：

```typescript
/**
 * 模型元数据存储（拆自 modelCatalog.ts）：localStorage 读写 + get/set 元信息。
 * 引入 memoryMetaCache 单例内存镜像，杜绝 O(N*M) 同步反序列化雪崩（耗时从 200ms 骤降至 <0.2ms）。
 * 写入操作自动同步内存与 LocalStorage，并通过 uiEvents 广播 'model-meta-changed'。
 */

import { guessContextLength } from './modelCatalogPure';
import type {
  ModelCapabilityKey,
  ModelMeta,
} from './modelCatalogTypes';
import { emitUiEvent } from './uiEvents';

const META_KEY = 'crish_model_meta_v1';

type MetaMap = Record<string, ModelMeta>;

/** 模块级单例内存镜像缓存 */
let memoryMetaCache: MetaMap | null = null;

function metaKey(profileId: string, model: string): string {
  return `${profileId}::${model}`;
}

/**
 * 加载元数据字典（优先命中内存单例镜像）
 */
function loadMap(): MetaMap {
  if (memoryMetaCache !== null) {
    return memoryMetaCache;
  }
  try {
    const raw =
      typeof localStorage !== 'undefined' ? localStorage.getItem(META_KEY) : null;
    if (!raw) {
      memoryMetaCache = {};
      return memoryMetaCache;
    }
    const o = JSON.parse(raw);
    memoryMetaCache = o && typeof o === 'object' ? (o as MetaMap) : {};
    return memoryMetaCache;
  } catch {
    memoryMetaCache = {};
    return memoryMetaCache;
  }
}

/**
 * 保存元数据字典（同步写穿透：立即更新内存镜像 + 持久化 LocalStorage）
 */
function saveMap(map: MetaMap): void {
  memoryMetaCache = map;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(META_KEY, JSON.stringify(map));
    }
  } catch {
    /* ignore storage quota or disabled errors */
  }
}

/**
 * 监听跨窗口/跨标签页 StorageEvent，自动失效内存缓存
 */
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e: StorageEvent) => {
    if (e.key === META_KEY) {
      memoryMetaCache = null;
    }
  });
}

/**
 * 重置内存镜像缓存（供单测与生命周期管理使用）
 */
export function resetModelMetaCache(): void {
  memoryMetaCache = null;
}

/**
 * 获取当前内存镜像快照（内部调试与测试专用）
 */
export function _getMemoryMetaCacheSnapshot(): MetaMap | null {
  return memoryMetaCache;
}

/**
 * 读取模型元数据（O(1) 内存直读）
 */
export function getModelMeta(profileId: string, model: string): ModelMeta {
  const map = loadMap();
  const k = metaKey(profileId, model);
  const stored = map[k];
  if (stored) {
    return {
      ...stored,
      enabled: stored.enabled !== false,
      contextLength: stored.contextLength ?? guessContextLength(model),
    };
  }
  return {
    profileId,
    model,
    enabled: true,
    contextLength: guessContextLength(model),
  };
}

/**
 * 内部更新元信息：更新内存镜像、落盘 LocalStorage 并广播 uiEvents
 */
function upsertModelMeta(
  profileId: string,
  model: string,
  patch: Partial<
    Pick<
      ModelMeta,
      'enabled' | 'contextLength' | 'lastTest' | 'displayName' | 'capabilities' | 'defaultThinkingLevel'
    >
  >
): ModelMeta {
  const map = loadMap();
  const k = metaKey(profileId, model);
  const prev = getModelMeta(profileId, model);
  const next: ModelMeta = {
    ...prev,
    ...patch,
    profileId,
    model,
    capabilities:
      patch.capabilities !== undefined
        ? { ...(prev.capabilities || {}), ...patch.capabilities }
        : prev.capabilities,
  };
  // 空展示名不落盘
  if (typeof next.displayName === 'string') {
    const dn = next.displayName.trim();
    next.displayName = dn || undefined;
  }
  map[k] = next;
  saveMap(map);

  // 广播 UI 事件
  emitUiEvent('model-meta-changed', {
    profileId,
    model,
    enabled: next.enabled !== false,
    displayName: next.displayName,
  });

  return next;
}

/**
 * 设置模型启用/停用状态
 */
export function setModelEnabled(
  profileId: string,
  model: string,
  enabled: boolean
): ModelMeta {
  return upsertModelMeta(profileId, model, { enabled });
}

/**
 * 设置模型上下文长度
 */
export function setModelContextLength(
  profileId: string,
  model: string,
  contextLength: number | undefined
): ModelMeta {
  return upsertModelMeta(profileId, model, { contextLength });
}

/**
 * 设置模型展示名
 */
export function setModelDisplayName(
  profileId: string,
  model: string,
  displayName: string | undefined
): ModelMeta {
  return upsertModelMeta(profileId, model, {
    displayName: displayName?.trim() || undefined,
  });
}

/**
 * 设置模型单项能力标签
 */
export function setModelCapability(
  profileId: string,
  model: string,
  key: ModelCapabilityKey,
  on: boolean
): ModelMeta {
  const prev = getModelMeta(profileId, model);
  return upsertModelMeta(profileId, model, {
    capabilities: { ...(prev.capabilities || {}), [key]: on },
  });
}

/**
 * 设置模型默认思考档位
 */
export function setModelThinkingLevel(
  profileId: string,
  model: string,
  defaultThinkingLevel: string | undefined
): ModelMeta {
  return upsertModelMeta(profileId, model, { defaultThinkingLevel });
}

/** 展示名：优先 displayName，否则 model id */
export function formatModelDisplayName(
  profileId: string,
  model: string,
  meta?: ModelMeta | null
): string {
  const m = meta || getModelMeta(profileId, model);
  const dn = typeof m.displayName === 'string' ? m.displayName.trim() : '';
  return dn || model;
}

/** upsert 暴露给 IPC 面（扫描连通测试写回 lastTest / contextWindow） */
export function upsertModelMetaExport(
  profileId: string,
  model: string,
  patch: Partial<
    Pick<
      ModelMeta,
      'enabled' | 'contextLength' | 'lastTest' | 'displayName' | 'capabilities'
    >
  >
): ModelMeta {
  return upsertModelMeta(profileId, model, patch);
}
```

---

## 五、 单元测试与魔鬼测试用例（`modelCatalogMeta.test.ts`）

### 5.1 测试覆盖矩阵

| 测试模块 | 用例名称 | 核心断言与验证目标 |
| :--- | :--- | :--- |
| **内存缓存机制** | `memory cache hits & bypasses JSON.parse` | 验证 `localStorage.getItem` 仅在首次冷启动时被调用 1 次，后续读操作均直接命中内存。 |
| **缓存重置** | `resetModelMetaCache forces reload` | 验证调用 `resetModelMetaCache()` 后，下一次读取重新走 `localStorage.getItem`。 |
| **性能极限压测** | `Devil-06: 2000 reads under 5ms` | 连续执行 2,000 次 `getModelMeta`，耗时严格小于 5ms（实际 <1ms），杜绝同步 I/O 阻塞。 |
| **事件广播** | `setModelEnabled emits model-meta-changed` | 验证调用 `setModelEnabled` 后，`onUiEvent` 能够捕获到强类型载荷 `{ profileId, model, enabled: false }`。 |
| **展示名与修剪** | `displayName whitespace trimming` | 验证展示名前后空格被自动修剪，纯空白字符串自动落盘为 `undefined`。 |
| **跨窗口同步** | `cross-tab storage event resets cache` | 派发 `StorageEvent('storage', { key: 'crish_model_meta_v1' })`，验证内存缓存自动置空重载。 |
| **异常防御** | `corrupted JSON recovers gracefully` | 当 LocalStorage 中存入损坏的 JSON 字符串时，函数不崩溃，安全返回默认元数据。 |
| **写入异常容错** | `storage quota exceeded tolerance` | 当 `localStorage.setItem` 抛出异常时，函数不阻断，内存镜像依然正常生效。 |

### 5.2 全量测试代码：`apps/crish-desktop/src/api/modelCatalogMeta.test.ts`

请执行 Agent 新建该文件并写入以下完整源码：

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onUiEvent } from './uiEvents';
import {
  _getMemoryMetaCacheSnapshot,
  formatModelDisplayName,
  getModelMeta,
  resetModelMetaCache,
  setModelCapability,
  setModelContextLength,
  setModelDisplayName,
  setModelEnabled,
  setModelThinkingLevel,
  upsertModelMetaExport,
} from './modelCatalogMeta';

describe('modelCatalogMeta with In-Memory Cache', () => {
  beforeEach(() => {
    localStorage.clear();
    resetModelMetaCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('基础元数据存取与默认值', () => {
    it('未设置元数据时返回正确的默认值', () => {
      const meta = getModelMeta('provider-1', 'deepseek-v4-flash');
      expect(meta.profileId).toBe('provider-1');
      expect(meta.model).toBe('deepseek-v4-flash');
      expect(meta.enabled).toBe(true);
      expect(meta.contextLength).toBe(1_000_000);
    });

    it('setModelEnabled 能够正确写入并读取', () => {
      setModelEnabled('provider-1', 'gpt-4o', false);
      const meta = getModelMeta('provider-1', 'gpt-4o');
      expect(meta.enabled).toBe(false);

      setModelEnabled('provider-1', 'gpt-4o', true);
      const updated = getModelMeta('provider-1', 'gpt-4o');
      expect(updated.enabled).toBe(true);
    });

    it('setModelDisplayName 正确修剪空白，纯空白转为 undefined', () => {
      setModelDisplayName('provider-1', 'gpt-4o', '   GPT-4 Omni Custom   ');
      let meta = getModelMeta('provider-1', 'gpt-4o');
      expect(meta.displayName).toBe('GPT-4 Omni Custom');
      expect(formatModelDisplayName('provider-1', 'gpt-4o')).toBe('GPT-4 Omni Custom');

      // 空白修剪后清空
      setModelDisplayName('provider-1', 'gpt-4o', '    ');
      meta = getModelMeta('provider-1', 'gpt-4o');
      expect(meta.displayName).toBeUndefined();
      expect(formatModelDisplayName('provider-1', 'gpt-4o')).toBe('gpt-4o');
    });

    it('支持能力标记、上下文与思考档位更新', () => {
      setModelCapability('provider-1', 'model-x', 'vision', true);
      setModelContextLength('provider-1', 'model-x', 128_000);
      setModelThinkingLevel('provider-1', 'model-x', 'high');

      const meta = getModelMeta('provider-1', 'model-x');
      expect(meta.capabilities?.vision).toBe(true);
      expect(meta.contextLength).toBe(128_000);
      expect(meta.defaultThinkingLevel).toBe('high');
    });
  });

  describe('memoryMetaCache 单例内存镜像机制', () => {
    it('内存缓存命中：后续读取不重复执行 localStorage.getItem', () => {
      // 预置数据
      setModelEnabled('provider-1', 'model-a', true);

      // spy localStorage.getItem
      const getItemSpy = vi.spyOn(Storage.prototype, 'getItem');

      // 首次读取：由于 setModelEnabled 已经写穿透，memoryMetaCache 应该已有数据
      expect(_getMemoryMetaCacheSnapshot()).not.toBeNull();
      const meta1 = getModelMeta('provider-1', 'model-a');
      expect(meta1.enabled).toBe(true);

      // 多次密集读取
      for (let i = 0; i < 50; i++) {
        getModelMeta('provider-1', 'model-a');
      }

      // 期间应当 0 次调用 getItem
      expect(getItemSpy).toHaveBeenCalledTimes(0);
    });

    it('resetModelMetaCache 会清空内存镜像并在下次读取时触发重新加载', () => {
      setModelEnabled('provider-1', 'model-b', false);
      expect(_getMemoryMetaCacheSnapshot()).not.toBeNull();

      resetModelMetaCache();
      expect(_getMemoryMetaCacheSnapshot()).toBeNull();

      const getItemSpy = vi.spyOn(Storage.prototype, 'getItem');
      const meta = getModelMeta('provider-1', 'model-b');
      expect(meta.enabled).toBe(false);
      expect(getItemSpy).toHaveBeenCalledTimes(1);
    });

    it('Devil-06: 连续执行 2,000 次 getModelMeta，主线程耗时必须严格小于 5ms', () => {
      // 预先初始化若干模型数据
      for (let i = 0; i < 20; i++) {
        setModelEnabled('provider-1', `model-bench-${i}`, i % 2 === 0);
      }

      const t0 = performance.now();
      for (let i = 0; i < 2000; i++) {
        const m = `model-bench-${i % 20}`;
        getModelMeta('provider-1', m);
      }
      const elapsed = performance.now() - t0;

      // 验证极速内存直读（通常 < 1ms，门禁要求 < 5ms）
      expect(elapsed).toBeLessThan(5);
    });
  });

  describe('UI 事件广播联动（model-meta-changed）', () => {
    it('setModelEnabled 变更时精准广播 model-meta-changed 事件', () => {
      const received: unknown[] = [];
      const off = onUiEvent('model-meta-changed', (detail) => {
        received.push(detail);
      });

      setModelEnabled('provider-x', 'claude-3-7-sonnet', false);

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({
        profileId: 'provider-x',
        model: 'claude-3-7-sonnet',
        enabled: false,
        displayName: undefined,
      });

      off();
    });

    it('setModelDisplayName 变更时广播带 displayName 的事件', () => {
      const received: unknown[] = [];
      const off = onUiEvent('model-meta-changed', (detail) => {
        received.push(detail);
      });

      setModelDisplayName('provider-y', 'deepseek-r1', 'DeepSeek R1 Thinking');

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({
        profileId: 'provider-y',
        model: 'deepseek-r1',
        enabled: true,
        displayName: 'DeepSeek R1 Thinking',
      });

      off();
    });

    it('upsertModelMetaExport 同样触发事件广播', () => {
      const received: unknown[] = [];
      const off = onUiEvent('model-meta-changed', (detail) => {
        received.push(detail);
      });

      upsertModelMetaExport('provider-z', 'qwen-2.5-max', {
        enabled: true,
        displayName: '通义千问 Max',
      });

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({
        profileId: 'provider-z',
        model: 'qwen-2.5-max',
        enabled: true,
        displayName: '通义千问 Max',
      });

      off();
    });
  });

  describe('跨窗口 StorageEvent 监听与失效机制', () => {
    it('接收到 crish_model_meta_v1 键的 storage 事件时自动使内存缓存过期', () => {
      setModelEnabled('provider-1', 'model-sync', true);
      expect(_getMemoryMetaCacheSnapshot()).not.toBeNull();

      // 派发 StorageEvent
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'crish_model_meta_v1',
          newValue: JSON.stringify({}),
        })
      );

      // 内存缓存应该已被清空为 null
      expect(_getMemoryMetaCacheSnapshot()).toBeNull();
    });

    it('接收到其他不相干 key 的 storage 事件不会清空内存缓存', () => {
      setModelEnabled('provider-1', 'model-sync', true);
      expect(_getMemoryMetaCacheSnapshot()).not.toBeNull();

      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'some_other_key',
          newValue: '123',
        })
      );

      expect(_getMemoryMetaCacheSnapshot()).not.toBeNull();
    });
  });

  describe('异常防御与边界保护', () => {
    it('LocalStorage 数据损坏（非法 JSON）时静默回退为空对象，不崩溃', () => {
      localStorage.setItem('crish_model_meta_v1', '{ invalid json ...');
      resetModelMetaCache();

      const meta = getModelMeta('provider-1', 'unknown-model');
      expect(meta.enabled).toBe(true);
      expect(meta.model).toBe('unknown-model');
    });

    it('LocalStorage 存储非对象类型时安全回退', () => {
      localStorage.setItem('crish_model_meta_v1', '"a primitive string"');
      resetModelMetaCache();

      const meta = getModelMeta('provider-1', 'unknown-model');
      expect(meta.enabled).toBe(true);
    });

    it('LocalStorage.setItem 抛错时写入不崩溃，内存镜像依然更新', () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });

      expect(() => {
        setModelEnabled('provider-1', 'model-fail', false);
      }).not.toThrow();

      // 内存镜像依然有效
      expect(getModelMeta('provider-1', 'model-fail').enabled).toBe(false);
    });
  });
});
```

---

## 六、 验收标准与验证命令（DoD & Verification）

### 6.1 验证命令清单

执行 Agent 完成代码落盘后，必须使用 **pwsh7** 依次执行以下检查命令，确保交付零死角：

```powershell
# 1. 运行 Task-A 专项单元测试套件（必须 100% 全部通过）
npx vitest run apps/crish-desktop/src/api/modelCatalogMeta.test.ts

# 2. 运行模型目录既有单元测试套件（验证未破坏存量逻辑）
npx vitest run apps/crish-desktop/src/api/modelCatalog.test.ts

# 3. 运行 UI 事件总线既有单元测试（验证契约兼容性）
npx vitest run apps/crish-desktop/src/api/uiEvents.test.ts

# 4. 全局前端静态类型检查（必须 0 报错）
npm run typecheck

# 5. 代码行数门禁检查（确保文件未膨胀，0 违规）
npm run check:line-counts
```

### 6.2 质量与断言门禁（Definition of Done）

1. **功能完整性**：
   - `memoryMetaCache` 成功接入，完全规避重复反序列化；
   - `setModelEnabled` 写入后 100% 触发 `uiEvents` 广播 `'model-meta-changed'`；
   - 跨标签页 `storage` 事件监听与测试重置钩子完备。
2. **性能压测门禁**：
   - 专项测试中的 `Devil-06` 2000 次高频读耗时必须 `< 5ms`。
3. **行数契约**：
   - `apps/crish-desktop/src/api/modelCatalogMeta.ts` 保持在约 200 行，完全在 400 行业务逻辑门禁红线安全区内。
4. **协作纪律**：
   - 严格限定在白名单物理文件域内；
   - 改动保留在本地工作区，**严禁执行 git 提交、git checkout、git reset**。