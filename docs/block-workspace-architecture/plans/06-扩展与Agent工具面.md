# 06 · 扩展与 Agent 工具面（分维度任务书）

| 字段       | 内容                                                               |
| ---------- | ------------------------------------------------------------------ |
| **效果**   | EL-05/07：Agent 块 mutate + TS 扩展一等                            |
| **文件域** | `crates/agent-tools`、`session-loop` 扩展点、`packages/plugin-sdk` |
| **依赖**   | 01 apply；03 get_md/apply_md；02 search                            |
| **锁定**   | D6：View∥Command；统一 Registry；禁 DOM/盘旁路                     |

### S1 + 写路径

- 读 md = 即时 S(树)；`read_file(笔记路径)` 若暴露 → 必须经 import 检测或拒
- `document_write_md` ≡ 事务化 `apply_md` / replace_via_tx；**禁止** `fs.write` 后当权威
- 验收含 **A-EXT**（D7）+ A-AGT；恶意扩展零版本变化

---

## 1. 目标模块

1. 笔记工具注册：`block_*` / `document_*` / `search_*` / `outline_*` / `ref_*` / `block_batch`
2. **safeActions × ActionEffects × Source** 矩阵 + 会话 batch token
3. MCP：同一 registry 外壳（stdio 可延续）
4. 扩展 **contribute points**：slash / widget / blockView / keymap
5. TrustGate：`note:read|write`、`ui:contribute`
6. 领域 system prompt 片段（工具描述陷阱，学思源）
7. dryRun / 幂等 batchId / execution_unknown

## 2. 不变量

- 工具写 → 仅 Transaction.apply
- 读 md → S(树) 即时，不默认 mirror 文件
- 插件无法提升权限绕过审批

## 3. 验收 ID

A-AGT-01…08，恶意扩展零持久化，确认矩阵表驱动测

## 4. 禁止

Agent 改 DOM；file 工具写笔记数据当局；第二套 in-process 写库

## 5. 与本仓

延续 session-loop 审批三态；笔记工具命名避免 `mcp_*` 冲突。
