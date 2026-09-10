# §1 修复进度 · FIX-PROGRESS-§1

> 日期：2026-09-07（America/New_York）  
> 分支：refactor/architecture  
> 范围：仅 SYSTEMATIC-FIX-PLAN §1（含跑通 §1 必需的最小调用方接线）

## 完成项

### §1.1 路径沙箱
- workspaceFsApi.ts 新增 ResolvedPath、assertWorkspacePath、isInsideWorkspace。
- readTextFile / writeTextFile / toAssetUrl 统一经 assertWorkspacePath；write 与 toAssetUrl 对称拒绝空路径。
- useFileNavigation.revealPath 删除冒号与双点启发式，改为 assertWorkspacePath；越界不再加载外部父目录。

### §1.2 localFileReader
- 重写 localFileReader.ts：删除 shell 拼路径读盘产品路径。
- 只走 assertWorkspacePath + convertFileSrc + fetch；失败抛错。
- usePlainCodeLoader 去掉越界旁路，只走 readTextFile。
- useChatAttachments 已有 try/catch，越界读失败降级为仅元数据附件。

### §1.3 IPC
- ws.rs listPendingApprovals：Null 改为合法空对象后再反序列化。
- host_openers/execute.rs Windows open_path：取消 fire-and-forget 恒 ok；join 线程按成败回传。

### §1.4 Token / 门禁
- 删除 tokens.css 中 --md-heading-h1..h6-size 双轨（light/dark 共 12 行）。
- ChatMessageRow 与 typography 单测改消费 --md-h1..h6-size。
- markdown 样式合规脚本本地已通过；package.json 挂入 check:desktop 因 Auto-review 拦截未能写入（见未完成）。

## 改动文件
- apps/crish-desktop/src/api/workspaceFsApi.ts
- apps/crish-desktop/src/api/workspaceFsApi.test.ts
- apps/crish-desktop/src/api/localFileReader.ts
- apps/crish-desktop/src/api/localFileReader.test.ts
- apps/crish-desktop/src/components/files/hooks/useFileNavigation.ts
- apps/crish-desktop/src/components/files/hooks/usePlainCodeLoader.ts
- apps/agent-workbench/src-tauri/src/server/ws.rs
- apps/agent-workbench/src-tauri/src/host_openers/execute.rs
- apps/crish-desktop/src/styles/tokens.css
- apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css
- apps/crish-desktop/src/components/chat-message-row/__tests__/typography-token.test.ts

## 测试结果
- localFileReader.test.ts：通过
- workspaceFsApi.test.ts：通过（含 assert / 空路径）
- typography-token.test.ts：通过
- useFileNavigation.test.tsx：通过（8）
- markdown 样式合规脚本：通过
- 相关 vitest 合计：47 + 8 通过
- Rust workbench 编译/契约单测：未跑

## 未完成 / 剩余风险
1. package.json 未挂入 check:markdown-style（写入被拦）。需人工：新增 check:markdown-style 脚本项，并在 check:desktop 中置于 check:input-guard 之后。
2. 拖放多入口统一（§3.1）未做；附件仍可能入队工作区外路径元数据（读内容已硬失败）。
3. 非视觉 multimodal 脱敏（§3.3）不在本任务范围。
4. listPendingApprovals 契约自动化单测未补。
5. Windows open_path join 可能略增 IPC 延迟（正确性优先）。
