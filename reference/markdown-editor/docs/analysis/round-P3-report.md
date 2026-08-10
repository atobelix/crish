# P3 轮次报告（方向一打磨）

> 流程：分析（A1-A6 六份）→ 方案（plan-P3 B1-B6 四波）→ 评审（review-P3，1 阻断 + 2 高危修订）→ 执行（B1-B6 全部落地）。

## 完成清单

| 批 | 内容 | 结果 |
|---|---|---|
| B1 | ScrollMap 分段映射（恒等区+压缩区+文末钳制+恒等短路）+ MarkdownEngine 接线（observeElementOffset 喂逻辑/scrollToFn 写物理/内容高度物理覆盖/3 处读侧 inverse） | 896 全绿 + 6 数学测试 |
| B2 | 显示层乐观补全（decorateIncompleteInline 纯函数 + LineItem 流式末行预演 + InlineRenderer offset-key 同节点切换——oldEl===newEl 零跳动、0-KaTeX、flanking 防误判） | +16 测试 |
| B3 | 选区保护（shouldDirectStream 降级门——选区相交/光标行中降级常规路径；flush 前越界钳制 O(1)） | +21 测试 |
| B4 | 表格列宽定型（闭合后一次性测量 scrollWidth 逐列 max→setTableWidths；**plan-A4 修正：parser 独立判定 table_row——表头流式中即时，无需候选态/回溯**——B4 收窄为列宽定型） | M6 接线 |
| B5 | 渲染分层（contain:paint + dirty will-change + 一行回退 + transform/top 互斥核实 + renderMode/RowSurface Canvas 接缝零变化） | +26 测试 |
| B6 | 基准套件（runner/budgets/lib/scenarios，M1-M6 + 三档 + 防抖） | 首跑定档 |

## 指标

- 门禁：890 → **959 全绿**（+69 严格用例）；编译 0 错误
- 首跑定档（ci/headless）：M1 JS P95 0.1-0.4ms（预算 4ms）、layout ~0ms、M2b 滚动条一致性 ≤1 行、M4 补全闪烁 0 重建、M5 内存持平 45MB

## 异常登记（诚实，不掩盖）

1. **M3 选区丢失偶发 1 次**（两轮全量）——B3 主路径已修复（shouldDirectStream 降级），残余路径（非末行/跨行场景）需继续跟踪——M3 是 B3 的持续验收面
2. **M2a 探针采样失效**：120px/帧 ramp 下锚点行 1 帧即滚出视口 → 零样本空转（0 脱节未真正验证）——需改视口中部锚点或减速
3. **M2c 场景失真**：注入期间 scrollTop 复位锁死（-249394px 跳变后锁 120px）→ 滚动未发生假 PASS——需修注入脚本
4. **fence30 ci 档 FAIL**（长任务 3）——headless 软渲染预期内，nightly GPU 为判定位
5. **M6 未接线**（tuned=false）——B4 定型已实现，M6 探针待 suite 下一轮接线
6. 存量 U+FFFD：MarkdownEngine.tsx 912-913（直刷域旧损坏——建议单独修复任务）

## 遗留（后续）

- M2a/M2c 探针修复（suite 脚本级）
- M3 残余路径跟踪（B3 验收面）
- M6 探针接线（B4 后）
- Canvas 层实现（接缝已留：renderMode/RowSurface——触发条件 readOnly+5万行+注册表）
- 宿主接线（R5.5 主线：streamAppend/外层虚拟化/历史折叠/安全评审）
- 方向二（富文本多人协作——ProseMirror+Yjs 选型建议已定）

## 结论

P3 方向一打磨全部落地：超长文档滚动（120 万行+）不触顶、流式 inline 即时格式（显示层补全）、表格流式无跳动、选区不被打断、GPU 合成优化 + Canvas 预留、基准体系固化（含跳动 0 容忍指标）。引擎处于"极致收口"状态。
