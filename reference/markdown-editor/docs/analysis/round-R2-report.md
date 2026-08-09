# R2 轮次报告（性能地基轮）

> 输入：R1 报告（652 通过率 53.2%、248 门禁）。输出：R3（流式轮）输入。

## 完成清单

| 任务 | Agent | 结果 |
|---|---|---|
| clone COW（块级写时复制） | R2-A | 1M 行 clone 1.1ms → 0.0017ms（650×）；击键 0.044ms/op |
| append 尾段（streamTail 零拷贝 + C4 契约） | R2-A | 主数组零重建；flush 三触发；4096 上界；物化兼容视图；getLine/getLineCount 访问器 |
| 行高模型（HeightOracle + HeightMap + C2 桥接） | R2-B | 类型倍率 + wrap 模型 + EMA 校准（修 3 个真实缺陷）；访问位置 0 行偏差；indexAt 5µs |
| 测量缓存（token 二分索引 + 双源合并） | R2-C | miss 路径 10×；同帧 1 次测量；滚动帧 0 Range；字体度量缓存 |
| 滚动管线（C1 契约 + 命令式位置） | R2-D | 纯位置帧零 React 提交；parseLine -94.5%；重渲染 -95.2%；layoutDeps 紧凑化 |
| fence 前缀 O(1)（交替性类型推导 + 零拷贝快速路径） | R2-E | 前缀重放 312µs → O(1)；引用复用 |
| 跨视口箭头列保持（数据层 + 列预测 + 滚动跟随） | R2-F | 修复 HiddenInput 滚动跟随真实缺陷；边界语义修正 |
| 验证（尾段测试 + 性能重测） | R2-G | 18 尾段用例；性能对比表；**发现 streamTail 残留缺陷** |
| 缺陷修复（编辑触达 tail 清空） | R2-H | 流式打字丢字修复；266/266 |

## 指标

- 门禁：248 → 266 全绿；编译 0 错误
- 性能对比（R0 → R2）：
  - 百万行加载 18.5s → **11.44s（-38%）**
  - clone@1M 1.1ms → ~0ms
  - 主数组重建 true → false（尾段零拷贝）
  - 滚动 layoutThrash **-33%**
  - ArrowLeft P95 -7.6%（getText 全量 join 瓶颈未覆盖）
  - 击键全链路 17.4ms（headless 软件渲染 layout 惩罚——真机待测）

## 遗留登记（R3+）

1. 击键全链路/append 端到端的**物化双数组成本**（~3.3ms 过渡期）——R2-BD 已改渲染走访问器后，物化可从热路径移除（R3 流式轮接入点）
2. ArrowLeft 的 getText 全量 join 瓶颈（grapheme 边界函数）
3. store vs parser fence 信息串判定既有偏差（` ``` js` 行）
4. 两帧校正（跨视口箭头）登记复杂度未落地（收益低风险高）
5. 中间位置编辑的行失效定位（HeightMap insert/delete 接 EditorStore 编辑区间）——R4 编辑轮
6. R2-B 10ms 口径修正：1M 全量构建物理下限 40-70ms，帧预算口径达标

## 输入 R3（流式轮）

- 招 1 末行直刷 DOM（限定纯文本行 + 渲染 flush 协议——09 C3）
- 招 2 物化移除（渲染走访问器）+ stop-flush
- append 光标冲突检测、流式合并 undo
- 软渲染（未闭合 fence/公式）
- 验收：500 token/s 注入帧率、流式期间用户编辑正确性
