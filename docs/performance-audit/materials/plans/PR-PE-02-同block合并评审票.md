# PR-PE-02 · 同 block 追加合并（契约评审票）

> **战役**：performance-fix · D11  
> **状态**：**待评审** — 未通过前禁止实现 token N 合 1  
> **阻塞**：03-R1 / 簇 C1 源头收敛  
> **评审前合法旁路**：D1-E 真缓冲（仅 flush 时机）已可做；不得拼接事件体  

## 现状锚点

- `crates/session-loop/src/provider.rs:191-193` — PE-02 增量性硬约束明文禁止跨帧聚合  
- 契约 SoT：`docs/**/PE-02-streaming-markdown-plan.md` §3.1.2（以仓内现行文件为准）  
- 旁路减负已可：审计 fanout meta、NoPersist、工具输出 Arc（不改合并语义）  

## 提案（待会签）

允许 **同一 markdown block 内** TextDelta 在时间窗（预算常量，非硬编码散落）内追加合并后再 emit；**禁止**跨 block 合并、禁止丢 delta 顺序、禁止合并 thought 与 text。

## 通过后必做

1. 升 schemaVersion 或保持 wire 兼容证明（合并对前端累计文本逐字节等价）  
2. 重新生成 parser + registry_drift + golden  
3. 20 万条 delta 压测全绿 + 末尾 flush 延迟 ≤ 窗口  
4. 负向：无窗时逐条 emit 路径仍存在  

## 否决后果

保持现状逐条 emit；只允许旁路减解析与真缓冲 flush；**不得**静默合并。

## 会签

| 角色 | 决定 | 日期 |
| ---- | ---- | ---- |
| 主控 | — | — |
| 用户/架构 | — | — |
