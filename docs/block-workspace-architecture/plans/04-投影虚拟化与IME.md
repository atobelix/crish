# 04 · 投影、虚拟化与 IME（分维度任务书）

| 字段       | 内容                                                                             |
| ---------- | -------------------------------------------------------------------------------- |
| **效果**   | 10 万块可滚；输入不整树拆；选区逻辑坐标                                          |
| **文件域** | `packages/editor-kit/**`（新建或抽）、块编辑器状态模块；**不**改行级引擎内部模型 |
| **依赖**   | 01 的 Diff/事件；可 mock 先行                                                    |
| **锁定**   | D5 + D7：块窗口 + HeightMap + pin；IME 状态机                                    |

---

## 1. 目标模块

1. **ViewportQuery** / 窗口索引
2. **BlockHeightMap**（预估+实测回填）
3. **pin** 规则：焦点块、composing 块
4. **SelectionStore**：`blockId+offset` / 块多选
5. **IME 状态机**：Composing 禁结构键、禁 slash、禁 unmount 焦点
6. Diff 应用器：增量 patch；`fullRemountCount` 指标
7. 远端 awareness overlay（视口裁剪）

## 2. 与行级共享

可抽：IME 守卫思想、虚拟滚动工具、data-* 映射纪律。  
**禁止**共享 Doc store / lines[]。

## 3. 验收 ID

A-IME-01…08，A-SEL-01…06，A-PERF 滚动/输入，A-COL-02

## 4. 禁止

CSS hidden 假虚拟化；composition 中整树 remount；像素测距选块

## 5. 高代价正当项

完整 HeightMap + pin 矩阵——直接决定能否超过 AFFiNE 大文档体验。
