# Review：P1 代码质量审查（ArrowLeft 根治 + 物化惰性化）

- 审查对象：提交 `9619532a`（ROUND-P1）
- 审查方式：纯只读静态审查 + 门禁复跑 + 性能声明实测复现
- 审查日期：2026-08-10
- 审查人：A1（阶段 1 分析 Agent，由主 Agent 派发）

## 总体评级：A-

无阻断项、无严重项。性能声明经实测复现（ArrowLeft avg 53.7µs vs 声明 48µs；append avg 82.3µs vs 声明 86µs，同一量级），语义等价性有穷举测试支撑，618 门禁复跑全绿。存在 2 项一般项（声明范围与实现覆盖不完全一致）与若干轻微项（见回修清单）。**建议通过**，回修清单为可选项，不阻塞合入。

---

## 1. 正确性

### 1.1 moveGrapheme 跨行语义（结论：正确，证明可信，盲区轻微）

**证据**（`src/core/EditorStore.ts:1634-1656`）：

逐分支核对（以全文模式 `\n` 为普通字符为参照）：

| 场景 | 行文本模式实现 | 全文模式参照 | 等价 |
|---|---|---|---|
| 行内向左 | `lineStart + findPrevGraphemeBoundary(lineText, inLine)` | `findPrevGraphemeBoundary(text, pos)`（同函数，行内窗口不跨 `\n`） | ✓ |
| 行首向左 | `lineIdx > 0 ? lineStart - 1 : 0` | 跨过 `\n` 落在换行符前一格 | ✓ |
| 行内向右 | `lineStart + findNextGraphemeBoundary(lineText, inLine)` | 同函数 | ✓ |
| 行尾向右 | `lineStart + len + 1`（`p >= textLength` 时不动） | 跨过 `\n` 落在下一行行首 | ✓ |
| 空行（行首=行尾） | `inLine = 0 = len`，两分支天然覆盖 | 空行左/右移各跨一个 `\n` | ✓ |
| 连续换行 | 行首向左一步 = `lineStart - 1`（落在空行行尾），与全文逐字符跨 `\n` 序列同终点 | ✓ | ✓ |
| 文档首行行首 | 返回 0 | 边界不动 | ✓ |
| 文档末尾 | `p >= textLength` 返回自身 | 边界不动 | ✓ |

- `findLineIndex` 的边界归属（行首归属本行、行尾+1 归属下行、textLength 归属末行）与 `lineStart/inLine` 换算逐点核对一致（`SegmentTree.ts:104-125` 实现分析，`DecorationSet.ts:48` 注释佐证行首归属语义）。
- `getLine`（双段访问器，`EditorStore.ts:1438-1444`）与 `lineOffsets`（树与逻辑全量一致）作为定位基础，尾段模式下同样正确（1d 测试覆盖）。

**测试覆盖评估**（`tests/unit/arrow-perf.test.ts`）：

- 1a/1b：12 份随机文档（ASCII/中文/代理对 emoji/ZWJ 家庭 emoji/组合字符/`\n`/Tab）× 全部位置 × left/right 穷举对照全文模式——覆盖面强。
- 1c：10 组边界形态（空文档/单字符/单换行/空行居中/尾部换行/首部换行/全空行/emoji 跨行/组合字符跨行）。
- 1d：尾段非空（流式期间）模式穷举。
- **同源局限性**：1a/1b 的对照方正是被替换的旧实现 `findPrev/NextGraphemeBoundary`——等价性证明不独立于 grapheme 工具函数自身的正确性。缓解：1c 边界例独立验证 + `grapheme.test.ts`（6 用例）既有独立测试；grapheme 工具本身未改动。
- **盲区（轻微）**：DOC_PIECES 与边界例均无 `\r`（CRLF 文档）。理论分析行文本/全文两模式对 `\r` 行为一致（`\r` 为行文本尾部普通字符，跨行落点同为 `\r` 上），但无测试佐证。
- **防御性盲区（轻微，不可达）**：`pos` 为 NaN 时 `clamp` 会传播 NaN 进入树查询；所有调用方（HiddenInput 分支、extendSelectionByDirection）传入值恒为合法数字，实际不可达。

**结论**：语义正确性成立，证明可信；盲区限于 CRLF 与 NaN 两个轻微项。

### 1.2 lazyViewProto 原型链 getter（结论：方案正确，无坑；两个低风险窗口）

**证据**（`EditorStore.ts:1041-1062`、`2406-2413`、`2430-2474`）：

- **zustand 版本兼容**（package.json: `zustand ^5.0.14`）：v5 `setState` 的合并路径为 `Object.assign({}, state, nextState)`，只复制**自有可枚举属性**，不触碰原型链 getter——注释声称的"不被 Object.assign 固化"成立（旧 getter 方案的坑已被规避）。`create` 初始 state 直接 `setPrototypeOf(lazyViewProto)` 挂原型，无需 `Object.create`。
- **原型恢复链**：每次 `dispatchSet` 后 `Object.getPrototypeOf(s) !== lazyViewProto` 时 `setPrototypeOf` 恢复——覆盖 `replace` 路径；空操作（函数返回 state 引用）时 zustand `Object.is` 判定跳过替换，原型未丢，判断后跳过（幂等）。与 v5 实现逐句核对一致。
- **多实例安全**：`lazyViewProto` 为全局共享对象，getter 经 `this` 绑定各实例 state，`createEditorStore()` 多实例共用无冲突。
- **性能**：`setPrototypeOf` 每次 set 一次，对新对象（合并产物）设置原型 ~百纳秒级，已含在 append 0.082ms 实测内，无热路径担忧。

**低风险窗口（轻微）**：

1. **订阅同步窗口**：`rawSetState` 内部同步触发 listeners，此刻 `setPrototypeOf` 尚未执行——若非 React 订阅者在监听回调内同步读 `state.lines` 会得到 `undefined`。项目内 `subscribe` 仅测试使用（store-factory/readonly，均不读 lines）；React 订阅者的 getSnapshot 在渲染期执行（批处理后），无实际风险。建议注释登记。
2. **enumerable: true 的 for-in 副作用**：getter 被定义为可枚举，`for...in` 遍历 state 会触发惰性物化并多出 3 个键。当前无 for-in/`Object.keys(state)`/`JSON.stringify(state)` 消费方（全库检索确认），无实际影响。

### 1.3 getText 双段拼接（结论：等价正确）

`EditorStore.ts:1422-1433`：尾段为空 `mainLines.join`（零物化）；非空时 `head.slice(0,-1).join + '\n' + tail.join`，其中 `head.length === 0` 时返回空串 + `tail.join`（正确复现旧物化视图 `[].concat(tail).join` 的无前导换行语义）。与旧 `s.lines.join('\n')`（物化视图）逐情形核对等价。

---

## 2. 架构一致性（结论：延续既有模式，一处重复实现风险 + 一处声明失准）

**证据**：

- **延续模式**：双段存储 + 访问器（getLine/getLineCount）+ 订阅信号（main*/streamTail* 引用），与 R2-A/R3-B1 既有约定一致；HiddenInput 订阅改为 `mainLines + streamTail + getLineCount()` 三信号（`HiddenInput.tsx:376-382`），BlockRenderer 改为 `isInUnclosedFenceParts` 五信号（`BlockRenderer.tsx:71-99`）。appendText 全量更新尾段三字段（`EditorStore.ts:2065-2087`），信号覆盖所有内容变更路径（编辑/append/undo/flush），与物化视图引用变化触发语义等价（已逐路径核对）。
- **BlockRenderer 语义等价**：`boundary = mainLineCount - 1`、`getState(i)` 双段分派、`lastFence` 尾段平移（`boundary + tailFenceLines[last]`）与物化 `fenceLines` 的 concat+平移语义逐点一致（`BlockRenderer.tsx:31-63`）。`mainLines.length` 作为 selector 信号，任何内容变更都会换引用，无误报。
- **props.store 接线点**：`store?: EditorStore` 可选注入，缺省回落全局单例，R5 实例化兼容，无破坏性变化。
- **重复实现（一般）**：双段合并语义现散布于 7 处独立实现——`materializeViews` / `getText` / `flushStreamTail` / `getLine` / `getLineCount` / `appendText` 内联访问器 / `isInUnclosedFenceParts`，语义靠测试维系（cross-matrix/append-* 均有 verifyConsistency 收敛断言），无公共抽象。属可接受现状（各点需求略异），但后续改动需警惕漂移。
- **声明失准（一般）**：提交声明"consumers switched to dual-segment signals，运行期零读者"——实际 `src/core/measure.ts:886-889`（navigateOffscreenLine，视口外垂直导航）与 `src/main.tsx:28`（调试指标 `getLineCount`）仍是 `store.lines` 读取者。惰性 getter 功能兼容（尾段空时零拷贝引用主数组，无成本），但**尾段非空（流式期间）视口外导航每键触发 O(全文) concat 物化**——P1 的物化收益在该路径未完全兑现，且该路径正是 Up/Down 按键热路径的一部分（触发频率低：仅目标行视口外时）。

---

## 3. 性能声明核实（结论：实测复现，方法可信；旧值不可复现为固有局限）

**实测**（本轮复跑，同仓库机器）：

```
[R6-P1 perf] ArrowLeft x100 avg=0.0537ms max=0.6129ms (1M lines)
[R6-P1 perf] append@1M+3k tail avg=0.0823ms x100
```

- 声明 48µs/键、0.086ms append：与实测同量级（声明值略优于实测，可能为开发机多轮最佳值；声明"~300x"倍数基于旧实现基准）。
- **方法评估**：
  - 链路完整：2a 测 `moveGrapheme + setCursorPos` 全链路（含 dispatchSet 归一/合并/通知/原型恢复），与 HiddenInput 真实按键分支同构，无只测函数不测链路的虚报。
  - 次数与阈值：100 次平均，阈值 1ms/0.6ms 远宽于实测（18x/7x 余量），抗 CI 抖动设计合理。
  - **无暖机**（轻微）：首个采样含 JIT 编译，100 次平均后影响 <1%，可接受。
  - **旧值不可复现**（轻微，固有局限）：14.5ms（全文 join 路径）与 3.6ms（set 热路径 concat）为声称值，无基准对照测试代码，无法在 CI 复现验证；性能断言只做"新实现绝对上限"护栏，不做"相对旧实现改善"验证。
  - **2b 构造瑕疵**（轻微）：`store.setState({ streamTail: ... })` 只设行文本不设 `streamTailCodeState`（3000 行尾段 vs 空 codeState），此时物化视图 `codeBlockState` 长度与行数不匹配——测试只断言了 `lines.length` 未触雷，但暴露测试构造不完整；不影响被测性能路径（append 只测耗时）。
  - **未覆盖**：append 超 4096 行上限触发 `mergeTailInto` 强制合并的场景（此时 append 成本含全量合并，为既有设计，非 P1 引入）。

**结论**：性能声明可信，测试方法基本严谨；"48µs"与"0.086ms"的绝对数字经独立复跑成立。

---

## 4. 可维护性（结论：良好；4 项轻微）

**优点**：注释质量高（R6-P1 标注、动机/历史坑说明详尽准确）；无死代码、无遗留调试（性能 `console.log` 属测试资产，合理）；新测试文件已入库（git 确认）；接口补全（verifyConsistency 声明：提交前实现存在但接口缺失，本次补齐，修正了一个类型缺口）。

**轻微项**：

1. **dispatchSet 死结构**（`EditorStore.ts:2463-2467`）：if/else 两分支完全相同（`rawSetState(normalized, replace)` 重复两遍）——提交前 if 分支为 `materializeViews` 产物，移除后未合并。应合并为单语句。
2. **注释与实现措辞不符**（`EditorStore.ts:1374`）：注释写"初始 state 经 `Object.create(lazyViewProto)`"，实现为字面量对象 + `Object.setPrototypeOf`（2408-2412）。语义等价但措辞应修正。
3. **lazyViewProto 类型擦除**（`EditorStore.ts:1041`）：`Record<string, unknown>` + `Object.defineProperty`，getter 无类型保障（由接口字段声明兜底）。可接受，可注明。
4. **Home/End 重构**（`HiddenInput.tsx`）：从 O(全文) 扫描改为 `LineOffsetTree` O(log n) 定位，语义核对等价（含 CRLF 情形），是正向简化；但该改动扩大了 P1 影响面（提交主题之外），已随门禁验证，无问题。

---

## 5. 回归风险（结论：618 全绿复跑成立；隐藏消费者全部兼容）

**门禁复跑**：`npm test`（vitest run tests/unit）= 608 passed（含 arrow-perf 7 新用例）；`tests/gate` = 10 passed；608+10=618 与提交声明一致。typecheck 由门禁前置（618 含 typecheck，CI 快层强制）。

**隐藏消费者清单（全库检索）**：

| 位置 | 读取 | 惰性 getter 兼容性 | 风险 |
|---|---|---|---|
| `measure.ts:886-889`（navigateOffscreenLine） | `store.lines.length` / `store.lines[targetIdx]` | 功能 ✓（尾段空零拷贝） | 尾段非空时 O(全文) 物化/次（见 §2，一般项） |
| `main.tsx:28`（`__CRISH_METRICS__.getLineCount`） | `lines.length` | 功能 ✓ | 调试接口非热路径，可改 `getLineCount()` |
| 既有测试 20+ 文件 | `getState().lines/codeBlockState/fenceLines` | 功能 ✓ | 非性能敏感，语义由 618 门禁验证 |
| MarkdownEngine/LineItem | 已切换访问器（R3-B1） | — | ✓ |

**已排除的风险**：

- 无残留 `s => s.lines` 订阅选择器（组件层全库检索确认）——排除 useSyncExternalStore getSnapshot 不稳定导致的无限重渲染警告风险；但该风险已因 getter 每次返回新数组（尾段非空时）而**放大**，未来引入此类订阅会立即触发，建议在 lazyViewProto 注释中登记。
- 无 `JSON.stringify(state)` / `structuredClone` / `for-in` / `Object.keys` 消费方——排除序列化丢失视图字段风险。
- 空操作 dispatchSet 路径：`normalizeSetStatePartial` 浅拷贝 current 恒产生新对象 → zustand 总是替换并通知（与提交前行为一致，无回归）；且该路径旧版还会触发 O(全文) 物化 concat，新版免除（附赠收益）。
- 引用稳定性差异（尾段非空时每次读取新数组）：唯一做引用比较的消费者 HiddenInput 已改双信号，无其他残留。
- 实例工厂：`createEditorStore()` 多实例共享 `lazyViewProto` 原型，安全；`store.setState` 被 dispatchSet 替换的既有模式未变。

**结论**：回归风险可控，无隐藏消费者破坏；618 全绿充分（等价性穷举 + 既有全量 + 收敛断言 verifyConsistency 三层）。

---

## 需回修清单（建议，均不阻塞）

| # | 级别 | 项 | 建议 |
|---|---|---|---|
| 1 | 一般 | `measure.ts:886-889` 仍读 `store.lines`，流式期间视口外导航触发 O(全文) 惰性物化；提交"运行期零读者"声明失准 | 改用 `getLineCount()` + `getLine(i)`（一行级改动），并更新 measure.ts:21 过时注释；或至少在计划文档登记 |
| 2 | 一般 | 双段合并语义 7 处重复实现 | 维持现状可接受；若后续再增第 8 处，建议抽公共 `lineAt(i)/stateAt(i)` 访问器对 |
| 3 | 轻微 | dispatchSet if/else 死结构（2463-2467） | 合并为单语句 |
| 4 | 轻微 | 1374 行注释 "Object.create" 与实现 setPrototypeOf 不符 | 修正措辞 |
| 5 | 轻微 | 1a/1b 等价性对照为同源（对照方即被替换实现） | 可增 1-2 个手工构造的全文参照用例（如 CRLF、行尾代理对），独立于工具函数 |
| 6 | 轻微 | 2b 测试构造：只设 streamTail 不设 streamTailCodeState（行/状态数不匹配） | 补 `streamTailCodeState: new Array(3000).fill('none')` |
| 7 | 轻微 | 订阅同步窗口（rawSetState 后、setPrototypeOf 前，非 React listener 读 lines 得 undefined） | lazyViewProto 注释登记该窗口 |
| 8 | 登记 | Up/Down 垂直导航保留全文 `getText()`（snapToGraphemeBoundary）与 DOM 测量，1M 行文档下仍有毫秒级延迟（P1 只根治 Left/Right，声明范围如实） | 列入后续优化方向；`main.tsx:28` 调试接口可顺手改 `getLineCount()` |

---

## 结论

P1 提交的核心两项（ArrowLeft 行文本模式根治、物化惰性化）实现质量高：语义正确性有穷举级测试证明（盲区轻微），原型链方案对 zustand v5 语义理解准确且坑位记录充分，性能声明经独立复跑成立（量级一致），618 门禁全绿核实。架构上延续既有双段/访问器/信号模式，无新断层。子 Agent 本轮输出**左右摇摆未见质量迹象**——方向键从"全文 join"到"行文本模式"是根因级收敛而非补丁，物化惰性化从"set 时物化"到"原型链按需物化"是同一路线的自然深化；与前期 R2-A/R3-B1/R3-C 的访问器切换脉络一致，属既有架构规划的落地而非反复。总体评级 A-，建议合入并执行回修清单（2 项一般 + 若干轻微，均不阻塞）。
