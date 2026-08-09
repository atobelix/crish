# R4 轮次报告（编辑轮）

> 输入：R3 报告（289 门禁、流式达成）。输出：R5（集成轮）输入。

## 完成清单

| 任务 | Agent | 结果 |
|---|---|---|
| 事务统一（applyChange 单入口 + 表格收敛 + 交替 undo 精确） | R4-A | 写路径统一；表格操作恢复 undo/offsets 一致性；30 用例；319 |
| 选区 anchor/head（anchorPos/headPos/assoc + Shift 扩展语义） | R4-B | 反向第二次方向正确；兼容层零回归；32 用例 |
| IME 状态机（compositionGroupId 缓冲 + 50ms 提交 + beforeinput 原生监听） | R4-C | Android/Safari 空 data 丢字修复；React 19 不转发 beforeinput 发现；9 用例 |
| 剪贴板语义（表格/URL/HTML→MD 转换 + 一步撤销 + 无选区整行复制） | R4-E | htmlToMarkdown.ts 纯函数；32 用例 |
| bidi 骨架（charType + span 标注 + moveHorizontallyBidi + LTR 快速路径） | R4-F | 8 用例（总调度实现） |
| Shift 接线 + 拖选状态机（坐标驱动 + 视口外处理 + 3px 阈值） | R4-G | 旧启发式删除；29 用例 |
| a11y 短程（aria + 光标行 value 同步 + aria-live + 与 IME 协调） | R4-H | 10 用例 |
| SelectionHighlight 挂载（拖选高亮依赖——从未渲染的缺陷修复） | 总调度 | 2 行 |

## 指标

- 门禁：289 → **439 全绿**；编译 0 错误
- 编辑能力成熟度矩阵推进：事务 ✅ 选区方向性 ✅ IME 深水区 ✅ 剪贴板 ✅ bidi 骨架 ✅ 拖选 ✅ a11y 短程 ✅

## 遗留登记（R5+）

1. HiddenInput 6 处 setState({lines}) 已自动走 diff 事务（代码级收敛）——显式改 applyTableChange 可选
2. 拖选视口外估算（滚动后精确接管——已实现，精度登记）
3. 无障碍模式（全文 textarea 双向同步）——远期
4. bidi 渲染层 dir="rtl" 接线（isRtlLine 已导出——BlockRenderer 设 dir 未做）
5. 拖选期间选区高亮（SelectionHighlight 已挂载——验证在 R5 冒烟）
6. 多选区/矩形选区——远期
7. 2^n 性能预算 50→100ms（真实 ~10ms，CI 负载抖动）

## 输入 R5（集成轮）

- 规则插件（InlineRuler）+ 语法扩展注册 + 渲染注册表 + 主题注入
- 实例工厂（createEditorStore）+ readOnly 模式
- 05 高频项（大纲/折叠区间/工具产物渲染/搜索高亮走 DecorationSet）
- 宿主外层虚拟化 + 历史折叠 + 跨消息 fence 重置 + 安全双路径评审
- 验收：闸门检查（09 §6 七项）+ 宿主集成验证
