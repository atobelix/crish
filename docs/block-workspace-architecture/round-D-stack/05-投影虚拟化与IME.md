# Round D · D5 · 投影模型、文档级虚拟化与 IME/选区

| 元数据       | 值                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **决策单元** | D5 · 投影 / 虚拟化 / IME（与 D1 呈现引擎选型衔接）                                                                                                                 |
| **输入**     | `13-RoundD-核心技术栈选型计划.md` · `12-主控合并-全景与上限裁决.md` · round-A `05`/`07`/`08` · round-B `06` · round-C `01`/`02` · `reference/markdown-editor` 纪律 |
| **立场**     | 效果完整度 → 正确性/不变量 → 可验证性 → 与已锁契约一致 → 结构干净；**禁止**工期/流行度退避                                                                         |
| **硬锁**     | 呈现是投影；窗口化挂载；IME composition 隔离；禁止整树重建默认路径                                                                                                 |
| **产出角色** | 只读选型论证；不改源码                                                                                                                                             |

---

## 0. 结论先行

| 项             | 裁决                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **投影**       | **RS 持文档权威**；TS 仅持 **视口窗口投影 + 本地选区映射 + 可选乐观缓冲**；呈现层永不作真相源                               |
| **虚拟化**     | **文档级块窗口（windowed mount）为一等默认**；高度缓存 + 预估回填；预取/overscan 可配置；**非**「全量挂载 + throttle 补救」 |
| **选区**       | **权威坐标 = `blockId` + 块内 `offset`（grapheme/逻辑偏移）**；DOM Range 是投影；跨块选 = 有序 block 区间 + 端点 offset     |
| **远端选区**   | Awareness **独立通道**；overlay 绘制；**视口裁剪 + 节流 + 禁止每帧 N 次强制布局**                                           |
| **IME**        | **composition 状态机一等**；合成期禁止结构键 / slash / 事务 commit / 虚拟化卸载焦点块；**禁止**合成失败回退到整树重建       |
| **与行级引擎** | **共享模块边界**（IME/高度/选区映射纪律）；**模型不可混**——行级不当页级权威（R1+R4）                                        |
| **必须自研**   | 投影 diff 协议、块窗口管理器、BlockHeightMap、选区坐标层、IME 守卫接线、远端 overlay 预算                                   |
| **可调包**     | 虚拟列表骨架（如 tanstack virtual / 自写等价）、grapheme 库、（可选）呈现内核的 DOM 适配层——但 **窗口契约与权威映射自研**   |

**一句话**：

> **呈现 = 投影**。RS 出「视口块切片」，TS 窗口化挂载 DOM；选区以 `blockId+offset` 为权威；IME composition 与结构变更/整树重建硬隔离。AFFiNE Page 全量挂载是**反例**；思源动态加载是**方向对、粒度可升级**的对照。

---

## 1. 该层效果锁（不可降级）

### 1.1 用户可见

| ID      | 效果                         | 不变量                                                                          |
| ------- | ---------------------------- | ------------------------------------------------------------------------------- |
| E-D5-01 | **打开 10 万块文档可交互**   | 首屏可滚动、可定位、可在可见块键入；禁止等全量 DOM 挂完才可操作                 |
| E-D5-02 | **滚动跟手**                 | 长文档连续滚动无卡死；窗口 DOM 节点数有上界（视口 + overscan）                  |
| E-D5-03 | **输入延迟可验收**           | 单字符 / IME 组合在长段落与大文档下仍跟手（见 §8 契约）                         |
| E-D5-04 | **IME 不丢字、不误触**       | composition 期间不触发 slash / 块变换 / Enter 拆块；end 后光标与文本一致        |
| E-D5-05 | **选区稳定**                 | 滚动、远端 patch、虚拟化挂卸后，逻辑选区不跳、不高亮消失                        |
| E-D5-06 | **远端选区可见且克制**       | 多人光标/块选可辨；不闪烁整页、不毁 Typora 静默纸面                             |
| E-D5-07 | **焦点块不被虚拟化「拆掉」** | 正在编辑 / composing 的块在窗口策略中 **钉住（pin）**，不得因滚动边界被 unmount |

### 1.2 架构不可见不变量

| ID      | 不变量                                                                                                                            |
| ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| I-D5-01 | **呈现是投影**；任何 DOM/React 树内容不得回写成文档权威（写路径一律 Op → RS）                                                     |
| I-D5-02 | **默认路径禁止整树重建**；输入 / 远端文本 delta / 局部 prop 变更 → O(触及块) 更新                                                 |
| I-D5-03 | **IME composition 隔离**：合成期不 commit 结构事务；不卸载焦点块；不重挂 contenteditable 根                                       |
| I-D5-04 | **选区权威在逻辑坐标**（`blockId+offset` 或等价 anchor/head 对）；DOM Range 可派生、可丢、可重建                                  |
| I-D5-05 | **Awareness ≠ 文档历史**；远端选区可丢、可覆盖，不进 undo/op 日志                                                                 |
| I-D5-06 | 聊天 **行级引擎** 与块引擎可共享 **纪律模块**，**不得**共享「页级文档模型」                                                       |
| I-D5-07 | 内存：TS 稳态投影 ≈ O(窗口 + 索引句柄)，**不**随全文块数线性持有完整 CE/组件树                                                    |
| I-D5-08 | 与 D1 衔接：无论呈现内核是自研 CE / PM / Lexical 等，**都必须服从本文件的投影/窗口/IME 契约**；内核持有的是窗口内编辑面，不是 Doc |

### 1.3 裁判键（重申）

效果完整度 → 正确性/不变量 → 可验证性 → 与「RS 心 + TS 皮 + 窗口投影」契约一致 → 结构干净。
**不得**以「AFFiNE 也没文档虚拟化」「先全挂再优化」砍掉窗口化一等。

---

## 2. 投影数据流（RS → 视口块 → DOM）

### 2.1 分层（硬边界）

```
┌─────────────────────────────────────────────────────────────┐
│  RS 权威层（Doc / BlockTree / Text CRDT / Op apply）         │
│  - 块图、props、文本、版本时钟                                │
│  - 不持 DOM；不持 React fiber                                │
└───────────────────────────┬─────────────────────────────────┘
                            │ ① 打开：DocSnapshot / 骨架索引
                            │ ② 变更：ProjectionDiff（按 blockId）
                            │ ③ 查询：ViewportQuery(scroll, size) → BlockSlice
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  投影控制面（TS，可部分下沉 RS 做切片计算）                    │
│  - BlockIndex：有序 blockId 列表 / 嵌套展开序列 / 折叠态      │
│  - BlockHeightMap：预估 + 实测回填 → 总高 / indexAt / posOf  │
│  - WindowManager：可见区间 + overscan + pin(焦点/composing) │
│  - SelectionStore：本地/远端逻辑选区                         │
│  - ImeGuard：composition 状态机                               │
└───────────────────────────┬─────────────────────────────────┘
                            │ ④ 仅对 window ∩ pin 集合下发
                            │    MountSpec[] { blockId, flavour, props, textSlice, y }
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  呈现层（D1 引擎 + React/宿主）                               │
│  - 块视图注册表 flavour → 组件                                │
│  - 块内编辑面（CE / 行级 embed / 只读渲染）                    │
│  - Widget 叠加：slash / 把手 / 浮条 / remote-selection       │
│  - DOM Range ←→ 逻辑选区 映射（双向，权威在逻辑侧）            │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 关键路径分轨

| 路径           | 方向                         | 载荷                                                               | 约束                                              |
| -------------- | ---------------------------- | ------------------------------------------------------------------ | ------------------------------------------------- |
| **打开**       | RS → TS                      | 文档骨架（blockId 序、flavour、父级、折叠）+ 首屏 slice 文本/props | 禁止首包塞全文 HTML                               |
| **滚动/跳转**  | TS → RS 或本地索引           | `ViewportQuery`；若文本已缓存可纯本地切片                          | 大文档文本可 **按块懒 hydrate**（与 D2/D4 协同）  |
| **用户键入**   | 呈现 → Op → RS → Diff → 呈现 | 文本 delta / 局部 props；**乐观**可选                              | 焦点块 pin；仅 patch 该块 DOM                     |
| **结构变更**   | 同上                         | insert/move/delete/turn_into                                       | 窗口重算 + 高度图 path-copy；**非**整文档 remount |
| **远端/Agent** | RS 广播 Diff                 | 按 blockId 集合                                                    | 视口外只更新索引/高度；视口内增量 patch           |
| **Awareness**  | 旁路通道                     | `{ userId, color, anchor, head }`                                  | 不进 Op；可丢                                     |

### 2.3 ProjectionDiff 最小契约（逻辑形状）

```text
ProjectionDiff {
  rev: DocRev,                    // 单调版本
  upserts: BlockProjection[],     // 新建或 props/text 变更的块
  removes: BlockId[],             // 删除
  moves?: { id, parent, index }[],// 结构位置
  heightHints?: { id, estPx }[],  // 可选：RS/序列化侧高度提示
}

BlockProjection {
  id: BlockId,
  flavour: string,
  parentId?: BlockId,
  index: number,                  // 兄弟序
  props: Json,                    // 已校验 schema 子集
  text?: TextSlice,               // 或 text handle + 版本；大块可分段
  childrenIds?: BlockId[],        // 展开序列用；折叠时可不下发孙块
}
```

**不变量**：呈现层收到 Diff 后，**不得**推断「未出现在 upserts 的块内容变了」——未通知即未变（tombstone/删除走 removes）。

### 2.4 乐观缓冲（可选，纪律严格）

| 规则             | 说明                                                              |
| ---------------- | ----------------------------------------------------------------- |
| 仅限焦点块文本   | 结构 op **禁止**长期只活在乐观层                                  |
| 绑定 `localOpId` | RS ack/rev 到达后收敛；冲突以 RS 为准并 **重映射选区**            |
| composition 中   | 乐观文本可进本地缓冲，但 **不**向 RS commit 半成品（见 §6）       |
| 失败回滚         | 还原逻辑选区 + 重拉该 block 投影；**禁止**整页 forceReload 作默认 |

### 2.5 与「双引擎」关系

| 面                   | 权威                         | 投影角色                          |
| -------------------- | ---------------------------- | --------------------------------- |
| **块纸面（笔记）**   | RS 块树                      | 本文件主体：块窗口 + 块内编辑投影 |
| **行级流式（聊天）** | 行缓冲 / 消息 store          | 独立虚拟化实例；**不**当笔记 Doc  |
| **MD 源码模式**      | 仍是块树；MD 为导出/受限缓冲 | R2：只读或保存回灌；禁止双写      |

---

## 3. 文档级虚拟化：算法选项与主路径

### 3.1 问题定义

| 错误默认                          | 正确默认                                |
| --------------------------------- | --------------------------------------- |
| 打开文档 = 为每个块挂一个 CE/组件 | 打开 = 建索引 + 挂 **窗口内** 块        |
| 滚动 = 全量 layout 已挂节点       | 滚动 = 换窗口 + 绝对定位/transform 位移 |
| 内存 ∝ 全文块数                   | 内存 ∝ 窗口 + 索引（弱线性/对数）       |
| 虚拟化是「以后优化」              | **虚拟化是打开契约的一部分**（效果锁）  |

### 3.2 候选策略横评

图例：`◎` 强匹配 · `○` 可达 · `△` 短板 · `×` 否决倾向。

| 代号   | 策略                                              | 上限（10 万块） | 选区/IME         | 嵌套/折叠  | 与 RS 兼容  | 可验证         |
| ------ | ------------------------------------------------- | --------------- | ---------------- | ---------- | ----------- | -------------- |
| **V1** | **块窗口 + HeightMap + overscan**（主推）         | ◎               | ◎ pin + 逻辑选区 | ◎ 展开序列 | ◎ 切片查询  | ◎ DOM 节点上界 |
| **V2** | 固定块高估算（无回填）                            | ○ 快但不准      | ○                | ○          | ◎           | ○ 滚动误差可测 |
| **V3** | 仅服务端/内核分页拼接（思源形动态加载）           | ○ 百万字叙事    | △ 边界接缝选区   | ○          | ◎           | ○ 接缝用例     |
| **V4** | 全量挂载 + rAF throttle（AFFiNE Page 向）         | ×               | △ 焦点多 CE      | ○          | △ 全量在 JS | × 违背 E-D5-01 |
| **V5** | 仅 `visibility:hidden` 不卸载（Edgeless idle 向） | × 内存仍线性    | ○                | ○          | ○           | × 假虚拟化     |
| **V6** | 双层：块窗口 + 块内行窗口（超长单块）             | ◎               | ◎ 块内再 pin     | ○ 单块     | ◎           | ◎ 单块 10 万行 |

**主路径：V1 为文档默认；V6 为超长文本块升级；V3 的「按需 hydrate 文本」思想并入 V1（窗口外可不持全文）。**
**V4/V5 否决为默认完成定义。**

### 3.3 V1 算法要点

#### 3.3.1 展开序列（Flatten）

- 输入：块树 + 折叠态 + 过滤（如 edgeless-only note 不进 Page）
- 输出：`FlatItem[]`：`{ blockId, depth, flavour, estimatedKind }`
- 折叠：子树不进入序列 → HeightMap 与窗口自然跳过
- **索引变更**只在结构/折叠时发生；纯文本编辑 **不**重建整表（可原地 patch 项）

#### 3.3.2 BlockHeightMap（高度缓存 + 预估）

借鉴本仓 `reference/markdown-editor` 的 `HeightMap` / `HeightOracle` 纪律，**升级到块粒度**：

| 能力 | 行级（markdown-editor）            | 块级（本层）                                         |
| ---- | ---------------------------------- | ---------------------------------------------------- |
| 键   | 行 index                           | 展开序列 index 或 `blockId` 映射                     |
| 预估 | 行类别 × 字数 oracle               | **flavour 基高 + 文本行数/嵌套提示 + 图片/表经验值** |
| 回填 | 实测 `offsetHeight` → 树 path-copy | 同：块挂载后测量 → 回填；`STABLE_EPSILON` 防抖       |
| 查询 | `posOf` / `indexAt` O(log n)       | 同构；滚动条总高 = `totalHeight`                     |
| 变更 | 行插入/删除平移                    | 块插入/删除/移动/折叠：区间替换 + 高度 delta         |

**禁止**：默认路径上对每个块 `measureElement` 触发链式 `resizeItem` 抖动而无批量协议（行级分析已踩坑，见 `docs/analysis/01-性能帧率路线.md`、`plan-A5`）。

**回填协议（契约）**：

1. 窗口挂载后 **批量** 读布局（一帧内 ro/读 offsetHeight）
2. 写 HeightMap（仅偏差 > ε）
3. **一次** 通知虚拟列表重算（`measure()` 或等价），禁止逐块同步打爆 layout

#### 3.3.3 窗口计算

```text
scrollTop, viewportHeight, overscanPx
  → indexAt(scrollTop - overscan)
  → indexAt(scrollTop + viewportHeight + overscan)
  → rawWindow = [i0, i1]
  → window = rawWindow ∪ pinSet（焦点块、composing 块、锚点选区端点块、拖选锚块）
  → mount(window) / unmount(previous \ window)
```

| 参数     | 建议起点（可测调，非常量教条）                                                   |
| -------- | -------------------------------------------------------------------------------- |
| overscan | 视口高度 0.5～1.0× 或 N 块（如 8～20）                                           |
| pin      | 焦点 + composing + selection anchor/head 所在块（及跨块选中间是否虚影另议）      |
| 池化     | 同 flavour 视图可回收；**contenteditable 状态机随 blockId 绑定，池化不得串内容** |

#### 3.3.4 定位模式

| 模式                       | 用途                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| **绝对 top / translate3d** | 块根定位；滚动帧优先合成器 blit；避免滚动帧 React 全量 reconcile                                  |
| **占位总高**               | 容器 `height = f(totalHeight)`；超大文档可接 `scrollMap` 物理钳制（行级 `scrollMap.ts` 思想升级） |
| **禁止**                   | 滚动帧对窗口内每块 setState 重建 props 树（memo 失效陷阱）                                        |

#### 3.3.5 嵌套块

- **方案 A（推荐基线）**：扁平展开 + `depth` 缩进；虚拟化只认一维序列（实现简单、滚动稳定）
- **方案 B**：容器块占位 + 内部再虚拟（仅数据库/超级大子树）
- 跨块拖拽：ghost 用逻辑 index，**不**依赖视口外 DOM 仍存在

### 3.4 超长单块（V6）

当单 `paragraph`/`code` 文本行数极大时，块窗口不够：

- 块外壳仍在窗口内 pin
- **块内**再套行级窗口（直接复用 markdown-editor 虚拟化子系统作 embed）
- 块级 HeightMap 存 **该块总高**（由块内 HeightMap.totalHeight 上报）

### 3.5 与呈现引擎（D1）的接口钉

呈现引擎无论选型，必须实现（或外包给 WindowManager）：

```text
interface BlockViewportHost {
  setSlice(blocks: MountSpec[]): void;     // 幂等：diff 挂卸
  patchBlock(id: BlockId, patch: BlockPatch): void;  // 禁止隐式 full remount
  pin(id: BlockId, reason: PinReason): void;
  unpin(id: BlockId, reason: PinReason): void;
  mapPointToPos(clientX, clientY): LogicPos | null;
  mapPosToRect(pos: LogicPos): DOMRect | null;  // 仅窗口内保证；窗外 null
}
```

**D1 否决条件（本层强加）**：若候选引擎 **强制** 全文档 schema 节点常驻 DOM，则不得作 10 万块路径的默认引擎（可降级为块内小文档或只读）。

---

## 4. 选区坐标：`blockId + offset` 权威

### 4.1 模型

```text
LogicPos    = { blockId: BlockId, offset: number }  // offset = 块内逻辑偏移（推荐 grapheme 或 UTF-16 与引擎统一，全仓一种）
LogicRange  = { anchor: LogicPos, head: LogicPos } // 有方向；折叠选区 anchor==head
BlockSel    = { ids: BlockId[] }                    // 块多选（与文本选互斥或分层，产品钉一种）
EditorSel   =
  | { type: 'text', range: LogicRange }
  | { type: 'block', blocks: BlockSel }
  | { type: 'none' }
```

| 规则          | 说明                                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| **权威**      | `EditorSel` 存 SelectionStore（TS）；可镜像到 RS **仅**作 presence 广播，**不是**文档 op                 |
| **DOM Range** | 派生视图；虚拟化 unmount 后 DOM 选区可消失，**逻辑选区仍在**                                             |
| **归一**      | 渲染高亮用 min/max；键盘扩展用 anchor/head（对齐行级 04 分析：禁止只有 min/max 导致 Shift 反向扩展错误） |
| **跨块**      | anchor/head 分属不同 blockId；中间块高亮由块级装饰层绘制，不要求中间块文本 Range 连续存在                |
| **钳制**      | 任何 flush / Diff 后：`offset ∈ [0, blockTextLength]`；删除块则选区落到兄弟/父策略（显式表，禁止 NaN）   |

### 4.2 映射职责

| 方向        | 职责                                                                      | 失败策略                                                      |
| ----------- | ------------------------------------------------------------------------- | ------------------------------------------------------------- |
| DOM → 逻辑  | 点击 / drag / selectionchange → `blockId`（`data-block-id`）+ 块内 offset | 窗外 / 非编辑器 → 忽略或 clamp                                |
| 逻辑 → DOM  | 恢复焦点、IME textarea 锚定、本地 caret 绘制                              | 目标块不在窗口 → **先 scrollIntoView 逻辑位置并 pin，再映射** |
| 逻辑 → 像素 | 浮条 / slash / 远端光标                                                   | 仅窗口内；窗外远端选区可画「边条指示」不画错位 caret          |

### 4.3 与虚拟化交互（魔鬼点）

| 场景               | 正确行为                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------- |
| 拖选滚出 overscan  | **不能**依赖原生 DOM 选连续；必须用逻辑坐标状态机 + 边缘 auto-scroll（行级 S2 升级到块） |
| 输入时窗口滑动     | 焦点块 pin，caret 不丢                                                                   |
| 远端删除选区所在块 | Diff 后钳制选区；通知一层轻反馈，禁止整页 reload                                         |
| 折叠含选区的子树   | 选区钳到折叠块边界或展开（产品二选一，须测）                                             |

### 4.4 双缓冲 / 双轨纪律

对齐行级「引擎选区主轨 + 原生 Range 辅轨」思想，块场景升级为：

| 轨           | 用途                                                                            |
| ------------ | ------------------------------------------------------------------------------- |
| **逻辑主轨** | 所有命令、Op、协同、测试断言                                                    |
| **DOM 辅轨** | 系统 IME、无障碍、外接读屏；程序化更新窗口内短暂抑制 selectionchange 回写，防环 |

**禁止**：以「`window.getSelection()` 字符串」作为剪贴板或 Agent 工具的权威选区源而不经逻辑映射。

---

## 5. 远端选区（Awareness 投影）

### 5.1 通道

```
Remote user selection
  → RS/实时层 Awareness（可丢）
  → TS AwarenessStore
  → RemoteSelectionOverlay（widget，非块内）
```

- **不进** 文档 undo / CRDT 历史
- 载荷：`userId, color, name?, sel: EditorSel, rev?`
- 本地输入优先：overlay 更新 **rAF 合并 + 节流**（参考 AFFiNE 60ms，但须 **增量** 而非任意 `blockUpdated` 全量重算）

### 5.2 绘制与性能

| 规则            | 说明                                                                           |
| --------------- | ------------------------------------------------------------------------------ |
| **视口裁剪**    | 仅计算与窗口相交的远端选区几何                                                 |
| **少强制布局**  | 缓存 blockId→rect；块 patch 时使缓存失效；禁止每人每帧 `getClientRects` 扫全文 |
| **批绘**        | 多用户可合并到一层 overlay（canvas 或单 SVG/div 容器），避免 N 套深层 DOM      |
| **静默 chrome** | 细线 + 轻名牌；滚动可降采样；对齐 round-A `07` Typora 静默                     |
| **大 N**        | 超阈值协作者：聚合为「N 人在此块」而非 N 条全高亮                              |

### 5.3 AFFiNE 反模式（勿复制）

来源：round-A `05` R4 / T-Collab-*：

- 任意 `blockUpdated` → 远程选区 **全局** 重算
- 多用户 `flatMap` + 频繁 `getClientRects`
- 与本地输入抢同一帧预算

本产品：**远端几何更新可降级，本地 IME 帧不可降级**。

---

## 6. IME 状态机（composition 隔离）

### 6.1 为何一等

- CJK 用户基本盘；效果锁：composition 中不误触命令、不拆 grapheme、不整页拆树
- AFFiNE 反例：Inline 热路径 IME 异常可走 `rerenderWholeEditor`（round-A `05` R3）——**禁止**成为本产品默认恢复策略
- 思源：composition 生命周期与结构操作互斥（round-C `01` §4.1）——**策略可学**
- 本仓行级：`HiddenInput` composition 状态机 + `compositionGroupId` + value 优先提交（`04-编辑深度扩展.md` / 实现已演进）——**纪律升级到块**

### 6.2 状态机

```text
              compositionstart
   Idle ──────────────────────► Composing
     ▲                         │  │
     │                         │  │ compositionupdate（候选）
     │     compositionend      │  ▼
     ◄──────────────────────────  PendingFlush（可选 0～50ms）
                                    │
                                    ▼ 以 textarea.value / 引擎缓冲为准 commit
                                  Idle
```

| 状态             | 允许                                                   | 禁止                                                                                                                                             |
| ---------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Idle**         | 正常 Op、结构键、slash、虚拟化 unmount 非 pin 块       | —                                                                                                                                                |
| **Composing**    | 块内组合文本缓冲、候选窗锚定、光标隐藏/替换为 IME 样式 | 结构键（Enter 拆块/Backspace 并块）、slash 打开、markdown 块变换、事务 commit 到 RS（半成品）、**卸载焦点块**、整树/整段默认 remount、拖选抢焦点 |
| **PendingFlush** | 合并同 group 的尾随输入                                | 开启新的结构事务                                                                                                                                 |

### 6.3 提交语义

| 规则                 | 说明                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------- |
| **value 优先**       | `compositionend` 以控件最终文本为准；`e.data` 仅参考（防 Android/Safari 空 data 丢字）        |
| **一次合成一步撤销** | `compositionGroupId` 合并；对齐行级                                                           |
| **beforeinput**      | `insertCompositionText` / `insertReplacementText` 进入同一 group；Android 无 keydown 补丁通道 |
| **厂商 quirks**      | 可保留分支表（思源：微软双拼 / 搜狗注释形）——**策略表自研**，不嵌 Protyle                     |
| **表格/嵌套**        | 合成开始记录 `{blockId, offset}` 或 cell 坐标；end 后按逻辑坐标恢复，不靠「整表 HTML spin」   |

### 6.4 与虚拟化 / 投影的交叉铁律

1. **Composing ⇒ pin(focusBlock)**
2. **Composing ⇒ 禁止** 对该块 `patchBlock` 走「拆掉 CE 根再挂」
3. **远端 Diff 命中焦点块文本**：合成期 **暂缓应用** 或 **只入侧缓冲**，end 后三路合并（本地 composition 优先于可丢的远端 presence；文档 op 按 D2 合并，选区重映射）
4. **恢复策略**：映射失败 → 重拉 **单块** 投影 + 逻辑 offset clamp；**禁止** `forceReload` 整页作默认

### 6.5 块场景相对行级的升级点

| 行级（markdown-editor）   | 块场景升级                                                   |
| ------------------------- | ------------------------------------------------------------ |
| 单缓冲全文 + 行窗口       | 多块 CE 或块内 embed；**仅焦点块可编辑**                     |
| 全局 `isComposing`        | **per-editor** 状态；多编辑器实例不串                        |
| 无块结构键                | `/`、`、`、Enter 拆块、Tab 缩进 —— **全部** composition 短路 |
| 无协同                    | 合成期 awareness 可报「正在输入」而不报不稳定 offset         |
| 测试：ime-composition e2e | 保留纪律 + 增：合成中滚动、合成中远端 patch、合成中窗口 pin  |

---

## 7. 与行级引擎共享模块边界

对齐 round-B `06` **R1 + R4** 与 Round D 硬约束：

### 7.1 可共享（抽成纪律/库，非共享 Doc）

| 模块                  | 共享内容                                           | 块侧适配                            |
| --------------------- | -------------------------------------------------- | ----------------------------------- |
| **IME 状态机**        | composing 计数、groupId、value 优先、pending flush | 焦点 `blockId` 上下文；结构键表不同 |
| **Grapheme / 偏移**   | 簇边界、删除/移动单位                              | 块内 offset 同一套                  |
| **HeightOracle 模式** | 预测、ε、批量回填协议                              | 键从「行」升级为「块/块内行」       |
| **scrollMap 思想**    | 逻辑高 ↔ 物理滚动钳制                              | 文档总高百万级时                    |
| **选区方向模型**      | anchor/head/assoc                                  | 坐标加 `blockId`                    |
| **测量/坐标换算**     | viewport ↔ content                                 | 块根 `data-block-id` 命中测试       |
| **测试门禁哲学**      | ime-composition / keyboard-navigation / 虚拟行上界 | 块级对等 spec                       |

### 7.2 不可共享（禁止混模型）

| 禁止                                | 原因                                     |
| ----------------------------------- | ---------------------------------------- |
| 用 `lines: string[]` 当局笔记 Doc   | 嵌套/协同/块数据库上限被锁死（R3 否决）  |
| 块页与聊天共用一个 EditorStore 单例 | 生命周期与撤销域污染                     |
| 行级 undo 栈直接当块事务            | 粒度与 origin（user/agent/remote）不一致 |
| 聊天流式 token 逐条 `doc_apply_ops` | 热路径打爆合并与投影                     |

### 7.3 推荐包边界（逻辑，非强制目录名）

```text
packages/editor-kit/          # 或 crates 旁 TS 包
  ime/                      # 状态机纯逻辑 + 事件绑定辅助
  coords/                   # LogicPos, grapheme offset
  height-map/               # 泛型 HeightMap<TKey>
  scroll-map/               # 可选物理钳制
  selection/                # anchor-head 运算、钳制

packages/block-viewport/      # 块窗口
  flatten.ts
  window-manager.ts
  block-height-map.ts
  projection-store.ts

packages/block-editor/        # D1 呈现接线
  ...

reference/markdown-editor     # 行级产品；消费 editor-kit；不依赖 block-viewport
```

**依赖方向**：`markdown-editor` → `editor-kit`；`block-viewport` → `editor-kit`；**禁止** `editor-kit` → 块/行产品。

---

## 8. 性能验收契约（可证伪）

> 下列为 **完成定义**，不是愿望清单。数值可在基准机型上标定后写入 CI 阈值表；**未达标 = 未完成**，禁止用缩小文档冒充通过。

### 8.1 场景矩阵

| ID               | 场景                   | 操作                    | 断言（逻辑）                                                                            |
| ---------------- | ---------------------- | ----------------------- | --------------------------------------------------------------------------------------- |
| P-Open-100k      | 10 万块文档            | 冷打开至可交互          | 时间 ≤ 标定阈值；**DOM 块节点 ≤ 窗口上界**；可滚动                                      |
| P-Scroll         | 同上                   | 顶↔底往返滚动           | 窗口内挂载块数有界；无整页白屏死锁；scroll 位置与逻辑 index 误差 ≤ 阈值（如 1～2 块高） |
| P-Type           | 10 万块 + 长段落       | 连续输入 / 中文 IME     | 输入延迟 P95 ≤ 阈值；合成期无结构误触；**无整树 remount 计数**                          |
| P-Jump           | 大纲/搜索跳转          | 跳到末段块              | 一次窗口重定位；目标块 pin；选区正确                                                    |
| P-Remote-N       | N 个远端选区           | 本地输入 + 远端移动光标 | 输入帧不被 overlay 饿死；远端只更新视口相交集                                           |
| P-Agent-Batch    | Agent 千次块 patch     | 应用批 Op               | UI **一次**投影收敛；选区钳制；无 forceReload                                           |
| P-Mem            | 打开 10 万块编辑 10min | RSS / 堆快照            | 增长曲线与窗口相关，禁止与 10 万 CE 同阶                                                |
| P-Compose-Scroll | IME 合成中             | 程序化/用户滚动         | 焦点块仍 pin；end 后文本与光标正确                                                      |

### 8.2 可观测指标（建议埋点）

| 指标                               | 含义                             |
| ---------------------------------- | -------------------------------- |
| `viewport.mountedBlocks`           | 当前 DOM 块数                    |
| `viewport.windowRange`             | `[i0,i1]`                        |
| `heightMap.totalHeight` / 预测误差 | 滚动条准确性代理                 |
| `input.latencyMs`                  | keydown/beforeinput → 文本可见   |
| `patch.fullRemountCount`           | **默认路径必须为 0**（测试断言） |
| `ime.composing` / `ime.groupId`    | 状态机可测                       |
| `remote.layoutReadsPerSec`         | 强制布局读次数上限               |
| `projection.diffApplyMs`           | 单次 Diff 应用耗时               |

### 8.3 回归纪律

- 对齐主仓：`reference/markdown-editor` 门禁 + e2e `ime-composition` 等 **资产不删**；块层新增对等门禁
- **禁止**以「关掉协同 / 只用 100 块 / 只测空文档」代过 P-Open-100k / P-Type
- 呈现引擎替换（D1）时：**本契约不变**；引擎适配层重写，窗口与 IME 契约保留

---

## 9. 竞品机制对照

### 9.1 AFFiNE / BlockSuite — **无文档级虚拟化（反例）**

证据见 round-A `05`：

| 点                                                 | 事实                             | 本产品对策                    |
| -------------------------------------------------- | -------------------------------- | ----------------------------- |
| Page `renderChildren` 全量 note/块                 | 根与 note 子树 **全部** Lit 挂载 | **窗口化挂载**默认            |
| 虚拟化只在工作区列表 / 实验表                      | 正文编辑器无对等 windowing       | 正文 = 一等虚拟化             |
| Inline `render` 整段；IME 可 `rerenderWholeEditor` | 热路径 O(段) 拆除                | O(触及) patch；IME 禁整树重建 |
| 远程选区 throttle 但仍全局重算                     | 布局读放大                       | 视口裁剪 + 增量 + 帧预算      |
| Yjs 在 JS 堆                                       | 与视图同尺度膨胀                 | 权威 RS；TS 窗口投影          |
| Edgeless idle = hidden 不卸载                      | 假虚拟化                         | 真 unmount / 预算             |

**结论**：AFFiNE 白板 culling/turbo 认真，**长文档 Page 默认路径不是我们的榜样**；要赢必须在架构上正面做文档级窗口，而不是同层再堆 flag。

### 9.2 思源 — **动态加载对照（可学方向，粒度升级）**

证据见 round-C `01` §4.4、`02`：

| 点    | 思源                                                                 | 本产品                                                           |
| ----- | -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 正文  | **非** React windowing；`dynamicLoadBlocks` 上下拼接加载             | 前端 **块窗口 + HeightMap**；文本可按块 lazy hydrate（思想同向） |
| 权威  | Go 内核；前端 DOM 乐观投影                                           | RS 权威；TS 投影（同构分层）                                     |
| AV 表 | 有虚拟行                                                             | 表/数据库默认窗口化（非实验旗）                                  |
| IME   | composition 与结构互斥；厂商 quirks                                  | 状态机一等；quirks 表自研                                        |
| 风险  | contenteditable HTML 字符串作 op 载荷 → **不利于精细 CRDT 与虚拟化** | Op 结构化；选区逻辑坐标；**不**以 HTML 为权威                    |

**结论**：思源证明「大文档必须按需出现在编辑面」；本产品用 **更精细的窗口 + 逻辑选区 + RS 切片** 升级，避免 HTML 字符串事务与接缝脆弱性。

### 9.3 AppFlowy

| 点                        | 含义                             |
| ------------------------- | -------------------------------- |
| 心在 RS，UI 订阅投影      | 与本层同向                       |
| 编辑器树 ↔ 后端 flat 适配 | 适配层可测、单一；**禁止**双权威 |
| 列表/网格虚拟             | 壳层有；块正文仍须自研窗口契约   |

### 9.4 本仓 markdown-editor（行级纪律源）

| 资产                          | 升级到块时                               |
| ----------------------------- | ---------------------------------------- |
| HeightMap / Oracle / 批量回填 | → BlockHeightMap + 块内行 HeightMap      |
| tanstack 窗口 + 命令式位置    | → 块窗口；滚动帧少 React 提交            |
| IME groupId / value 优先      | → 块焦点 pin + 结构键短路                |
| 逻辑 offset 选区              | → `blockId + offset`                     |
| 门禁与 e2e 专项               | → 块级对等；**禁止删除**既有行级测试资产 |

### 9.5 总表

| 维度         | AFFiNE           | 思源           | 行级本仓     | **本产品 D5**             |
| ------------ | ---------------- | -------------- | ------------ | ------------------------- |
| 文档级虚拟化 | ❌ 默认无        | △ 动态加载     | ◎ 行窗口     | **◎ 块窗口 + 懒 hydrate** |
| 权威位置     | Yjs/JS           | Go             | 行 store     | **RS**                    |
| 呈现         | 全量 Lit         | 全量/拼接 CE   | 窗口行       | **窗口块投影**            |
| IME          | 有洞（整编重建） | 成熟 quirks    | 状态机演进中 | **隔离 + 禁整树重建**     |
| 选区权威     | DOM/Y 相对位     | DOM + 块 id    | 逻辑 offset  | **`blockId+offset`**      |
| 远端选区     | 完整但重         | 弱于 AFFiNE UX | 分析级       | **克制 overlay + 预算**   |

---

## 10. 调包边界 vs 必须自研

### 10.1 可调包（公开 API 面）

| 依赖                                         | 用途                      | 边界                                         |
| -------------------------------------------- | ------------------------- | -------------------------------------------- |
| 虚拟列表库（如 `@tanstack/*-virtual`）或自写 | 窗口 index 计算、滚动监听 | **不**拥有 block 模型；高度以 HeightMap 为准 |
| grapheme / Intl.Segmenter                    | 偏移单位                  | 全仓统一一种                                 |
| D1 呈现内核（若选型 PM/Lexical 等）          | 窗口内富文本编辑          | 仅挂 **当前块/当前窗口**；不持全文 Doc       |
| 协同 awareness 传输                          | 已有实时通道              | 只传逻辑选区                                 |

### 10.2 必须自研（禁止包顶替）

| 模块                               | 原因                 |
| ---------------------------------- | -------------------- |
| ProjectionDiff 协议与收敛          | 与 RS/Op/schema 绑定 |
| WindowManager + pin/composing 规则 | 产品不变量           |
| BlockHeightMap 与折叠/嵌套语义     | 块树特有             |
| `blockId+offset` 选区层与跨块装饰  | 测试与协同契约       |
| IME 守卫与结构键表                 | 块命令集特有         |
| 远端 overlay 预算与静默样式        | 效果锁               |
| 乐观缓冲与失败单块恢复             | 禁止整页 reload 文化 |

### 10.3 否决路径

| 路径                         | 结构洞                                            |
| ---------------------------- | ------------------------------------------------- |
| 默认全量挂载「以后再虚拟化」 | 选区/CE 与全量耦合后补窗口成本爆炸（AFFiNE 张力） |
| 仅 CSS hidden 当虚拟化       | 内存与合成层仍线性                                |
| HTML 字符串当事务权威        | 难窗口、难 CRDT、难安全（思源勿复刻）             |
| IME 失败 → 整页/整编 remount | 破坏输入与大文档契约                              |
| 行级 Doc 冒充块工作区        | 效果锁冲突                                        |
| JS Y.Doc 全量 + 全量视图     | 与 RS 心、窗口投影双重冲突                        |
| React+Lit 双运行时进热路径   | 焦点/IME 桥接税（round-A R11）                    |

---

## 11. 推荐主路径 · 备选 · 迁移触发

### 11.1 主路径（锁定倾向）

1. **RS 权威 + ProjectionDiff**
2. **V1 块窗口 + BlockHeightMap + overscan + pin**
3. **逻辑选区 `blockId+offset`（anchor/head）**
4. **IME 状态机 + 合成期禁结构/禁卸载/禁整树重建**
5. **Awareness 远端选区：视口裁剪 overlay**
6. **editor-kit 共享；行级与块级模型分离（R1+R4）**
7. **超长单块启用 V6 块内行窗口**

### 11.2 备选

| 备选                                    | 何时考虑                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------- |
| 强化 V3 式内核分页（RS 只返回窗口文本） | 单机内存仍紧、文本 CRDT 全量不可驻留时——**仍保留前端窗口**，非回到全量 DOM |
| 块内完全自研 CE，不嵌行级               | 行级 embed 接口税 > 收益时；IME 纪律仍必须同源                             |
| overlay 改 canvas 批绘                  | 远端人数与 rect 数压垮 DOM 时                                              |

### 11.3 迁移触发（仅当不变量被破坏）

| 触发                                  | 动作                                               |
| ------------------------------------- | -------------------------------------------------- |
| 选定 D1 引擎无法做窗口化挂载          | 换引擎或降为块内 iframe 小文档——**不**放弃窗口契约 |
| 测量证明 HeightMap 误差导致不可用滚动 | 加强 oracle / 强制测量采样；不改回全量挂载         |
| IME 在目标 WebView 全灭               | 加深状态机与 beforeinput；**仍禁止**整树重建默认   |

---

## 12. 与 D1 / D2 / D4 / D6 的衔接摘要

| 单元         | 关系                                                                                   |
| ------------ | -------------------------------------------------------------------------------------- |
| **D1 呈现**  | 本文件约束其 **不得持权威、必须可窗口 patch**；IME/选区映射可落在 D1 适配层但契约属 D5 |
| **D2 合并**  | Diff 来源；大文档 merge 在 RS；合成期远端文本策略与 D2 并发语义对齐                    |
| **D4 存储**  | 按块懒加载字节；索引可派生；打开路径不读全文进 TS                                      |
| **D6 Agent** | 批 Op → 一次投影；工具读选区走逻辑坐标；`focus_block` 类对齐视口                       |

---

## 13. 魔鬼用例清单（实现/评审用）

1. 10 万块打开后立即中文 IME 输入首屏块
2. 合成未 end 时滚动远离再滚回
3. 合成中 Agent 修改同块文本
4. 跨 50 块拖选 + 虚拟化 unmount 中间块
5. 折叠含 anchor 的子树
6. 远端 20 光标 + 本地快速输入
7. 删除 head 所在块时的选区钳制
8. 超长 code 块（V6）内 IME + 块外滚动
9. `patch.fullRemountCount === 0` 于 P-Type 会话
10. 跳转末块后 Shift+方向扩展选区方向正确

---

## 14. 证据与输入索引

| 主题                 | 路径                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------- |
| Round D 计划 D5      | `docs/block-workspace-architecture/13-RoundD-核心技术栈选型计划.md`                          |
| 中途不换栈前提       | `docs/block-workspace-architecture/12-主控合并-全景与上限裁决.md` §4                         |
| AFFiNE 无文档虚拟化  | `docs/block-workspace-architecture/round-A-affine/05-缺点-性能与体验风险.md`                 |
| AFFiNE 映射/窗口建议 | `docs/block-workspace-architecture/round-A-affine/08-映射-Tauri-TS-RS与本仓差距.md`          |
| 思源 IME/动态加载    | `docs/block-workspace-architecture/round-C-expanded/01-思源-产品交互与AI工具面.md` §4        |
| 思源投影分层         | `docs/block-workspace-architecture/round-C-expanded/02-思源-内核事务与MD纪律.md`             |
| 行级↔块级 R1/R4      | `docs/block-workspace-architecture/round-B-appflowy/06-映射-AppFlowy-Rust心到Tauri-TS.md` §6 |
| 行级 HeightMap       | `reference/markdown-editor/src/core/HeightMap.ts`                                            |
| 行级性能路线         | `reference/markdown-editor/docs/analysis/01-性能帧率路线.md`                                 |
| 行级 IME/选区        | `reference/markdown-editor/docs/analysis/04-编辑深度扩展.md`                                 |
| 行级 IME 实现        | `reference/markdown-editor/src/components/HiddenInput.tsx`                                   |
| 渲染分层/滚动        | `reference/markdown-editor/docs/analysis/plan-A5-渲染分层.md` 等                             |

---

## 15. 诚实边界

- 本文是 **策略与契约**，不绑定某一 D1 库的最终票选；但 **任何 D1 票选必须通过 §1/§8**。
- 10 万块阈值的具体毫秒数需在目标硬件标定后写入 CI；未标定前以 **结构断言**（节点上界、fullRemount=0、IME 状态机、逻辑选区）为硬门禁，时间为软阈值逐步收紧。
- 画布（Edgeless）空间虚拟化是同源思想的 **二维** 扩展，验收另表；**不得**用画布 culling 叙事代替 Page 文档窗口化完成定义。

---

**文档结束（D5）**
