# 跨层契约、测试资产保护与系统迁移实施编排终极详案
# (Cross-Layer Contract, Test Asset Protection & Migration Orchestration Improved Plan)

> **战役工作区**：`docs/permission-system-consolidation/`  
> **文档定位**：第三轮方案改进权威实施详案（Plan Improvement Wave）  
> **责任领域**：全栈通信协议（`shared-types` & `conex-types`）、跨端 Wire 契约、前端 Store 状态机、4 阶梯演进测试网（E2E / Vitest / Cargo）、分批次代码物理清除与生产级代码替换蓝图  
> **权威基准**：
> - 战役总方案：[`00-总方案.md`](../00-总方案.md)
> - 评审裁决报告：[`plan-reviews/01-03`](../plan-reviews/) 3 份资深评审专家报告（完全吸纳 16 项刚性整改指令）  
> - 用户最高指示：“不允许打补丁，不允许硬编码，有合理的抽象，适合未来的功能需求，代码尽量简洁，具有优秀的可维护性。需要删除的代码就删除，需要系统性的重构。生成的方案应该能彻底杜绝这些问题或者未来的衍生问题，要求一次性解决掉。尽量减少不必要的兼容，最好是不兼容。权限模式统一收敛为 3 个选项：`'ask' | 'smart' | 'full'`。”

---

## 目录

1. [方案背景与改进实施总纲](#一方案背景与改进实施总纲)
2. [全栈端到端协议严丝合缝契约（Wire 小写单射）](#二全栈端到端协议严丝合缝契约wire-小写单射)
   - 2.1 彻底驱逐 `full-access`：全栈单一真源统一为小写 `'ask' | 'smart' | 'full'`
   - 2.2 `packages/shared-types` 权威 TypeScript 契约与运行时解析器
   - 2.3 `crates/conex-types` 权威 Rust 枚举、Display、FromStr 与 Serde 序列化
   - 2.4 IPC 信封强类型化改造：`RunTaskOptions.permission_mode: Option<PermissionMode>`
   - 2.5 彻底清除前端胶水层：删除 `DESKTOP_TO_ENGINE`、`toEnginePermissionMode`、`fromEnginePermissionMode`
   - 2.6 子代理权限无损继承拓扑与 `SubagentSpawnRequest` 契约落地
3. [4 阶梯演进测试网（Zero-CI Breakage Ladder）](#三4-阶梯演进测试网zero-ci-breakage-ladder)
   - 3.1 阶梯一：协议与类型基座平滑收敛（消灭 TypeScript 编译断裂）
   - 3.2 阶梯二：E2E 防污染白名单升级与前端 Store 纯粹化测试
     - `tests/e2e/ui-store-invariants.spec.ts` 改造细节
     - `tests/e2e/full-journey.spec.ts` 模式切换与下发用例
     - `permissionStore.test.ts` 彻底重写（完全切除 `planModeEnabled` 和 `planApproved` 越权测试）
     - `permissionModes.test.ts` 彻底重写（消灭 20+ 别名与中文逆向解析单测）
   - 3.3 阶梯三：Rust 内核裁决与工具测试套件深度纠偏
     - `crates/agent-tools/src/revert.rs:353` 纠偏测试
     - `crates/agent-tools/src/permission.rs:641` 纠偏测试（Full 模式大回退放行断言）
     - `crates/session-loop/src/tool_exec_tests/revert.rs:57` 纠偏测试（消除 ApprovalRequired 报错断言）
     - 清理 `polyglot.rs`、`CdShape`、`note_permission` 过时单测
     - 追加子代理权限无损继承集成测试 `test_subagent_inherits_parent_full_permission`
   - 3.4 阶梯四：E2E 刚性锁死与全量门禁终态锁定
4. [分批次实施编排与物理清退蓝图（Batch Execution Blueprints）](#四分批次实施编排与物理清退蓝图batch-execution-blueprints)
   - 4.1 批次一：物理删除清册（19 个目标，净减 3,952 行代码执行清单）
   - 4.2 批次二：核心文件手术式就地替换生产源码蓝图（逐文件完整代码）
   - 4.3 批次三：测试套件重写与纠偏落地源码
   - 4.4 批次四：全量验证流水线执行命令表（统一 pwsh7）
5. [风险应急与回滚保障机制](#五风险应急与回滚保障机制)

---

## 一、方案背景与改进实施总纲

在第一轮独立方案（Plan 01 ~ Plan 07）产出与第二轮交叉评审（Review 01 ~ 03）后，三大评审专家达成了一致裁决：系统方向完全正确，但第一轮草案在**Wire 协议彻底断代程度**、**默认模式基准选取**、**`permissionStore.test.ts` 与瘦身契约的脱节**以及**极端命令在 Full 模式下的告知时序**上存在断层。

本改进方案作为第三轮的核心技术成果，吸收全部评审意见，彻底消除全部 7 处跨方案冲突（INC-01 ~ INC-07），刚性贯彻 6 项合成指令（MAI-01 ~ MAI-16），制定从契约锁定、测试网守卫到分批次物理落地的完整落地蓝图。

### 核心改进要点速览：
1. **Wire 协议决不妥协**：全栈统一小写 `"ask" | "smart" | "full"`，彻底物理删除 `DESKTOP_TO_ENGINE` 与 `toEnginePermissionMode`；
2. **默认模式全局统一**：前端与运行时推荐默认统一确立为 `'smart'`（智能命令放行）；
3. **消除 Store 测试回潮**：推翻 Plan 07 中复活 `planModeEnabled` 的错误单测，严格以单一状态契约重写；
4. **叶子工具彻底脱钩**：除清理 `shell.rs` 外，彻底删除 8 个笔记工具中的 `maybe_ask_note_write`，从 `ToolContext` 拔除 `ask` 字段；
5. **Full 模式零时延旁路**：主执行线 100% 顺从执行，通过 `tokio::spawn` 异步并发推送 Redline Toast 警示与全真审计；
6. **子代理权威继承**：派发时强制从父 `ActiveRun` 提取 `permission_mode`，彻底杜绝缺省降级为 `Ask`。

---

## 二、全栈端到端协议严丝合缝契约（Wire 小写单射）

### 2.1 彻底驱逐 `full-access`：全栈统一小写三态字面量

全系统彻底执行断代原则，将 Wire 协议值、前端枚举、Rust 枚举严格绑定为 1:1 双向单射：

$$\text{TypeScript: 'ask'} \underset{\text{deser}}{\overset{\text{ser}}{\rightleftharpoons}} \text{Wire JSON: "ask"} \underset{\text{deser}}{\overset{\text{ser}}{\rightleftharpoons}} \text{Rust: PermissionMode::Ask}$$
$$\text{TypeScript: 'smart'} \underset{\text{deser}}{\overset{\text{ser}}{\rightleftharpoons}} \text{Wire JSON: "smart"} \underset{\text{deser}}{\overset{\text{ser}}{\rightleftharpoons}} \text{Rust: PermissionMode::Smart}$$
$$\text{TypeScript: 'full'} \underset{\text{deser}}{\overset{\text{ser}}{\rightleftharpoons}} \text{Wire JSON: "full"} \underset{\text{deser}}{\overset{\text{ser}}{\rightleftharpoons}} \text{Rust: PermissionMode::Full}$$

### 2.2 `packages/shared-types` 权威 TypeScript 契约与运行时解析器

#### 1. 契约定义：`packages/shared-types/src/generated/device/types.ts`
替换第 35-36 行的历史常量与类型：

```typescript
// packages/shared-types/src/generated/device/types.ts:35-36
/** 权限模式权威枚举（统一三态：每次询问 / 智能命令放行 / 完全允许） */
export const PERMISSION_MODE_VALUES = ['ask', 'smart', 'full'] as const;
export type PermissionMode = (typeof PERMISSION_MODE_VALUES)[number];
```

#### 2. 解析器守卫：`packages/shared-types/src/generated/device/parser.ts`
更新解析逻辑（L236-L241），坚决拦截非法值，杜绝任何中间层容错妥协：

```typescript
// packages/shared-types/src/generated/device/parser.ts:236-241
export function parsePermissionMode(v: unknown): ParseResult<PermissionMode> {
  if (typeof v === 'string' && (PERMISSION_MODE_VALUES as readonly string[]).includes(v)) {
    return parseOk(v as PermissionMode);
  }
  return parseErr(
    `PermissionMode: expected one of ${PERMISSION_MODE_VALUES.join(', ')}, got ${JSON.stringify(v)}`
  );
}
```

#### 3. 一等导出与类型守护：`packages/shared-types/src/run-control.ts`
```typescript
// packages/shared-types/src/run-control.ts
import { PERMISSION_MODE_VALUES, type PermissionMode } from './generated/device/types';

export { PERMISSION_MODE_VALUES };
export type { PermissionMode };

export function isPermissionMode(value: unknown): value is PermissionMode {
  return (
    typeof value === 'string' &&
    (PERMISSION_MODE_VALUES as readonly string[]).includes(value)
  );
}
```

### 2.3 `crates/conex-types` 权威 Rust 枚举、Display、FromStr 与 Serde 序列化

彻底重构 `crates/conex-types/src/device/commands/enums.rs:75-86`，删除 `Plan` 与 `FullAccess`，统一为小写序列化：

```rust
// crates/conex-types/src/device/commands/enums.rs:75-86
/// 权限模式（统一三态：每次询问 / 智能命令放行 / 完全允许模式）
///
/// 严格契约：Serde rename_all = "lowercase" 保证网络层传输值严格为 "ask" | "smart" | "full"
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum PermissionMode {
    /// 每次询问（全安全底线兜底）
    Ask,
    /// 智能命令放行（全系统推荐默认）
    #[default]
    Smart,
    /// 完全允许模式（系统不因命令而不允许执行，所有执行的命令都是可以运行的）
    Full,
}

impl PermissionMode {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::Smart => "smart",
            Self::Full => "full",
        }
    }
}

impl std::fmt::Display for PermissionMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for PermissionMode {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "ask" => Ok(Self::Ask),
            "smart" => Ok(Self::Smart),
            "full" => Ok(Self::Full),
            other => Err(format!(
                "invalid permission mode: '{other}', expected 'ask' | 'smart' | 'full'"
            )),
        }
    }
}
```

### 2.4 IPC 信封强类型化改造：`RunTaskOptions.permission_mode`

在 `crates/conex-run/src/run/run_launch.rs:588` 中，将字段类型从 `pub permission_mode: Option<String>` 直接升级为强类型枚举：

```rust
// crates/conex-run/src/run/run_launch.rs
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunTaskOptions {
    pub run_id: String,
    pub session_id: String,
    pub prompt: Option<String>,
    pub mode: Option<String>,
    pub cwd: Option<String>,
    /// 权威权限模式枚举（直连 Serde 反序列化，禁止使用弱类型字符串）
    pub permission_mode: Option<PermissionMode>,
    // ...
}
```

### 2.5 彻底清除前端胶水层：删除 `toEnginePermissionMode`

- 彻底从 `apps/crish-desktop/src/api/permissionModes.ts` 中删除 `EnginePermissionMode`、`DESKTOP_TO_ENGINE`、`toEnginePermissionMode`、`fromEnginePermissionMode`；
- 在 `apps/crish-desktop/src/api/chat-bridge/streamSession.ts` 中，直接获取并下发 Store 状态值：
  ```typescript
  // apps/crish-desktop/src/api/chat-bridge/streamSession.ts:90
  import { usePermissionStore } from '../../store/permissionStore';

  // 零胶水、零转换直接下发
  const permissionMode = usePermissionStore.getState().permissionMode;
  ```

### 2.6 子代理权限无损继承拓扑与 `SubagentSpawnRequest` 契约落地

1. **协议结构体扩展**：在 `crates/agent-tools/src/tools/subagent/contract.rs` 中：
   ```rust
   pub struct SubagentSpawnRequest {
       // ... 既有字段 ...
       /// 继承或指定的权限模式（None = 自动回退继承父 run 模式）
       pub permission_mode: Option<conex_types::PermissionMode>,
   }
   ```
2. **工具调用点装配**：在 `crates/agent-tools/src/tools/subagent/tool.rs:404` 中：
   ```rust
   permission_mode: Some(ctx.permission_mode), // 从当前执行上下文无损注入
   ```
3. **派发器权威继承**：在 `crates/conex-run/src/subagent_spawner/spawn.rs::spawn_unchecked` 中：
   ```rust
   // 权威继承逻辑：优先使用请求模式，缺省强行继承父 Run 模式，脱离父级才回退默认值 Smart
   let inherited_mode = req.permission_mode
       .or_else(|| parent_run.as_ref().and_then(|p| self.get_active_run_permission_mode(p)))
       .unwrap_or(conex_types::PermissionMode::Smart);

   let launch_options = RunTaskOptions {
       // ...
       permission_mode: Some(inherited_mode),
       // ...
   };
   ```

---

## 三、4 阶梯演进测试网（Zero-CI Breakage Ladder）

为切实兑现“快层 CI（类型检查 + 覆盖率）与中层 CI（vitest + cargo test）”全流程全绿的纪律要求，实施阶段按四阶梯有序推进：

### 3.1 阶梯一：协议与类型基座平滑收敛（消灭 TypeScript 编译断裂）

1. **实施动作**：
   - 更新 `packages/shared-types` 导出三态枚举；
   - 更新 `crates/conex-types` 导出小写三态枚举；
   - 更新 `packages/conversation-flow/src/projectPlan.ts`，剔除 `input.permissionMode === 'plan'` 依赖；
2. **守门验证命令**：
   ```powershell
   npm run typecheck
   cargo check -p conex-types
   ```
   **断言**：类型基座编译 100% 通过，无类型漂移。

---

### 3.2 阶梯二：E2E 防污染白名单升级与前端 Store 纯粹化测试

#### 1. `tests/e2e/ui-store-invariants.spec.ts` 彻底重构
精确修改 3 处硬编码四态断言：

```typescript
// tests/e2e/ui-store-invariants.spec.ts:123-127
// 6a. 绝无 permissionMode 状态污染：集中收敛为集中三选项 ('ask' | 'smart' | 'full')
const validModes = ['ask', 'smart', 'full'];
expect(
  validModes,
  `[${actionName}] permissionMode 遭到污染：${storeStats.state!.permissionMode}`
).toContain(storeStats.state!.permissionMode);

// tests/e2e/ui-store-invariants.spec.ts:228-230
expect(['ask', 'smart', 'full']).toContain(
  initialState.permissionMode
);

// tests/e2e/ui-store-invariants.spec.ts:396
expect(['ask', 'smart', 'full']).toContain(finalPermissionMode);
```
**防循环断言要求**：验证在多次弹窗和 Tab 切换下，`storeStats.state` 更新频次严格 `< 10` 次。

#### 2. `tests/e2e/full-journey.spec.ts` 业务全旅程重构
- 更新 L182 断言：`expect(['ask', 'smart', 'full']).toContain(String(lastRun.permissionMode || 'smart'));`；
- 新增“用户在 Composer 切换权限模式至 smart / full 并成功下发任务”端到端用例。

#### 3. `permissionStore.test.ts` 彻底重写（完全切除 Plan 越权测试）
**彻底废除 Plan 07 中的回潮单测代码**，严格对齐单一状态契约：

```typescript
// apps/crish-desktop/src/store/permissionStore.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePermissionStore } from './permissionStore';
import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODE_STORAGE_KEY,
} from '../api/permissionModes';

beforeEach(() => {
  localStorage.clear();
  usePermissionStore.setState({
    permissionMode: DEFAULT_PERMISSION_MODE,
  });
});

afterEach(() => {
  localStorage.clear();
});

describe('permissionStore — 单一状态契约单测 (零 Plan 污染)', () => {
  it('初始状态恒为 DEFAULT_PERMISSION_MODE (smart)', () => {
    expect(usePermissionStore.getState().permissionMode).toBe('smart');
  });

  it('setPermissionMode 正常更新状态并同步落盘', () => {
    const s = usePermissionStore.getState();

    s.setPermissionMode('full');
    expect(usePermissionStore.getState().permissionMode).toBe('full');
    expect(localStorage.getItem(PERMISSION_MODE_STORAGE_KEY)).toBe('full');

    s.setPermissionMode('ask');
    expect(usePermissionStore.getState().permissionMode).toBe('ask');
    expect(localStorage.getItem(PERMISSION_MODE_STORAGE_KEY)).toBe('ask');

    s.setPermissionMode('smart');
    expect(usePermissionStore.getState().permissionMode).toBe('smart');
    expect(localStorage.getItem(PERMISSION_MODE_STORAGE_KEY)).toBe('smart');
  });

  it('模块重载时从 LocalStorage 正确恢复状态', async () => {
    localStorage.setItem(PERMISSION_MODE_STORAGE_KEY, 'full');
    vi.resetModules();
    const { usePermissionStore: freshStore } = await import('./permissionStore');
    expect(freshStore.getState().permissionMode).toBe('full');
  });

  it('LocalStorage 存在非法值或旧值时自动单向回落至 smart', async () => {
    localStorage.setItem(PERMISSION_MODE_STORAGE_KEY, 'deep'); // 历史旧值
    vi.resetModules();
    const { usePermissionStore: freshStore } = await import('./permissionStore');
    expect(freshStore.getState().permissionMode).toBe('smart');
  });

  it('绝不产生双写脏键', () => {
    usePermissionStore.getState().setPermissionMode('full');
    const keys = Object.keys(localStorage);
    expect(keys).not.toContain('crish-permission-v1');
    expect(keys).not.toContain('crish_command_permissions_v1');
  });
});
```

#### 4. `permissionModes.test.ts` 彻底重写（消灭 20+ 别名单测）
```typescript
// apps/crish-desktop/src/api/permissionModes.test.ts
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODE_IDS,
  PERMISSION_MODE_STORAGE_KEY,
  coercePermissionMode,
  isPermissionMode,
  loadStoredPermissionMode,
  nextPermissionMode,
  permissionModeLabel,
  permissionModeMeta,
  permissionModeShortLabel,
  persistPermissionMode,
  previousPermissionMode,
} from './permissionModes';

describe('permissionModes — 纯三态权威契约验证', () => {
  it('DEFAULT 恒为 smart，模式列表严格收敛为 ask, smart, full', () => {
    expect(DEFAULT_PERMISSION_MODE).toBe('smart');
    expect(PERMISSION_MODE_IDS).toEqual(['ask', 'smart', 'full']);
  });

  it('isPermissionMode 仅放行合法三态，拒绝一切别名', () => {
    expect(isPermissionMode('ask')).toBe(true);
    expect(isPermissionMode('smart')).toBe(true);
    expect(isPermissionMode('full')).toBe(true);

    // 严厉断言：已废除的别名与历史伪模式全部返回 false
    expect(isPermissionMode('deep')).toBe(false);
    expect(isPermissionMode('plan')).toBe(false);
    expect(isPermissionMode('yolo')).toBe(false);
    expect(isPermissionMode('full-access')).toBe(false);
    expect(isPermissionMode('auto')).toBe(false);
    expect(isPermissionMode(null)).toBe(false);
    expect(isPermissionMode('')).toBe(false);
  });

  it('coercePermissionMode 对非法输入强制收敛至 smart', () => {
    expect(coercePermissionMode('ask')).toBe('ask');
    expect(coercePermissionMode('smart')).toBe('smart');
    expect(coercePermissionMode('full')).toBe('full');

    // 零容错：未知/历史值统一回退 smart
    expect(coercePermissionMode('deep')).toBe('smart');
    expect(coercePermissionMode('plan')).toBe('smart');
    expect(coercePermissionMode('garbage')).toBe('smart');
    expect(coercePermissionMode(undefined)).toBe('smart');
  });

  it('模式三态轮转闭环 (next / previous)', () => {
    expect(nextPermissionMode('ask')).toBe('smart');
    expect(nextPermissionMode('smart')).toBe('full');
    expect(nextPermissionMode('full')).toBe('ask');

    expect(previousPermissionMode('ask')).toBe('full');
    expect(previousPermissionMode('full')).toBe('smart');
    expect(previousPermissionMode('smart')).toBe('ask');
  });

  it('持久化读写与自动擦除脏白名单', () => {
    localStorage.clear();
    localStorage.setItem('crish_command_permissions_v1', '["git status"]');
    expect(loadStoredPermissionMode()).toBe('smart');
    // 验证历史白名单脏键已被安全清理
    expect(localStorage.getItem('crish_command_permissions_v1')).toBeNull();

    persistPermissionMode('full');
    expect(localStorage.getItem(PERMISSION_MODE_STORAGE_KEY)).toBe('full');
  });
});
```

---

### 3.3 阶梯三：Rust 内核裁决与工具测试套件深度纠偏

#### 1. 纠偏 `crates/agent-tools/src/revert.rs:353` 生产代码与单测
```rust
// crates/agent-tools/src/revert.rs
pub fn gate_verdict(
    &self,
    analysis: &SemanticAnalysis,
    mode: PermissionMode,
) -> Option<PermissionVerdict> {
    // 【核心纠偏】：Full 模式真放行，不拦截回退操作
    if mode == PermissionMode::Full {
        return None;
    }
    // ...
}
```

#### 2. 纠偏 `crates/agent-tools/src/permission.rs:641` 单测
```rust
#[test]
fn full_mode_large_revert_allows_execution() {
    assert_eq!(
        decide_command_with_revert(
            "git checkout abc1234",
            true,
            false,
            PermissionMode::Full,
            &policy(large_area()),
        ),
        PermissionVerdict::Allow,
        "Full 模式下大面积回退必须顺利 Allow 放行"
    );
}
```

#### 3. 纠偏 `crates/session-loop/src/tool_exec_tests/revert.rs:57` 集成测试
```rust
#[tokio::test]
async fn full_mode_large_revert_executes_without_gate() {
    let reg = registry_with(vec![Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg).with_revert_policy(revert_policy(large_area()));
    let calls = vec![command_call("c1", "echo", "git checkout abc1234")];
    let opts = ToolBatchOptions {
        permission_mode: Some(PermissionMode::Full),
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, None)
        .await;

    // 纠偏断言：EchoTool 顺利执行，无 ApprovalRequired 报错！
    assert!(out.results[0].is_ok());
    assert!(out.fatal.is_none());
}
```

#### 4. 追加子代理权限继承端到端单测
在 `crates/conex-run/tests/subagent_permission_test.rs` 中追加：
```rust
#[tokio::test]
async fn test_subagent_inherits_parent_full_permission() {
    let spawner = create_test_spawner().await;
    let req = SubagentSpawnRequest {
        prompt: "perform batch refactoring".into(),
        parent_session_id: "session-root".into(),
        permission_mode: Some(PermissionMode::Full),
        // ...
    };

    let result = spawner.spawn(&req).await.expect("spawn failed");
    let subagent_mode = spawner.get_spawned_mode(&result.subagent_run_id).await;
    assert_eq!(subagent_mode, Some(PermissionMode::Full), "子代理必须 100% 继承父会话 Full 权限");
}
```

---

### 3.4 阶梯四：E2E 刚性锁死与全量门禁终态锁定

1. 将 `ui-store-invariants.spec.ts` 中的 `validModes` 刚性收紧为唯一三态 `['ask', 'smart', 'full']`；
2. 清理全工程全部针对已删除模块（`polyglot`、`CdShape`、`commandPermissions`）的过时单测；
3. 执行 `FULL_CHECK_COMMANDS.md` 中的全量验证套件，锁定终态全绿。

---

## 四、分批次实施编排与物理清退蓝图（Batch Execution Blueprints）

### 4.1 批次一：物理删除清册（19 个目标，净减 3,952 行代码）

在落地实施的最初阶段，必须直接物理删除以下 19 个死代码模块与结构体：

```powershell
# 批次一：文件物理删除执行命令 (统一 pwsh7)
Remove-Item -Force -Path 'crates/conex-sandbox/src/polyglot.rs'
Remove-Item -Force -Path 'crates/agent-tools/src/tools/shell_redirect.rs'
Remove-Item -Force -Path 'crates/agent-tools/src/note_action_matrix.rs'
Remove-Item -Force -Path 'apps/crish-desktop/src/api/commandPermissions.ts'
Remove-Item -Force -Path 'apps/crish-desktop/src/api/commandPermissions.test.ts'
Remove-Item -Force -Path 'apps/crish-desktop/src/components/settings/settingsSecurityModel.ts'
Remove-Item -Force -Path 'apps/crish-desktop/src/components/settings/settingsSecurityModel.test.ts'
```

### 4.2 批次二：核心文件手术式就地替换生产源码蓝图

#### 1. `apps/crish-desktop/src/api/permissionModes.ts`（全量替换）
```typescript
/**
 * 权限模式核心定义与元数据（桌面 UI ↔ 引擎协议下发）
 * 严格收敛为三选项：ask (每次询问) | smart (智能放行) | full (完全允许)
 * 彻底不兼容断代：零别名、零中文反向解析、零胶水映射
 */

export type PermissionMode = 'ask' | 'smart' | 'full';

export interface PermissionModeMeta {
  id: PermissionMode;
  label: string;
  shortLabel: string;
  description: string;
  iconName: 'shield' | 'shield-check' | 'zap';
  accent: string;
  isRecommended?: boolean;
}

export const PERMISSION_MODE_STORAGE_KEY = 'crish_permission_mode';
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'smart';

export const PERMISSION_MODE_IDS: readonly PermissionMode[] = [
  'ask',
  'smart',
  'full',
] as const;

export const PERMISSION_MODES: readonly PermissionModeMeta[] = [
  {
    id: 'ask',
    label: '每次询问',
    shortLabel: '每次询问',
    description: '改文件、写操作与命令执行前均需确认',
    iconName: 'shield',
    accent: 'var(--text-secondary)',
  },
  {
    id: 'smart',
    label: '智能命令放行',
    shortLabel: '智能放行',
    description: '安全只读与构建命令自动放行，敏感操作询问',
    iconName: 'shield-check',
    accent: 'var(--color-primary-base, #10b981)',
    isRecommended: true,
  },
  {
    id: 'full',
    label: '完全允许模式',
    shortLabel: '完全放行',
    description: '所有操作与命令直接自动执行，零打扰极速交付',
    iconName: 'zap',
    accent: 'var(--color-warning-base, #f59e0b)',
  },
] as const;

const META_BY_ID = new Map<PermissionMode, PermissionModeMeta>(
  PERMISSION_MODES.map((m) => [m.id, m])
);

export function isPermissionMode(v: unknown): v is PermissionMode {
  return v === 'ask' || v === 'smart' || v === 'full';
}

/** 规范化收敛：非法输入纯 O(1) 回落推荐默认 smart */
export function coercePermissionMode(v: unknown): PermissionMode {
  return isPermissionMode(v) ? v : DEFAULT_PERMISSION_MODE;
}

export function permissionModeMeta(mode: unknown): PermissionModeMeta {
  const id = coercePermissionMode(mode);
  return META_BY_ID.get(id)!;
}

export function permissionModeLabel(mode: unknown): string {
  return permissionModeMeta(mode).label;
}

export function permissionModeShortLabel(mode: unknown): string {
  return permissionModeMeta(mode).shortLabel;
}

export function nextPermissionMode(current: unknown): PermissionMode {
  const cur = coercePermissionMode(current);
  const idx = PERMISSION_MODE_IDS.indexOf(cur);
  return PERMISSION_MODE_IDS[(idx + 1) % PERMISSION_MODE_IDS.length]!;
}

export function previousPermissionMode(current: unknown): PermissionMode {
  const cur = coercePermissionMode(current);
  const idx = PERMISSION_MODE_IDS.indexOf(cur);
  return PERMISSION_MODE_IDS[(idx - 1 + PERMISSION_MODE_IDS.length) % PERMISSION_MODE_IDS.length]!;
}

export function loadStoredPermissionMode(): PermissionMode {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_PERMISSION_MODE;
    // 一次性安全清理历史白名单遗留存储
    localStorage.removeItem('crish_command_permissions_v1');
    const raw = localStorage.getItem(PERMISSION_MODE_STORAGE_KEY);
    return isPermissionMode(raw) ? raw : DEFAULT_PERMISSION_MODE;
  } catch {
    return DEFAULT_PERMISSION_MODE;
  }
}

export function persistPermissionMode(mode: PermissionMode): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(PERMISSION_MODE_STORAGE_KEY, mode);
    }
  } catch {
    /* swallow-ok */
  }
}
```

#### 2. `crates/agent-tools/src/tools/shell.rs` 净化（彻底切除 6 重门禁）
在 `ShellCommandTool::prepare` 中，直接切除 130 行私门禁代码，精简为极简参数提取与直接放行：

```rust
// crates/agent-tools/src/tools/shell.rs
impl ShellCommandTool {
    pub(crate) fn prepare(&self, ctx: &ToolContext, args: &serde_json::Value) -> Prepared {
        let command = match require_string(args, "command") {
            Ok(c) => c.trim().to_string(),
            Err(e) => return Prepared::Done(Err(e)),
        };

        if command.is_empty() {
            return Prepared::Done(Err(ToolError::invalid_arguments("shell_command", "Command cannot be empty")));
        }
        if command.len() > MAX_COMMAND_LEN {
            return Prepared::Done(Err(ToolError::invalid_arguments("shell_command", "Command exceeds maximum length")));
        }

        let cwd = match optional_string(args, "cwd") {
            Some(rel) => match crate::tools::resolve_workspace_path(&ctx.workspace_root, &rel) {
                Ok(p) => p,
                Err(e) => return Prepared::Done(Err(e)),
            },
            None => ctx.workspace_root.clone(),
        };

        let timeout_ms = optional_u64(args, "timeoutMs")
            .unwrap_or(self.default_timeout_ms)
            .clamp(1, MAX_TIMEOUT_MS);
        let wait_ms = optional_u64(args, "waitMsBeforeAsync")
            .unwrap_or(DEFAULT_WAIT_MS_BEFORE_ASYNC)
            .clamp(1, MAX_TIMEOUT_MS);
        let is_daemon = optional_bool(args, "isDaemon").unwrap_or(false);

        // 叶子工具纯粹 I/O 化：零门禁，零拦截，直接交由子进程执行！
        let manager = ctx.background.clone().or_else(|| self.background_manager.clone());
        Prepared::Run(PreparedCommand {
            command,
            cwd,
            timeout_ms,
            wait_ms,
            is_daemon,
            background_manager: manager,
        })
    }
}
```

#### 3. 拔除 8 个笔记工具的 `maybe_ask_note_write`
从以下 8 个文件中删除对 `maybe_ask_note_write` 的调用，并从 `crates/agent-tools/src/context.rs::ToolContext` 中彻底删除 `pub ask: Option<AskCallback>` 字段：
- `crates/agent-tools/src/tools/note_document_apply_md.rs`
- `crates/agent-tools/src/tools/note_block_batch.rs`
- `crates/agent-tools/src/tools/note_block_delete.rs`
- `crates/agent-tools/src/tools/note_block_insert.rs`
- `crates/agent-tools/src/tools/note_block_move.rs`
- `crates/agent-tools/src/tools/note_block_set_attr.rs`
- `crates/agent-tools/src/tools/note_block_update.rs`
- `crates/agent-tools/src/tools/note_send_to_note.rs`

#### 4. `crates/conex-run/src/run/run_launch.rs` 审批门常态化装配
```rust
// crates/conex-run/src/run/run_launch.rs:919-936
let approval_gate = Arc::new(ApprovalGateImpl::new(
    run_id.clone(),
    session_id.clone(),
    parent_run_id.clone(),
    broadcast,
    Arc::clone(&handle_shared),
    state.store.clone(),
    cwd.clone(),
));

// 消除 approval: None 分支！无论任何模式，审批基础设施恒定常态就绪
let approval: Arc<dyn ApprovalGate> = Arc::clone(&approval_gate) as Arc<dyn ApprovalGate>;
```

#### 5. `crates/session-loop/src/exec_verdict.rs` SSOT 与 Full 模式非阻塞通知旁路
```rust
// crates/session-loop/src/exec_verdict.rs
pub async fn call_verdict(
    &self,
    call: &ToolBatchCall,
    options: &ToolBatchOptions,
    cx: &ExecContext<'_>,
) -> PermissionVerdict {
    if !self.registry.is_tool_enabled(&call.tool_name) {
        return PermissionVerdict::Deny;
    }

    let mode = options.permission_mode.unwrap_or(PermissionMode::Smart);

    // Full 模式：100% 顺从执行，绝不阻断！
    if mode == PermissionMode::Full {
        if let Some(cmd) = extract_command_str(&call.input) {
            let event_bridge = cx.event_bridge.clone();
            tokio::spawn(async move {
                // 异步旁路：零时延发射告警，主执行线不阻塞
                if SmartClassifier::is_redline_command(&cmd) {
                    emit_security_audit(&cmd, SecurityAuditDecision::ExecutedWithWarning);
                    event_bridge.emit("notification", serde_json::json!({
                        "level": "critical_warning",
                        "title": "完全允许模式高危执行警示",
                        "message": format!("正在以完全允许模式执行极端高危命令：{cmd}"),
                        "command": cmd,
                    })).await.ok();
                }
            });
        }
        return PermissionVerdict::Allow;
    }

    // Smart 与 Ask 模式裁决
    if let Some(cmd) = extract_command_str(&call.input) {
        match SmartClassifier::classify(&cmd) {
            SmartVerdict::SafeAutoAllow => PermissionVerdict::Allow,
            SmartVerdict::NeedsApproval(_) => {
                // 检查回退护栏或直接审批
                PermissionVerdict::NeedsApproval
            }
            SmartVerdict::Deny { .. } => PermissionVerdict::Deny, // 仅在 Smart/Ask 阻断 Redline
        }
    } else {
        let is_dangerous = self.registry.get(&call.tool_name).map(|t| t.definition().dangerous).unwrap_or(false);
        if mode == PermissionMode::Ask && is_dangerous {
            PermissionVerdict::NeedsApproval
        } else {
            PermissionVerdict::Allow
        }
    }
}
```

---

### 4.3 批次三：测试套件重写与纠偏落地

1. 替换 `tests/e2e/ui-store-invariants.spec.ts` 3 处断言；
2. 替换 `apps/crish-desktop/src/store/permissionStore.test.ts`（见 §3.2 代码）；
3. 替换 `apps/crish-desktop/src/api/permissionModes.test.ts`（见 §3.2 代码）；
4. 替换 `crates/agent-tools/src/revert.rs` 与 `permission.rs` 纠偏单测；
5. 替换 `crates/session-loop/src/tool_exec_tests/revert.rs` 纠偏集成测试；
6. 追加 `crates/conex-run/tests/subagent_permission_test.rs` 子代理继承测试。

---

### 4.4 批次四：全量验证流水线执行命令表（统一 pwsh7）

执行以下标准化验证套件，确保每一步零破坏：

```powershell
# 1. 编译与类型检查
pwsh -NoProfile -Command "npm run typecheck"
pwsh -NoProfile -Command "cargo check --workspace"

# 2. 前端单测门禁（快层覆盖率 45/70/65/45）
pwsh -NoProfile -Command "npm run test:coverage -- --project=unit"

# 3. 前端全量单元测试
pwsh -NoProfile -Command "npm run test"

# 4. Rust 引擎全量测试套件（73+ 套件全绿）
pwsh -NoProfile -Command "cargo test --workspace"

# 5. E2E 防污染套件与全旅程验证
pwsh -NoProfile -Command "npx playwright test tests/e2e/ui-store-invariants.spec.ts"
pwsh -NoProfile -Command "npx playwright test tests/e2e/full-journey.spec.ts"

# 6. 工程与代码规范终审
pwsh -NoProfile -Command "npm run check:desktop"
```

---

## 五、风险应急与回滚保障机制

1. **共享 Git Index 提交保护**：根据 `AGENTS.md` §3，子代理严禁提交，全部改动保留在工作区，主控 Agent 验收无误后统一执行 `git commit --only <paths...>` 限定路径收口；
2. **分支回滚隔离**：重构在独立战役工作区推进，任何偶发异常通过精确局部恢复，严禁使用 `git reset --hard`；
3. **分层验证卡点**：每完成一个批次即跑通对应门禁命令，若阶梯一未全绿严禁推进阶梯二，确保全过程零 CI Breakage。

---
*详案编制完毕。本方案与《00-总方案》共同构成全战役最终实施的双核驱动引擎。*
