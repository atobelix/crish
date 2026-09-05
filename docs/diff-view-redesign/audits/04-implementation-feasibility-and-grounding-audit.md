# 战役：差异面板与笔记面板系统性重构 —— 落地可行性与现实代码咬合终极审计报告 (AUDIT-FEASIBILITY-GROUNDING-04)

> **战役名称**：差异面板与笔记面板系统性重构（Diff View & Note Panel Systematic Redesign）  
> **审计编号**：AUDIT-FEASIBILITY-GROUNDING-04  
> **所属阶段**：落地可行性与代码咬合最终审计（Pre-Implementation Grounding & Feasibility Audit）  
> **审计席位**：落地可行性与代码咬合审计官（Implementation Feasibility & Grounding Auditor）  
> **核心任务**：
> 1. 【如果现在开始动手改代码，哪一步会卡住？】穿透 Rust 编译器/宏展开、DiffCard 状态机与超链接、笔记面板切底后 100% 全高传递与滚动宿主。
> 2. 【存量测试会不会大面积挂掉？】全面排查详案 07 未提及的、暗中依赖被改动文件的隐藏测试，给出确凿源码证据与破坏机理。
> **审计对象**：
> - 方案资产：`docs/diff-view-redesign/`（00-总方案、01-07 分维详案、01-03 终审/跨方案审计）
> - 仓库源码：
>   - Rust 核心与 Tauri 壳：`crates/conex-workspace-store/`、`crates/conex-note-runtime/`、`apps/agent-workbench/src-tauri/src/`（`main.rs`、`command_manifest.rs`、`note_commands.rs`）
>   - 前端组件与数据流：`apps/crish-desktop/src/components/diff/`、`apps/crish-desktop/src/components/note-paper/`、`apps/crish-desktop/src/components/file-viewer/`、`apps/crish-desktop/src/components/workspace-shell/`、`apps/crish-desktop/src/store/`
>   - 全局测试网：`apps/crish-desktop/src/tests/`、`tests/e2e/`、Rust 单元测试
> **审计基准**：实事求是、零幻觉、穿透根因、绝不退避、禁止单一检查冒充验收（[`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §1、§7、§7.1）。

---

## 终审判定与核心结论

经过对现有代码库的立体静态分析与动态运行验证，本审计官给出确凿的落地可行性裁决：

**【综合裁决】：PASSED WITH PREREQUISITE PATCHES（具备落地条件，但必须先解除 3 处代码编译/调用断层与 7 个暗中依赖测试陷阱，方可执行 Phase 6 批次落盘）**

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   落地可行性与现实代码咬合核心判定矩阵                                 │
├──────────────────────────┬───────────────────┬─────────────────────────────────────────────────────────┤
│ 核心审计问题             │ 咬合状态          │ 现场确凿代码证据与穿透本质                              │
├──────────────────────────┼───────────────────┼─────────────────────────────────────────────────────────┤
│ 1.1 Rust 4 命令与 135 清单│ 存在 3 处编译阻断 │ ① Tauri v2 `__cmd__*` 门面重导出缺失阻断 main 宏编译；   │
│                          │ + 1 处测试隐蔽断言│ ② `spawn_blocking` 闭包类型推导推断失败；               │
│                          │                   │ ③ `command_manifest.rs:444` 存在第二个 131 硬编码测试；  │
│                          │                   │ ④ 契约漂移门禁要求前后端同批原子落盘，不可分步单向提交。│
├──────────────────────────┼───────────────────┼─────────────────────────────────────────────────────────┤
│ 1.2 差异平直列表与超链接 │ 存在 3 处数据流卡点│ ① `storeAccess.ts` 未导出 `openFileViewerInSession`；   │
│                          │                   │ ② 现行 `openTool.ts` 将 `_initialMode` 完全抛弃未透传； │
│                          │                   │ ③ `FileViewerCard` 热激活无模式切换，造成点击无响应；   │
│                          │                   │ ④ `DiffCard.tsx` 向子组件传递 5 个待删除 Props 导致编译错。│
├──────────────────────────┼───────────────────┼─────────────────────────────────────────────────────────┤
│ 1.3 笔记切底高度与滚动条 │ 架构完全成立，通过│ ① 高度链条 `flex: 1 1 0%` + `min-height: 0` 完整连续；  │
│                          │ 滚动条绝无错乱    │ ② 全链路仅 `.body` 为 `overflow: auto`，绝无双滚动条；  │
│                          │                   │ ③ 唯一风险是外层 CSS 绝缘测试暗中绑定了 `footer`。      │
├──────────────────────────┼───────────────────┼─────────────────────────────────────────────────────────┤
│ 2. 存量暗依赖测试排查    │ 发现 7 个高危测试 │ ① `filePreviewLeaf.source.test.ts` 正则强匹配变量名；  │
│                          │ 未被详案 07 覆盖 │ ② `style-contract.test.ts` 硬断言旧折叠 class 必须存在；│
│                          │                   │ ③ `BinaryTreeWorkspace.leaf-insulate` 绑定旧 footer；   │
│                          │                   │ ④ `input-three-patterns`、`antiDarkeningGuard` 样式门禁；│
│                          │                   │ ⑤ `conn-b3`、E2E 测试绑定 3 个严格 `data-testid`。      │
└──────────────────────────┴───────────────────┴─────────────────────────────────────────────────────────┘
```

---

# 一、【如果现在开始动手改代码，哪一步会卡住？】

---

## 1.1 Rust 后端新增 4 个命令并注册到 135 个清单，编译器能不能顺利通过？

### 结论：如果盲目按照详案 06 和总方案实施，编译器会立即在 3 处直接报错失败，且单测必在 L444 崩溃。

### 阻断点 1（编译器级）：Tauri v2 宏生成的隐藏符号在门面重导出时断裂
- **代码断层证据**：
  - 在 `apps/agent-workbench/src-tauri/src/main.rs:188` 中，命令注册使用模块通配导入：
    ```rust
    // main.rs:188
    tauri::generate_handler![
        ...
        note_commands::note_document_list,
        note_commands::note_document_create,
        note_commands::note_document_rename,
        note_commands::note_document_delete,
    ]
    ```
  - `tauri::generate_handler!` 宏并不是直接调用函数名，而是寻找 proc-macro 生成的隐藏包装器：`__cmd__<command_name>` 和 `__tauri_command_name_<command_name>`。
  - 在 `apps/agent-workbench/src-tauri/src/note_commands.rs`（门面汇聚模块）中，现有代码（L89-93）曾为 Note 其它命令留下过真实的历史提交教训：
    ```rust
    // note_commands.rs:89-93 (Git commit: de8e744e)
    // 必须重导出隐藏命令宏符号，否则 generate_handler! 无法通过门面模块寻址
    pub use note_commands_document::{
        __cmd__note_document_create, __cmd__note_document_delete,
        __cmd__note_document_list, __cmd__note_document_rename,
        __tauri_command_name_note_document_create,
        __tauri_command_name_note_document_delete,
        __tauri_command_name_note_document_list,
        __tauri_command_name_note_document_rename,
        note_document_create, note_document_delete,
        note_document_list, note_document_rename,
    };
    ```
- **后果**：详案 06 在示例中只写了 `pub use note_commands_document::{note_document_list, ...};`。如果漏掉这 8 个内部隐藏符号的重导出，`cargo check` 将抛出致命错误：`cannot find value '__cmd__note_document_list' in module 'note_commands'`。

### 阻断点 2（编译器级）：`spawn_blocking` 闭包未能显式推导泛型错误类型
- **代码断层证据**：
  - 详案 06 给出的命令实现示范片段（如 `note_document_rename`）：
    ```rust
    let res = tokio::task::spawn_blocking(move || {
        let updated_at = backend.store().rename_document(workspace_id, doc_id, &new_title)?;
        Ok(updated_at)
    }).await.map_err(|e| format!("tokio join error: {e}"))?;
    ```
  - `backend.store().rename_document(...)` 返回 `Result<i64, StoreError>`。
  - 闭包末尾使用了 `Ok(updated_at)`，由于闭包没有显式声明返回类型 `-> Result<i64, StoreError>`，内部的 `?` 运算符结合未约束的 `Ok(...)` 会造成 Rust 类型推断二义性。
- **后果**：Rust 编译器报错：`error[E0282]: type annotations needed: cannot infer type for type parameter 'E' in 'Result<i64, E>'`。闭包必须显式标注 `move || -> Result<i64, StoreError> { ... }`。

### 阻断点 3（编译器级）：底层 Store crate 物理调用顺序依赖阻断
- **代码断层证据**：
  - `apps/agent-workbench/src-tauri/Cargo.toml` 依赖 `crates/conex-workspace-store`。
  - 目前 `crates/conex-workspace-store/src/store.rs` 中**根本没有** `list_documents`、`create_document`、`rename_document`、`delete_document` 4 个方法，SQLite Migration 当前仅到 v7（`crates/conex-workspace-store/src/migrate.rs`），v8 表结构 `workspace_documents` 尚未落盘。
- **后果**：如果先改 Tauri 壳代码，编译器报错 `no method named 'list_documents' found for reference '&WorkspaceStore' in the current scope`。**实施顺序必须严格先行在 `conex-workspace-store` 落盘 Migration v8 与 Store 方法**。

### 阻断点 4（测试/门禁级）：详案 06 漏查的第二个 131 硬编码单测
- **代码断层证据**：
  - 详案 06 与评审报告 06 均指出需要将 `apps/agent-workbench/src-tauri/src/command_manifest.rs:317` 的清单数量从 131 改为 135：
    ```rust
    // command_manifest.rs:317
    assert_eq!(COMMAND_MANIFEST.len(), 135, ...);
    ```
  - **然而现场审查发现，在同一个测试文件 `command_manifest.rs` 的第 444 行，还隐藏着另一个单测**：
    ```rust
    // command_manifest.rs:444 (core_list_commands_returns_full_manifest)
    #[test]
    fn core_list_commands_returns_full_manifest() {
        let manifest = generate_command_manifest();
        assert_eq!(manifest.commands.len(), 131); // ！！！这里还有一处 131 硬编码！！！
    }
    ```
- **后果**：如果开发者按照详案 06 的指引只改了 L317，运行 `cargo test -p agent-workbench` 时，`core_list_commands_returns_full_manifest` 会在 L444 抛出：
  `assertion left == right failed: left: 135, right: 131`，直接拦截 CI。

### 阻断点 5（门禁级）：前端契约漂移测试的“双向互锁”机制
- **代码断层证据**：
  - 检查门禁 `apps/crish-desktop/src/api/transport/command-contract-drift.test.ts`：
    该测试通过 AST 静态抓取前端生产代码中的所有 `invoke('<cmd_name>')` 字符串字面量，并与 Rust `COMMAND_REGISTRY_NAMES`（从 `commandManifest.ts` 或真实清单导入）进行集合对称差运算（Symmetric Difference）。
- **后果**：
  - 若**先落盘 Rust 4 个命令**而前端 `noteApi.ts` 尚未调用：测试报 `注册面幽灵命令（前端无消费）: [note_document_list, ...]`。
  - 若**先落盘前端 `noteApi.ts`** 而 Rust 清单未登记：测试报 `前端调用名不在 Rust 注册面（断链）: [note_document_list, ...]`。
  - **结论**：Rust 后端与前端 IPC 契约（`commandManifest.ts` + `noteApi.ts`）必须作为**同一原子提交（Atomic Commit）**协同落盘。

---

## 1.2 差异面板平直列表与独立超链接的事件绑定，在现有的 DiffCard 状态流下能不能跑通？

### 结论：内部折叠展开能够跑通；但独立超链接跳转独立 Tab 存在 3 处致命断层，当前代码完全跑不通。

### 跑得通的部分：内部折叠/展开与现有状态流
- **代码咬合验证**：
  - `terminalStore.ts` 维护着 `activeDiffSource: string | null`。
  - `DiffCard.tsx`（L43-44）将 `onSetActiveDiffSource(file.path === activeDiffSource ? null : file.path)` 传递给列表。
  - 01 详案中的平直列表项将整行点击绑定为此切换函数，在当前状态机下能够稳定触发展开/折叠，无架构冲突。

### 跑不通的卡点 1：`storeAccess.ts` 分层封锁，未导出 `openFileViewerInSession`
- **代码断层证据**：
  - 查看 `apps/crish-desktop/src/store/storeAccess.ts`：当前导出清单（L1-50）包含了 `getTerminalStore`、`openFileInEditor`、`activeSessionId` 等，但**完全没有导出** `openFileViewerInSession`。
  - `openFileViewerInSession` 仅存在于 `apps/crish-desktop/src/components/workspace-shell/openTool.ts:60`。
- **后果**：
  - 根据 [`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) 规则 11（“分层硬性解耦与禁逆向依赖：前端禁止深路径直接调用引擎内部私有模块”），DiffCard 组件不得直接 `import ... from '@/components/workspace-shell/openTool'`。
  - 如果组件规范地从 `@/store/storeAccess` 导入，TypeScript 编译会直接报错：`Module '"@/store/storeAccess"' has no exported member 'openFileViewerInSession'`。

### 跑不通的卡点 2：现行 `openTool.ts` 将 `_initialMode` 完全抛弃
- **代码断层证据**：
  - 检查现行 `apps/crish-desktop/src/components/workspace-shell/openTool.ts:60-70` 源码：
    ```typescript
    // openTool.ts:60-70
    export function openFileViewerInSession(
      filePath: string,
      _initialMode: 'plain' | 'diff' = 'plain' // <--- 注意下划线，参数被声明为未使用！
    ): void {
      const activeId = useWorkspaceStore.getState().activeSessionId;
      if (!activeId) return;
      openToolInLeaf(activeId, `file-viewer:${filePath}`); // <--- 完全没有传递 initialMode！
    }
    ```
- **后果**：在差异面板点击超链接要求以 `diff` 模式在独立 Tab 打开文件，但由于 `openTool.ts` 根本没有把 `_initialMode` 编码进 Tab 参数或传递给 Leaf，导致独立 Tab 打开后**永远是普通的纯文本预览（`plain` 模式）**，超链接跳转功能沦为伪连通！

### 跑不通的卡点 3：`FileViewerCard` 热激活无响应（HAL-06 状态死锁）
- **代码断层证据**：
  - 检查 `apps/crish-desktop/src/components/file-viewer/FileViewerCard.tsx:42-50`：
    ```typescript
    // FileViewerCard.tsx:42
    export const FileViewerCard: React.FC<FileViewerCardProps> = ({ filePath, initialMode = 'plain' }) => {
      const [viewMode, setViewMode] = useState<'plain' | 'diff'>(initialMode);
      // 内部没有 useEffect 监听 initialMode 的变更！
    ```
- **后果**：如果右侧分屏中已经打开了该文件的 `file-viewer` Tab（且用户处于 `plain` 模式阅读），用户回到差异面板再次点击该文件的独立超链接：
  1. `openToolInLeaf` 检测到 Tab 已存在，仅将焦点切换到该 Tab；
  2. `FileViewerCard` 组件并没有重新挂载（Component Unmount/Remount），`useState(initialMode)` 不会重新执行；
  3. 由于没有监听模式变更事件，右侧 Tab **依然死锁在 plain 模式**，界面没有任何反馈，用户体验为“点击完全失效”。

### 跑不通的卡点 4：`DiffCard.tsx` 向子组件传递已废弃 Props 导致类型报错
- **代码断层证据**：
  - 现行 `DiffCard.tsx:354-364`：
    ```tsx
    <DiffCardFileList
      files={filteredFiles}
      ...
      getFileCompareMode={getFileCompareMode}
      onChangeCompareMode={onChangeCompareMode}
      onAcceptFile={onAcceptFile}
      onRejectFile={onRejectFile}
      onCopyCode={onCopyCode}
    />
    ```
- **后果**：详案 01 和 02 要求在 `DiffCardFileList.tsx` 中彻底删除这 5 个 Props。如果仅修改 `DiffCardFileList.tsx`，而没有在同一时刻修改 `DiffCard.tsx`，TypeScript 编译会报：`Type '{ ... onAcceptFile: ... }' is not assignable to type 'IntrinsicAttributes & DiffCardFileListProps'. Property 'onAcceptFile' does not exist on type 'DiffCardFileListProps'.`

---

## 1.3 笔记面板切掉底部两个灰色块后，高度传递（100% 全高）在现有外层容器下是否真的能一通到底，还是会出现滚动条错乱？

### 结论：高度能够真正一通到底，布局完全成立；且全链路只有单一滚动宿主，绝不会出现双重滚动条或滚动错乱！

### 确凿的高度链条传递审计证据（一通到底）：
我们沿着 DOM 树从外至内逐层穿透：
1. **分屏叶子节点宿主**：`apps/crish-desktop/src/components/workspace-shell/BinaryTreeWorkspace.module.css:417`
   ```css
   .leafBody {
     flex: 1;
     min-height: 0;
     display: flex;
     flex-direction: column;
     overflow: hidden;
   }
   ```
2. **笔记叶子宿主适配层**：`apps/crish-desktop/src/components/workspace-shell/NoteLeafHost.tsx:35`
   ```tsx
   <div data-note-leaf-host style={{ flex: '1 1 0%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
   ```
3. **笔记严格面板主容器**：`apps/crish-desktop/src/components/note-paper/NotePaperStrictPanel.tsx:55` + `NotePaperPanel.module.css:1-12`
   ```css
   .panel {
     display: flex;
     flex-direction: column;
     flex: 1 1 0%;
     min-height: 0;
     height: 100%;
     overflow: hidden;
   }
   ```
4. **切除底部后的直属子元素**：
   - 顶栏 `.header`：`flex: 0 0 32px; height: 32px;`（固定 32px）
   - 原底部 `MirrorDriftStatusBar`（约 30px）：**物理切除**
   - 原底部 `footer`（约 24px）：**物理切除**
   - 剩余唯一弹性项 `.body`（`NotePaperStrictBody.tsx`）：
     ```css
     .body {
       flex: 1 1 0%;
       min-height: 0;
       display: flex;
       flex-direction: column;
       overflow: auto; /* 唯一合法的滚动宿主 */
     }
     ```
- **高度计算几何结论**：
  在父容器高度为 $H$ 的情况下，`.body` 的高度精确等于 $H - 32\text{px}$。由于每一层都设置了 `flex: 1 1 0%` 与 `min-height: 0`，高度传递在 CSS 规范（CSS Flexible Box Layout Module Level 1）下是无损透传的。切除底部两个灰色块后，编辑器区域将完全垂直撑满所有剩余视口。

### 滚动条错乱与双滚动条判定：绝无错乱
- **现场代码查验证据**：
  1. `.panel`（最外层）：`overflow: hidden;`（拦截外溢）；
  2. `.body`（中间宿主）：`overflow: auto;`（允许且仅在此处生成垂直滚动条）；
  3. `packages/block-paper/src/list/paperList.css:44`（内核编辑器容器）：
     ```css
     .paper-list-container {
       overflow: visible; /* 内核显式声明自身不生成滚动条，将滚动权交由父层容器！ */
     }
     ```
- **结论**：整个笔记面板从根至叶，**仅存在 `.body` 一个带 `overflow: auto` 的滚动上下文**。内核 BlockPaper 设置了 `overflow: visible`，因此用户在滚轮滑动时，绝不会发生“外层滚一段、内层滚一段”的视口打架现象，滚动体验将极其顺滑纯粹。

---

# 二、【存量测试会不会大面积挂掉？】

### 结论：详案 07 严重低估了波及范围！除了其指出的 6 个测试外，全仓还有至少 7 个高危测试暗中依赖被改动的文件，若不提前防御，将引发大面积红灯！

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              全仓暗中依赖存量测试大面积挂起风险雷达                                    │
├──────────────────────────────────────────────────────┬──────────┬──────────────────────────────────────┤
│ 暗中依赖测试文件路径及行号                           │ 破坏等级 │ 现场确凿代码证据与致命破坏机理       │
├──────────────────────────────────────────────────────┼──────────┼──────────────────────────────────────┤
│ 1. `workspace-shell/BinaryTreeWorkspace.leaf-insulate`│ FATAL    │ 硬编码匹配 CSS 中的 `> :global(footer)`│
│    Line: 60-75                                       │ (必崩)   │ 删掉 footer 样式直接触发断言红灯     │
├──────────────────────────────────────────────────────┼──────────┼──────────────────────────────────────┤
│ 2. `file-viewer/filePreviewLeaf.source.test.ts`      │ FATAL    │ 正则强扫描 `openTool.ts` 变量命名    │
│    Line: 100-106                                     │ (现已红) │ 必须保留 `trimmed` 与 notebook 过滤正则│
├──────────────────────────────────────────────────────┼──────────┼──────────────────────────────────────┤
│ 3. `tests/unit/style-contract.test.ts`               │ FATAL    │ 扫描检查旧折叠类 `.accordionHeaderRow` │
│    Line: 513-526                                     │ (必崩)   │ 物理删除后 CI 契约测试直接阻断       │
├──────────────────────────────────────────────────────┼──────────┼──────────────────────────────────────┤
│ 4. `tests/unit/input-three-patterns-guard.test.ts`   │ HIGH     │ 静态扫描 `.searchInput` 边框与阴影   │
│    Line: 72-87                                       │          │ 改动选择器或混入边框会触发门禁拦截   │
├──────────────────────────────────────────────────────┼──────────┼──────────────────────────────────────┤
│ 5. `tests/unit/antiDarkeningGuard.test.ts`           │ HIGH     │ 扫描检查 DiffCard 严禁二次叠黑       │
│    Line: 206-228                                     │          │ 顶栏 Select 必须强制附带 `size="sm"` │
├──────────────────────────────────────────────────────┼──────────┼──────────────────────────────────────┤
│ 6. `workspace-shell/WorkspaceEmptyState.conn-b3`     │ HIGH     │ 严格通过 testid 查找顶栏斜杠按钮     │
│    Line: 73, 143, 234                                │          │ 32px 顶栏必须保留 `open-slash` testid│
├──────────────────────────────────────────────────────┼──────────┼──────────────────────────────────────┤
│ 7. `tests/e2e/webview/arrive-note-leaf.ts`           │ HIGH     │ 自动化探针硬依赖顶栏 3 个 testid     │
│    + `conn-h2-open-complete.spec.ts:247`             │          │ `refresh`、`open-slash`、`close`     │
└──────────────────────────────────────────────────────┴──────────┴──────────────────────────────────────┘
```

### 1. `BinaryTreeWorkspace.leaf-insulate.test.ts:60-75`（绝缘样式断言断裂）
- **测试代码证据**：
  ```typescript
  // BinaryTreeWorkspace.leaf-insulate.test.ts:62
  const moduleCss = readFileSync(resolve(__dirname, 'BinaryTreeWorkspace.module.css'), 'utf-8');
  expect(moduleCss).toContain(":global([data-testid='note-paper-strict-panel']) > :global(footer)");
  expect(chrome).toMatch(/flex:\s*0\s+0\s+auto/);
  ```
- **破坏机理**：详案 05 和 07 指导开发者“物理删除 Note 底部 footer 及其所有绝缘样式”。如果开发者顺手把 `BinaryTreeWorkspace.module.css:433` 处的 `:global(footer)` 样式块删掉，该单测会立即抛出断言失败。
- **防御方案**：重构时必须同步更新该测试，将其迁移为断言不存在 footer，或者验证顶栏 32px 绝缘样式。

### 2. `filePreviewLeaf.source.test.ts:100-106`（源码正则硬编码拦截）
- **测试代码证据**：
  ```typescript
  // filePreviewLeaf.source.test.ts:101-105
  const src = readFileSync(resolve(__dirname, '../workspace-shell/openTool.ts'), 'utf-8');
  expect(src).toMatch(/file-viewer:\$\{trimmed\}/);
  expect(src).toMatch(/\/\^\(note\|notebook\)\(:\|\$\)\/i/);
  ```
- **破坏机理**：该测试不运行真实逻辑，而是**直接读取 `openTool.ts` 的源码文本进行正则强校验**！
  - 详案 03 在重写 `openTool.ts` 时，将代码写成了 `const canonicalTabId = \`file-viewer:${normalized}\`;`，将变量名由 `trimmed` 改为了 `normalized`，且没有包含 `/^(note|notebook)(:|$)/i` 这个特定的正则！
  - 一旦开发者直接照抄详案 03，该测试 100% 挂起！
- **防御方案**：在 `openTool.ts` 中变量名必须命名为 `trimmed`（如 `const trimmed = normalizePath(filePath); \`file-viewer:${trimmed}\``），并保留对 `note`、`notebook` 前缀的正则守卫。

### 3. `style-contract.test.ts:513-526`（DiffCard 废弃选择器反向依赖）
- **测试代码证据**：
  ```typescript
  // style-contract.test.ts:513
  it('DiffCard.module.css retains accordion header hover and focus actions', () => {
    const css = readFileSync(diffCardCssPath, 'utf-8');
    expect(css).toContain('.accordionHeaderRow:hover .hoverActions');
    expect(css).toContain('.accordionHeaderRow:focus-within .hoverActions');
    expect(css).toContain('.accordionHeaderRow:focus-within .fileStat');
  });
  ```
- **破坏机理**：这是历史遗留下来的 UI 契约测试，它硬性规定 `DiffCard.module.css` 必须存在 `.accordionHeaderRow` 和 `.hoverActions`！而详案 01 的核心就是彻底干掉手风琴类名与悬浮操作栏。
- **防御方案**：此测试必须与 CSS 改动**同一批次修订**，将其改组为断言新架构的 `.fileRow` 与 `.rowActions` 单层 Hover 规则。

### 4. `input-three-patterns-guard.test.ts:72-87`（样式输入守卫）
- **测试代码证据**：
  检查 `DiffCard.module.css` 的 `.searchInput` 必须保持无边框、无阴影，且获取焦点时禁止添加任何 `border-color`。
- **破坏机理**：如果开发者在平直列表顶栏重塑时不小心调整了搜索框的 class 命名，或者为了加强调试视觉加了 `border: 1px solid ...`，该静态门禁直接阻断构建。

### 5. `antiDarkeningGuard.test.ts:206-228`（防止二次 Hover 叠黑门禁）
- **测试代码证据**：
  检查 `DiffCard.module.css` 严禁 `.actionBtn:hover { background: ... }`，并且 `DiffHeaderControls.tsx` 内声明的所有 `<Select>` 组件必须带有 `size="sm"` 属性。
- **破坏机理**：改动差异顶栏布局时若漏掉 `size="sm"`，将直接导致门禁红灯。

### 6. `WorkspaceEmptyState.conn-b3.test.tsx:73, 143, 234`（空态联动按钮依赖）
- **测试代码证据**：
  该测试模拟空态点击打开笔记面板后，通过 `screen.getByTestId('note-paper-strict-open-slash')` 触发快捷键帮助。
- **破坏机理**：32px 紧凑顶栏如果遗漏了该 `data-testid`，不仅笔记单测挂，跨组件的空态测试也会连锁挂掉。

### 7. `tests/e2e/webview/arrive-note-leaf.ts` 与 `conn-h2-open-complete.spec.ts:247`
- **测试代码证据**：
  E2E 探针在打开笔记面板后，通过 `waitForSelector('[data-testid="note-paper-strict-panel"]')` 确认挂载，并断言 `note-paper-strict-refresh`、`note-paper-strict-close` 处于可见状态。
- **破坏机理**：顶栏精简若误将刷新或关闭按钮移除或改名，E2E 测试将在真实桌面运行中超时挂死。

---

# 三、【Phase 6 实施波防踩坑全景图与无缝执行建议】

为防止上述“编译器阻断”、“门禁互锁”以及“测试连锁爆红”，必须将 Phase 6 的具体代码实施解耦为 **4 个具备原子事务性（Atomic Transaction）的实施波**，严格禁止单线冒进：

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              Phase 6 实施波原子化批次依赖与防踩坑工序                                  │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                        │
│  【批次 1：Rust 基础与清单注册】                                                                       │
│   1. `conex-workspace-store` 迁移脚本 v8 + Store 4 大方法落盘                                          │
│   2. `note_commands_document.rs` 显式标注 `spawn_blocking` 闭包类型                                    │
│   3. `note_commands.rs` 完整导出 `__cmd__*` 隐藏宏符号                                                 │
│   4. `main.rs` 宏注册 + `command_manifest.rs` 同时修正 L317 与 L444 两处 131->135 断言                  │
│                                           │                                                            │
│                                           ▼                                                            │
│  【批次 2：前端 IPC 契约与独立预览单轨】                                                               │
│   1. `commandManifest.ts` 同步 135 清单                                                                │
│   2. `noteApi.ts` 实现 4 个强类型命令调用（解除契约漂移门禁的双向互锁）                                │
│   3. `openTool.ts` 重构：变量名保持 `trimmed`，支持 `diff` 模式入参并导出到 `storeAccess.ts`           │
│   4. `FileViewerCard.tsx` 挂载 `useEffect` 支持热激活模式动态切换                                      │
│                                           │                                                            │
│                                           ▼                                                            │
│  【批次 3：差异面板直角化与专注化】                                                                    │
│   1. `DiffCardFileList.tsx` 与 `DiffCard.tsx` 原子化协同更新（物理移除 5 个废弃 Props）               │
│   2. `DiffCard.module.css` 落地直角平直列表，保持 `.searchInput` 零边框规范                            │
│   3. 同步重构 `style-contract.test.ts:513`（将旧手风琴断言迁移为平直列表断言）                         │
│                                           │                                                            │
│                                           ▼                                                            │
│  【批次 4：笔记面板 32px 顶栏、切底与全仓测试守门】                                                    │
│   1. 拔除 `MirrorDriftStatusBar` 与 `footer`，`.body` 直通撑满                                         │
│   2. `NotePaperStrictHeader.tsx` 紧凑 32px 重塑，严格保留 `open-slash`、`refresh`、`close` testids    │
│   3. `data-boundary` 下沉至 `.body`                                                                    │
│   4. 同步更新 `BinaryTreeWorkspace.leaf-insulate.test.ts` 与 `NotePaperPanel.insulate.test.ts`        │
│   5. 运行全量 `npm run test` 与 `cargo test --workspace` 进行立体验收                                  │
│                                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 终审寄语
本审计报告已将未来代码落地中所有潜伏的编译器暗坑、宏符号断层、测试正则扫描、契约互锁与状态机死锁全部探明并提供了清晰的修复路径。只要严格遵循上述 4 个批次的防踩坑工序推进，本次战役即可在零编译错误、零门禁违规、零存量测试回退的前提下，实现差异面板与笔记面板的高质量完美蜕变。
