# Crish/conex 主审总报告 · BATCH-08～27

> 仓库：`C:\Software\conex` · 分支：`refactor/architecture` · 无 git remote
> 日期：2026-09-07 · 主审：main（三路并行）· 待二次核查：code-audit（见 `secondary-checklist.md`）
> 分报告：
> - `BATCH-08-14-review.md`
> - `BATCH-15-21-review.md`
> - `BATCH-22-27-review.md`

---

## 1. 综合结论

| 区间 | 综合印象 | 关键风险 |
|------|----------|----------|
| BATCH-08～14 | B / B- | IPC 契约回归（审批列表 Null） |
| BATCH-15～21 | **7.0/10** | 本地文件任意读（shell 兜底） |
| BATCH-22～27 | **5.8/10** | 拖放任意读盘 + 非视觉模型泄漏路径/dataUrl |

**总体判断**：架构收敛方向正确（注入卡片废除、预览桥单轨、DOMPurify、可执行后缀拦截、RELAY_SECRET 加固），但 **本地文件读盘链路缺少工作区沙箱** 贯穿 BATCH-21→23→24，属于合入前应优先止血的 P0；其次是 BATCH-14 审批命令契约回归与多路拖放双入队。

---

## 2. P0（合入前建议先修）

| ID | 批次 | 问题 | 证据落点 | 建议 |
|----|------|------|----------|------|
| P0-1 | 21/23 | `localFileReader` 经 `workbench_run_shell` 可读**任意本机路径**；拖放 `tauri://drag-drop` → `handlePathsSelected` 放大暴露面 | `localFileReader.ts`；`useChatAttachments.ts`；ChatCard drag-drop | 强制 `resolveWorkspacePath` / allowlist；禁止 shell 读盘兜底或仅限用户显式授权路径；补安全单测 |
| P0-2 | 24 | 非视觉模型仍把 **dataUrl / 绝对路径** 写入 prompt；消息持久化 `source/path` | `multimodal.ts`；`useSlashSend.ts` | 非视觉模型只发文件名摘要；落盘禁用完整 dataUrl/绝对路径 |
| P0-3 | 14 | `listPendingApprovals` 传 `serde_json::Value::Null` → 反序列化失败 → 恒 `CmdInvalid` | `apps/agent-workbench/src-tauri/src/server/ws.rs` | 传合法空对象/`{}` 或改参数为 `Option`；加契约单测 |

---

## 3. P1（高优先）

| ID | 批次 | 问题 | 建议 |
|----|------|------|------|
| P1-1 | 23/24 | ChatCard + window + DropHost + Tiptap **多路拖放**易双入队 | 单一消费方 + 幂等 attachment id |
| P1-2 | 21 | `writeTextFile` / `toAssetUrl` 未像 `readTextFile` 拒绝空路径 | 对称校验 |
| P1-3 | 15/26 | preview `postMessage` 只验 `source` 不验 `origin`；桥端 `'*'` | 校验 origin；收紧 targetOrigin |
| P1-4 | 08 | `dispatch*` 空壳仍被调用（半删除） | 删 stub+调用或改显式反馈 API |
| P1-5 | 20 | 应急草稿只写不读回 | 启动/开文档恢复路径 |
| P1-6 | 23 | 计划条 `getSessionById` 无订阅，进度可能不刷新 | 订阅 session store |
| P1-7 | 10 | 虚拟代码测高 `isMeasuredRef` 永久锁定 | 字号/缩放变化时重置测高 |

---

## 4. P2 / 中低（可排期）

- BATCH-09：GFM emoji 短码 vs AGENTS §21 禁 Emoji 纪律冲突
- BATCH-11：jsonc/jsonl 格式化假开通；大文件 `split('\n')` 回潮
- BATCH-17：标题 token 双轨不一致；markdown 合规脚本未进 `check:desktop`
- BATCH-18：门禁扫描面偏窄
- BATCH-27：骨架屏多层 `data-tauri-drag-region` 可能吞点击
- 文档 BATCH（12/19/25）体量大，缺与实现同步门禁

---

## 5. 做得好的地方（抽样）

- BATCH-08：物理删除 `chat-injection/`，防回潮方向正确
- BATCH-09：清除默认 RELAY_SECRET、HMAC 向量测试
- BATCH-10：LineBuffer / VirtualCodeEngine 设计扎实
- BATCH-21/16：escapeHtml 先行；技能预览去 `dangerouslySetInnerHTML`
- BATCH-23：可执行后缀拦截、路径打开红线
- BATCH-24：Tiptap DOMPurify 粘贴清洗、视觉模型门控 toast
- BATCH-26：预览代理去通配 CORS、context-state 防堆叠

---

## 6. 建议修复顺序

1. **沙箱化 `localFileReader` + 拖放入口**（P0-1）
2. **多模态 prompt / 落盘脱敏**（P0-2）
3. **修复 `listPendingApprovals` Null 契约**（P0-3）
4. 统一拖放消费方（P1-1）与空路径对称校验（P1-2）
5. preview origin 校验、空壳 dispatch 清理、应急草稿恢复

---

## 7. 二次核查交接

请 **code-audit** 按 `secondary-checklist.md` 对上表 P0/P1 做独立抽查（对照源码，标记 `[x]/[~]`/`[!]`），差异写入：

`docs/audit/secondary-verification.md`

完成后在群「Crish 代码审查」同步结论。