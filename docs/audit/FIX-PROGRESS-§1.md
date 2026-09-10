# §1 修复进度（F1-F4 回炉）

> 日期：2026-09-08（America/New_York）
> 对照：FIX-§1-verification.md

## F1 已关闭
- workspaceFsApi：无 root 相对路径 resolve 返回空串；assert 硬失败
- 删除「相对路径原样返回」假绿测；补 assert 无根相对 toThrow
- falsify：REPRO_F1_threw（不再 PASS_AS_BUG）
- vitest workspaceFsApi.test.ts：27 passed

## F2 已关闭
- useChatAttachments：assertWorkspacePath 后才入队；失败 continue，无 trimmed 旁路
- ChatUserMessageRow：resolveUserImageSrc 先 assert 再 convertFileSrc，失败空串占位

## F3 已关闭
- ws.rs normalize_list_pending_approvals_params + 契约单测
- cargo test list_pending_approvals_null_and_empty_object_contract：ok

## F4 已关闭
- package.json：新增 check:markdown-style、check:no-pseudo-dispatch；已挂入 check:desktop（紧接 check:input-guard 之后）
- 删除 check-input-guardrails.mjs 内 SEC14_SEC2_EMBEDDED_GATES / runEmbeddedDesktopGates 嵌入段及仅为其引入的 spawnSync
- 验证：两门禁脚本 node 直接跑均 exit 0；embed 标记已不存在

## 改动文件
- apps/crish-desktop/src/api/workspaceFsApi.ts
- apps/crish-desktop/src/api/workspaceFsApi.test.ts
- apps/crish-desktop/src/components/chat-card/useChatAttachments.ts
- apps/crish-desktop/src/components/chat-message-row/ChatUserMessageRow.tsx
- apps/agent-workbench/src-tauri/src/server/ws.rs
- docs/audit/_falsify-assert.mjs
- scripts/check-input-guardrails.mjs（嵌入已删）

未开始 §3。
