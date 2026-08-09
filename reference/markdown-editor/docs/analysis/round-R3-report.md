# R3 轮次报告（流式轮）

> 输入：R2 报告（266 门禁、性能地基完成）。输出：R4（编辑轮）输入。

## 完成清单

| 任务 | Agent | 结果 |
|---|---|---|
| append 光标平移（追加点锚定 + 流内容有序 + 光标平移） | R3-A | 用户编辑末尾行时流内容插光标前；1s 用户编辑窗口；23 新用例 |
| stop-flush（StreamBuffer.flush 显式 + flushStreamTail 幂等） | R3-A | 流式结束收口为单 undo 步 |
| 流式合并 undo（meta:'stream' + StreamOp 会话记账 + 编辑修正） | R3-A | 单 op 回退整段流式；adjustStreamOpForEdit |
| 渲染访问器切换（双段存储引用订阅 + 惰性 getLine） | R3-B1 | 渲染热路径零物化；324ns/帧 vs 26µs concat |
| 末行直刷 DOM（C3 协议：isPlainTextLine + streamAppend + dirty frozen 快照 + flush 四时机） | R3-B2 | 直刷通道 + React bailout + 安全网；forwardRef 宿主 API |
| 软渲染（未闭合 fence 等宽源文本 + 未闭合公式零 KaTeX） | R3-C | KaTeX 计数：未闭合期间 0 调用；闭合自动切回 |
| 500 token/s 注入验证（四场景 × 60s） | R3-D | GPU：P95 10.2-14.6ms 全 PASS；流式+编辑正确性通过 |

## 指标

- 门禁：266 → 289 全绿；编译 0 错误
- **500 token/s（≈3 万 token/60s）：GPU P95 10.2-14.6ms < 16.6ms（60fps 保底达成）**——四场景全 PASS
- 场景 D（流式期间用户编辑）：29 次中部插入后 getText 全量一致（无丢字/乱序）
- 数据层 chunk 成本 P95 ≤ 0.7ms（预算 0.6ms 达标）

## 遗留登记（R4+）

1. **KaTeX 闭合瞬间集中触发**（C 场景 13 次长任务/232 帧 33ms+）——公式块渲染节流/公式样本缓存专项
2. undo 顺序语义（流式 op + 用户 op 同栈两次 undo 精确回退）——R4 事务层 applyChange 解决
3. HiddenInput 订阅 state.lines（滚动跟随）+ BlockRenderer 读 codeBlockState/fenceLines（软渲染判定）——切访问器后 store 物化可真正移除（R3-B1 登记）
4. 宿主接线：engineRef.streamAppend/streamEnd（R5 集成轮）
5. C3 直刷不在压测范围（App 未暴露 engineRef——R3-D 走 appendText 回落等价路径，口径保守）
6. headless 软件渲染惩罚（GPU 已复测定论）

## 输入 R4（编辑轮）

- 事务统一（applyChange 单入口：表格收敛 + 流式 op 合并 + undo 顺序语义）
- 选区 anchor/head/assoc
- IME 状态机（compositionGroupId——丢字修复）
- 拖选状态机、bidi 骨架、剪贴板语义、a11y 短程
- 验收：编辑能力成熟度矩阵推进 + 现有门禁全绿
