# W5-A · 双引擎 surface 分界可执行规格

| 元数据             | 值                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| **状态**           | **已钉死**（实现波可执行；W5-A 规格交付）                                                         |
| **效果锁**         | **EL-08**：行级流式 ∥ 块纸面；模型不混                                                            |
| **权威来源**       | `15-评审后锁定修订.md` EL-08；`plans/07-双引擎与本仓衔接.md`；E1 V4 / A-INV-03；用户裁决          |
| **主责 Wave**      | **W5-A**（本文）→ **W5-B** 挂载 → **W5-C** 架构隔离测 → **W5-D** 跨层联测                         |
| **依赖**           | W3 块纸面可嵌入；行级 `reference/markdown-editor` 已存在；`@crish/editor-kit` W3-A/B 骨架         |
| **文件域（规格）** | **仅** 本文 + 可选 `19-实现波调度状态.md` 指针                                                    |
| **文件域（实现）** | 见 §8 / §9；**保护** `reference/markdown-editor` 测试资产（禁止删除 unit/e2e 专项）               |
| **禁止**           | 行级当局笔记；静默缝合流式进块树；共享 Doc store / yrs 句柄 / PM 整树；用行级打开笔记工作区当终局 |

---

## 0. 结论先行（一句话）

> **两个 surface、两套数据模型、零共享权威**——`chat` 以 `lines[]` 行缓冲服务 AI 流式；`note-paper` 以 RS `BlockTree` + 单一 `Transaction.apply` 服务笔记；完成态仅经显式 **`send_to_note`** Intent/工具写入块树，**禁止**静默缝合。纪律可共享（IME / 虚拟列表类型 / 渲染件），真相形状不可共享。

```
┌─ surface=chat ──────────────────┐     ┌─ surface=note-paper ──────────────┐
│ lines[] + 行 AST / offset 树    │     │ BlockTree (RS) + 叶子 YText(yrs)  │
│ 消息/流式缓冲 store（本地）     │     │ DocSession 唯一 apply             │
│ 虚拟行窗口（行级实现）          │     │ 块窗口 + HeightMap + pin          │
│ 叶子输入：行级 HiddenInput…     │     │ 叶子：裸 PM / CM6（仅活动叶）     │
└──────────────┬──────────────────┘     └────────────────┬──────────────────┘
               │                                         │
               │  显式 send_to_note / apply_md / insert   │
               └──────────── 桥（单向意图） ─────────────┘
                          ▲
                          │ 禁止反向：块树写回 lines[] 当局
                          │ 禁止共享：Doc store / yrs / PM 整树

共享（editor-kit / 渲染件）：IME 守卫思想 · 虚拟列表工具类型 · 公式/代码渲染件
```

---

## 1. Surface 定义

| Surface ID       | 产品定位                                  | 运行时宿主（实现落点）                             | 权威写路径                                    |
| ---------------- | ----------------------------------------- | -------------------------------------------------- | --------------------------------------------- |
| **`chat`**       | 聊天历史、AI 流式输出、源码向 MD          | `reference/markdown-editor` + Workbench 会话消息面 | **仅**本地消息缓冲 / 会话事件；**非**笔记 Doc |
| **`note-paper`** | 工作区笔记、块操作、协同、Agent 块 mutate | `packages/block-paper/**` + RS `conex-doc-collab`  | **仅** `DocSession.apply`（Op / apply_md…）   |

### 1.1 枚举契约（实现须可引用）

```ts
/** 编辑呈现面；禁止用 string 魔法值串门 */
type EditorSurface = 'chat' | 'note-paper';
```

| 规则                      | 说明                                                         |
| ------------------------- | ------------------------------------------------------------ |
| **标注强制**              | 新建模块/包入口须标注所属 surface（注释或 `surface` 常量）   |
| **焦点域**                | 同窗可并存两 surface；快捷键/IME 只服务 **当前焦点 surface** |
| **禁止第三 surface 冒充** | 预览 HTML、工具卡片渲染 ≠ 新权威面；不得引入第三条写路径     |

### 1.2 职责对照（关闭「行级当局」）

| 维度           | `chat`                                     | `note-paper`                                    |
| -------------- | ------------------------------------------ | ----------------------------------------------- |
| **数据模型**   | `lines[]`（+ 行 offset 树 / 行 AST 投影）  | `BlockTree` + `BlockId` + 叶文本槽              |
| **持久化**     | 消息/会话存储；**禁止**当笔记 SQLite 权威  | rusqlite snapshot+updates；MD mirror 为契约视图 |
| **协同**       | 无文档级 CRDT 权威                         | RS 合并；yrs 句柄 **crate 私有**                |
| **Agent**      | 流式 token 进行缓冲；完成态可选发笔记      | 笔记工具 / Op；**禁止**改 DOM                   |
| **流式 token** | **允许** 高频 append（行级快路径）         | **禁止** 每 token `doc_apply_ops`               |
| **undo**       | 行级本地栈（流式策略可独立）               | 文档 undo 只打 RS                               |
| **MD 管线**    | `pulldown-cmark` / `conex-markdown` → HTML | BlockIR + Conex-MD + `markdown-rs` P/S          |

---

## 2. 数据模型边界

### 2.1 `chat`：`lines[]` 世界

| 概念                  | 定义                                                       | 可否出 surface                                              |
| --------------------- | ---------------------------------------------------------- | ----------------------------------------------------------- |
| **`lines: string[]`** | 行级引擎主缓冲；逻辑索引 = 全局字符偏移（+ 行 offset 树）  | **否** 作为笔记权威                                         |
| **行 AST / token**    | 解析投影，服务渲染与 `data-token-*` 映射                   | 可只读导出 MD 字符串                                        |
| **消息 store**        | 会话气泡、流式中/完成态消息体；可含 `surface: 'chat'` 标注 | 会话层可持久；**≠** DocSession                              |
| **StreamBuffer**      | rAF 批处理 token；`appendText` 类快通道                    | 仅 chat                                                     |
| **选区**              | 行索引 + 列 / 全局 offset（行级实现）                      | **禁止** 与块 `blockId+offset` 混存同一 SelectionStore 实例 |

**不变量 C-01**：`chat` 模块在运行时 **不得** 持有 `DocSession` 写句柄、**不得** import 笔记写 API（见 §6 门禁）。

**不变量 C-02**：流式进行中，内容 **只** 存在于行缓冲/消息草稿；**零** 半写入块树。

### 2.2 `note-paper`：`BlockTree` 世界

| 概念               | 定义                                                                | 可否出 surface           |
| ------------------ | ------------------------------------------------------------------- | ------------------------ |
| **BlockTree / IR** | RS 内存权威树；flavour + props + 子序                               | Agent/工具经 API 读      |
| **BlockId**        | 机器主身份；Conex-MD `<!--c:ID-->`                                  | 契约导出                 |
| **叶文本**         | 热：yrs YText；冷：snapshot；**句柄不外泄**                         | 仅经 text_edit Op        |
| **窗口投影**       | TS `MemoryBlock` / ProjectionDiff（editor-kit）                     | 投影 only，杀进程可丢    |
| **逻辑选区**       | `blockId + offset` / 块多选                                         | 不与 chat 行选区共享实例 |
| **叶子 PM/CM doc** | **仅活动叶子** 的临时编辑视图；**禁止** `serialize(pmDoc)` 进持久化 | 不跨 surface 复用整树    |

**不变量 N-01**：`note-paper` **不得** 以 `lines[]` 作为文档真相或长期缓存权威。

**不变量 N-02**：一切权威变更进单一 `Transaction.apply`；扩展/Agent **无** 写盘旁路。

### 2.3 对照表（实现自检）

| 问题                     | chat                    | note-paper                           |
| ------------------------ | ----------------------- | ------------------------------------ |
| 「文档」主结构是什么？   | 行数组 + 消息           | 块树                                 |
| 主键是什么？             | messageId / 行号+offset | BlockId                              |
| 打开「笔记工作区」用谁？ | **禁止** 用行级当终局   | 块纸面                               |
| AI 未完成输出放哪？      | 行缓冲 / 草稿消息       | **不放**（除非用户显式笔记续写工具） |
| 失败回滚单位             | 丢弃/保留草稿消息       | 整事务回滚；零半树                   |

---

## 3. 禁止共享（硬锁）

下列对象 **跨 surface 共享 = 架构红灯**（A-SURF / A-INV-03 失败）。

| ID        | 禁止共享对象                              | 理由                                                            | 检测思路（W5-C）                                 |
| --------- | ----------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------ |
| **NS-01** | **Doc store / DocSession 实例**           | 双写入口；行级缓冲与 RS 时钟漂移                                | import 图；运行时句柄泄漏测                      |
| **NS-02** | **`lines[]` 或行级 EditorStore**          | 行级冒充块；嵌套/move/引用做不动                                | note-paper 包禁止依赖 markdown-editor store 路径 |
| **NS-03** | **yrs / YText 句柄**                      | 句柄出 crate = 旁路 apply（A-INV-05）                           | Rust 可见性 + TS 无 yrs 类型 re-export           |
| **NS-04** | **PM 整树 doc（文档级 EditorState）**     | 整树 PM 当局；与块窗口/RS 双真相；`serialize(pmDoc)` 持久化风险 | 仅叶子级 PM；无「全文档 PM state」单例           |
| **NS-05** | **统一「全局选区 store」混存两坐标系**    | 行 offset 与 blockId+offset 混用导致错误 apply                  | 分实例；类型不交叉赋值                           |
| **NS-06** | **笔记 SQLite 编码态 ↔ 行级 undo 栈**     | 跨模型撤销语义不可组合                                          | 无跨 store undo 桥                               |
| **NS-07** | **把 `conex-markdown` HTML 反推为块权威** | D3 已否决；聊天管线不得升格块 P/S                               | 块保存路径禁止调用 chat HTML 管线                |

### 3.1 显式否决路径

| 路径                                                       | 裁决                                |
| ---------------------------------------------------------- | ----------------------------------- |
| 流式 token 逐条 `doc_apply_ops` / `text_edit`              | **否决**                            |
| 完成态自动（无用户/无工具 Intent）把聊天气泡写入当前笔记   | **否决**                            |
| 笔记内用 `lines[]` 虚拟化冒充块窗口                        | **否决**                            |
| 聊天面 `import` 并调用 `DocSession.apply` / 笔记写工具直连 | **否决**（须经显式桥模块 + Intent） |
| 共享一个 Zustand/Redux store 同时挂 `lines` 与 `blocks`    | **否决**                            |
| 行级引擎「打开 workspace 笔记文件」作为编辑终局            | **否决**                            |

---

## 4. 可共享（白名单）

> **共享的是纪律与无状态工具，不是真相。**
> 落点优先 `@crish/editor-kit` 与未来 `editor-kit/render`（或独立 render-widgets 包）；**禁止** `editor-kit` 依赖任一侧产品 store。

| ID        | 可共享项                                     | 形态约束                                                                            | 消费方                |
| --------- | -------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------- |
| **SH-01** | **IME 守卫思想 / 状态机接口**                | `Idle \| Composing`；合成中禁结构键 / slash / 危险 unmount；**各 surface 自有实例** | chat ∥ note-paper     |
| **SH-02** | **虚拟列表工具类型**                         | 窗口查询输入输出类型、overscan、pin 集合思想；**适配器各自实现测量**                | 行窗口 ∥ 块窗口       |
| **SH-03** | **HeightMap 算法思想**                       | 预估+实测+prefix sum 可同构；**数据源 key 不同**（行 index vs blockId）             | 两侧可各持一 Map      |
| **SH-04** | **渲染件（公式 / 代码高亮 / 表格只读外观）** | 纯展示组件；props = 字符串或只读 AST 切片；**无写 store**                           | 两侧 UI               |
| **SH-05** | **data-\* 无损映射纪律**                     | O(1) DOM→逻辑；chat 用 `data-token-*`，note 用 `data-block-id` 等                   | 纪律文档 + 各自属性名 |
| **SH-06** | **消毒 / 高亮实现细节**                      | sanitizer 实现可复用；**Options 分面配置**（surface=chat vs note）                  | 渲染管线              |
| **SH-07** | **无状态 grapheme / 边界工具**               | 纯函数库                                                                            | 两侧                  |

### 4.1 依赖方向（钉死）

```
reference/markdown-editor  ──►  @crish/editor-kit   （可选渐进；不得反向）
packages/block-paper       ──►  @crish/editor-kit
@crish/editor-kit          ──►  @crish/block-paper-contract（类型 only）
@crish/editor-kit          ─╳→  markdown-editor / DocSession / yrs / 行级 store
packages/block-paper       ─╳→  reference/markdown-editor 的 EditorStore / lines[]
```

**W5-A 抽取原则**：从行级 **复制纪律到 editor-kit**，而不是让 block-paper 依赖 markdown-editor 源码树。行级既有测试资产 **保持可独立 `npm test`**。

---

## 5. 流式完成 → 笔记：`send_to_note`（显式桥）

### 5.1 用户裁决（锁）

| 项            | 锁定                                                     |
| ------------- | -------------------------------------------------------- |
| **流式期**    | 只走行级缓冲；**不**触碰块树                             |
| **完成态**    | 用户或 Agent 发出 **显式**「发送到笔记」；**非**静默缝合 |
| **笔记内 AI** | 续写 / 改写走 **笔记工具 / Op**；**不**走行级 store      |
| **失败**      | 行级缓冲丢弃或保留为草稿消息；**禁止** 半写入块树        |

### 5.2 Intent / 工具形状（草案，实现须注册同源）

#### 5.2.1 前端 Intent（产品壳 → RS）

```ts
/** surface=chat 完成态 → 请求写入 note-paper；不得隐式触发 */
type SendToNoteIntent = {
  type: 'send_to_note';
  intentId: string; // 幂等键
  source: {
    surface: 'chat';
    messageId: string;
    /** 发送瞬间的 MD 快照；禁止持有 lines[] 引用过桥 */
    markdown: string;
  };
  target: {
    surface: 'note-paper';
    docId: string;
    /** 插入点：父块 + 位次；或 replace 选区块集合 */
    parentId?: string;
    afterBlockId?: string;
    mode: 'insert_blocks' | 'apply_md_fragment' | 'append_to_block';
  };
  origin: 'user' | 'agent';
};
```

#### 5.2.2 Agent / 工具名（与 06 工具面同源）

| 工具名（建议）      | 语义                                               | 等价后端路径                                   |
| ------------------- | -------------------------------------------------- | ---------------------------------------------- |
| **`send_to_note`**  | 显式把一段 MD/块载荷写入指定笔记文档               | `apply_md_fragment` 或 `insert_blocks` → apply |
| `document_write_md` | 已有：事务化 MD 写；**可被 send_to_note 内部调用** | 同 06；禁止 `fs.write` 当权威                  |
| `block_batch` 等    | 笔记内结构化 mutate                                | 仅 note-paper                                  |

**审批**：`origin=agent` 时走 session-loop 既有审批矩阵（`note:write`）；`origin=user` UI 按钮可直通（仍经单一 apply）。

### 5.3 时序（规范路径）

```
[AI stream tokens]
       │
       ▼
 chat: StreamBuffer → lines[] / 草稿消息   ←── 唯一热路径
       │
       │ stream end / user stop
       ▼
 状态 = completed（仍仅在 chat）
       │
       │ 用户点「发送到笔记」或 Agent 调 send_to_note
       ▼
 构造 SendToNoteIntent（markdown 快照 + target docId）
       │
       ▼
 RS: apply_md_fragment | insert_blocks  （单一 Transaction）
       │
       ├─ success → ProjectionDiff → note-paper 窗口
       │            chat 侧标记 message.sentToNote = { docId, blockIds? }
       │
       └─ failure → 块树零变化；chat 草稿保留；可重试（同 intentId 幂等）
```

### 5.4 失败与幂等

| 场景                  | 期望                                                                            |
| --------------------- | ------------------------------------------------------------------------------- |
| MD 解析 / 校验失败    | apply 拒绝；**零半树**；返回可展示错误                                          |
| docId 不存在 / 无权限 | 拒绝；chat 不变                                                                 |
| 重复 intentId         | 第二次 no-op 或返回首次结果；**不**双倍插入                                     |
| 流式未完成就发送      | **拒绝** 或 仅发送已 stop-flush 快照（产品二选一须钉死：默认 **拒绝未完成流**） |
| 用户取消              | 不调用 apply；缓冲保留                                                          |

### 5.5 禁止的「假完成」

| 反例                                        | 为何否决               |
| ------------------------------------------- | ---------------------- |
| `onStreamEnd` 默认写入当前打开笔记          | 静默缝合               |
| 共享 buffer 引用，块侧直接读 `editor.lines` | 模型交叉；生命周期耦合 |
| 先写 mirror `.md` 再当权威                  | 旁路 apply（A-INV）    |
| 聊天 HTML（conex-markdown）反序列化成块     | 错误管线（D3）         |

---

## 6. 与 editor-kit 抽取清单

> 目标：两侧只依赖 **无产品 store** 的共享包；W5-A 规格勾选；实现可分期，但 **禁止方向颠倒**。

### 6.1 已有（W3-A/B，块侧已用）

| 模块                           | 路径（现状）                        | surface 关系              | W5-A 动作              |
| ------------------------------ | ----------------------------------- | ------------------------- | ---------------------- |
| ViewportQuery                  | `editor-kit/viewport/ViewportQuery` | 通用窗口算法              | 保持；文档标注可双用   |
| HeightMap                      | `editor-kit/viewport/HeightMap`     | 通用                      | 保持                   |
| pin / PinViolationError        | `editor-kit/viewport/pin`           | 通用纪律                  | 保持                   |
| applyProjectionDiff            | `editor-kit/diff/**`                | **块投影**（MemoryBlock） | **勿**强行服务 lines[] |
| SelectionStore                 | `editor-kit/selection/**`           | **块坐标**                | chat **勿**复用实例    |
| ImeMachine + structureKeyGuard | `editor-kit/ime/**`                 | 思想共享；实例分 surface  | 行级可对照接入         |

### 6.2 待抽取 / 待对齐（清单）

| #   | 项                                    | 源（行级参考）                   | 目标包建议                             | 完成定义                                    |
| --- | ------------------------------------- | -------------------------------- | -------------------------------------- | ------------------------------------------- |
| E1  | IME 相位与结构键守卫 **契约测试**     | markdown-editor composition 纪律 | `editor-kit/ime` 契约用例复用          | 两侧单测引用同一 A-IME 语义 ID 子集         |
| E2  | 虚拟列表 **类型**（非 tanstack 绑定） | 行 virtualizer 输入输出          | `editor-kit/viewport` 类型导出         | chat 适配器只依赖类型，不依赖块 MemoryBlock |
| E3  | 公式渲染件                            | 行级公式渲染                     | `editor-kit/render/math` 或 widgets 包 | 纯 props；无 store                          |
| E4  | 代码高亮 / 只读代码块外观             | 行级 code 渲染                   | 同上 `render/code`                     | note 代码叶 CM6 编辑 ≠ 此只读件             |
| E5  | grapheme 边界工具                     | markdown-editor grapheme         | `editor-kit` 或 `shared-utils`         | 纯函数；两侧单测                            |
| E6  | surface 常量与 lint 注释模板          | 无                               | `block-paper-contract` 或 editor-kit   | `EditorSurface` 类型入库                    |
| E7  | **架构隔离测试脚手架**                | 无                               | `tests` / package 边界测               | A-SURF-01… 可红可绿（W5-C 收口）            |

### 6.3 明确 **不** 抽进 editor-kit

| 项                         | 原因                    |
| -------------------------- | ----------------------- |
| `lines[]` / EditorStore    | 产品真相；属于 chat     |
| DocSession / Op / yrs      | RS 心；不属于呈现工具包 |
| 完整 PM schema / 整树插件  | 叶子属 block-paper      |
| slash 菜单业务 / 块 chrome | block-paper/chrome      |
| StreamBuffer 产品策略      | chat 特有热路径         |
| Conex-MD P/S               | md-ast / RS             |

### 6.4 行级引擎纪律（测试铁律）

| 规则 | 内容                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------ |
| T1   | `reference/markdown-editor`：`npm test`（vitest unit）**门禁保留**                                                             |
| T2   | 主仓 e2e 五专项（ast-block-tables / format-checker / ime-composition / keyboard-navigation / wysiwyg-interaction）**禁止删除** |
| T3   | W5-A 对行级 **只读/边界**；抽取以「复制纪律 + 可选后续依赖 editor-kit」为主，**禁止**为抽共享而删除行级测试                    |
| T4   | 块纸面冒烟 **不** 依赖 `lines[]` 才能挂载                                                                                      |

---

## 7. 验收断言草案（A-SURF）

> 与 **A-INV-03**（行级可写本地缓冲；持久化/协同/Agent 可见仅块树提交）正交加强。
> **缺测 = 未交付**（对齐 08）。主责：W5-A 规格 → W5-C 自动化 → W5-B 挂载冒烟引用。

| ID            | 断言                                                                                    | 层（建议）                                  | 主责      |
| ------------- | --------------------------------------------------------------------------------------- | ------------------------------------------- | --------- |
| **A-SURF-01** | 存在且仅存在两个编辑 surface 枚举：`chat` \| `note-paper`；入口可识别                   | 快（类型/常量）                             | W5-A/C    |
| **A-SURF-02** | `note-paper` 包/模块 **禁止** import 行级 `EditorStore` / `lines` 写 API                | 快（dependency-cruiser / 自定义 import 测） | W5-C      |
| **A-SURF-03** | `chat` / markdown-editor **禁止** import `DocSession` 写 API、笔记 `apply` command 直连 | 快（import 测）                             | W5-C      |
| **A-SURF-04** | 流式 token 路径 **零** `Transaction.apply` / `doc_apply_ops` 调用（计数探针）           | 中（集成）                                  | W5-C      |
| **A-SURF-05** | 无 `send_to_note`（或等价显式 Intent）时，完成态消息 **不** 改变目标笔记版本/时钟       | 中                                          | W5-C      |
| **A-SURF-06** | 显式 `send_to_note` 成功 → 块树出现对应内容；幂等 intentId 不双插                       | 中                                          | W5-C/D    |
| **A-SURF-07** | `send_to_note` 失败 → 块树与 apply 前一致；chat 草稿仍在                                | 中                                          | W5-C      |
| **A-SURF-08** | 块纸面冒烟（打开空文档/假数据）**不** 创建 `lines[]` 权威 store                         | 快                                          | W5-B/C    |
| **A-SURF-09** | editor-kit **不** 依赖 markdown-editor、**不** 导出 DocSession/yrs 类型                 | 快                                          | W5-A/C    |
| **A-SURF-10** | 同窗双 surface：焦点在 chat 时结构快捷键不落到 note 树；反之亦然                        | 中（e2e）                                   | W5-B      |
| **A-SURF-11** | 行级门禁全绿：`reference/markdown-editor` `npm test` + 既有 e2e 专项未删                | 快/中                                       | W5-A 回归 |
| **A-SURF-12** | 笔记内 AI 续写走工具/Op 路径；测试夹具中 **无** 行级 store 作为写入后端                 | 中                                          | W4/W5     |

### 7.1 与既有族映射

| 既有 ID  | 与 A-SURF 关系                                          |
| -------- | ------------------------------------------------------- |
| A-INV-03 | 总原则；A-SURF-04/05/06 为其可执行细化                  |
| A-INV-01 | send_to_note 必须进单一 apply                           |
| A-INV-05 | yrs 句柄不进 chat / 不进 editor-kit                     |
| A-IME-*  | 纪律共享；实例隔离（A-SURF-10）                         |
| A-MD-*   | 桥接载荷走 Conex-MD / apply_md_fragment，不走 HTML 反推 |
| X-01     | 联测可含 send_to_note → apply → Diff 链                 |

### 7.2 关闭 EL-08 的最低集合

**EL-08 关闭不得早于**：A-SURF-02、03、04、05、06、08、11 全绿 + A-INV-03 仍绿（W5-C 主责；W5-B 仅挂载 ≠ 关闭）。

---

## 8. W5-B 挂载任务勾选表

> 依赖：W3-F（或可嵌入的 chrome 子集）、**W5-A 本文**。
> **挂载 ≠ 交付**：Workbench 可点可写 ≠ EL-01/EL-08 关闭（08 §1.0）。

| #    | 任务                                                                | 文件域（建议）                                      | 验收引用               | 状态 |
| ---- | ------------------------------------------------------------------- | --------------------------------------------------- | ---------------------- | ---- |
| B-01 | Workbench 路由/页签：`note-paper` 视图容器（可空壳）                | `apps/crish-desktop/**` 或 workbench 挂载点（串行） | A-SURF-01              | ☐    |
| B-02 | 挂载 `@crish/block-paper` chrome（假数据或 mock Diff 可先）         | app 挂载层 + block-paper                            | A-SURF-08              | ☐    |
| B-03 | 挂载点 **不** import 行级 EditorStore；聊天页继续 markdown-editor   | app 边界                                            | A-SURF-02/03           | ☐    |
| B-04 | 焦点管理：chat 输入区 ↔ 笔记纸面切换；surface 标注正确              | app                                                 | A-SURF-10              | ☐    |
| B-05 | 「发送到笔记」UI：仅 completed 消息显示；绑定 `send_to_note` Intent | chat UI + 桥模块                                    | A-SURF-05/06           | ☐    |
| B-06 | Intent 桥模块独立文件（唯一允许「知两边」的薄适配）                 | 如 `apps/.../bridges/send-to-note.ts`               | §5；NS-01 例外仅此薄层 | ☐    |
| B-07 | 桥模块只传 **markdown 字符串快照** + 元数据；不传 lines 引用        | 桥模块                                              | A-SURF-06              | ☐    |
| B-08 | 失败 toast/错误态；块树无半写                                       | UI + RS 错误映射                                    | A-SURF-07              | ☐    |
| B-09 | 笔记视图打开真实/ mock DocSession 只读投影（写路径可后续 W 波）     | app + IPC                                           | 冒烟                   | ☐    |
| B-10 | 回归：行级 `npm test` + 五 e2e 专项仍在且可调度                     | CI / 本地门禁                                       | A-SURF-11              | ☐    |
| B-11 | 文档：挂载 README 一段声明双 surface 与禁止静默缝合                 | app 或 block-paper README                           | 评审                   | ☐    |
| B-12 | **不** 宣称「块工作区已完成」；完成报告仅列 B-xx / A-SURF 实测      | 调度汇报                                            | 08 纪律                | ☐    |

### 8.1 薄适配层（唯一跨界例外）

```
允许：
  bridges/send-to-note  读取 chat 消息 MD 快照
  bridges/send-to-note  调用 note 写 API（apply_md_fragment / 工具）

禁止：
  bridges/* 持有长期 lines[] 与 DocSession 双绑定单例
  bridges/* 在 stream token 回调里写笔记
  业务组件（气泡/块壳）直接互相 import 对方 store
```

---

## 9. 实现波文件域摘要

| 包 ID    | 内容                               | 文件域                                                     | 依赖        |
| -------- | ---------------------------------- | ---------------------------------------------------------- | ----------- |
| **W5-A** | 本文规格 + editor-kit 抽取清单推进 | `plans/specs/dual-engine-surface.md`；可选 editor-kit 类型 | W3, 行级    |
| **W5-B** | Workbench 挂载 + 发送到笔记 UI/桥  | apps 挂载点；薄 bridge；**保护** markdown-editor           | W3-F, W5-A  |
| **W5-C** | A-SURF / import 隔离测试           | tests + package 边界                                       | W5-A        |
| **W5-D** | X-01… 含桥接路径                   | 跨层                                                       | W1–W4, W5-B |

**并行提示**：W5-C 规格测可与 W5-B UI 并行，但 **同改 app 挂载文件时串行**。

---

## 10. 禁止事项（汇总）

1. 用行级引擎打开「笔记工作区」当编辑终局
2. 流式或完成态 **静默** 写入块树
3. 共享 Doc store、`lines[]` 权威、yrs 句柄、PM 整树 doc
4. 删除或搁置 `reference/markdown-editor` 测试资产与五专项 e2e
5. editor-kit 反向依赖产品 store 或 RS 写入口
6. 以「先共用一个 store 以后再拆」为过渡终局
7. 挂载成功即可关闭 EL-08 / EL-01

---

## 11. 参考指针

| 文档                                                                   | 用途                     |
| ---------------------------------------------------------------------- | ------------------------ |
| `docs/block-workspace-architecture/15-评审后锁定修订.md`               | EL-08、L8 双引擎隔离门禁 |
| `docs/block-workspace-architecture/plans/07-双引擎与本仓衔接.md`       | 分维度任务书             |
| `docs/block-workspace-architecture/plans/09-执行任务包索引.md`         | W5-A…D 调度              |
| `docs/block-workspace-architecture/plans/08-验收与门禁.md`             | EL→断言；挂载≠交付       |
| `docs/block-workspace-architecture/round-D-stack/07-技术栈矩阵裁决.md` | A-INV-03；行级衔接       |
| `docs/block-workspace-architecture/round-D-stack/01-编辑呈现引擎.md`   | E-D1-12 并存             |
| `packages/editor-kit/README.md`                                        | 包边界现状               |
| `Agents.md`                                                            | markdown-editor 测试铁律 |

---

## 12. 修订记录

| 日期       | 说明                                  |
| ---------- | ------------------------------------- |
| 2026-08-11 | W5-A 初版：surface 分界可执行规格落盘 |
