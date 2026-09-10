# FIX-PROGRESS-§4

> date 2026-09-08 (America/New_York)
> scope SYSTEMATIC-FIX-PLAN §4.1 / §4.2 / §4.3 + QUALITY-GATE
> 前置：§3 有条件通过；顺手消化 R3-1 与 check:no-nonvision-dataurl 挂名复核

## 意图
收敛宿主桥接与预览通道：postMessage origin 白名单 + 明确 targetOrigin；骨架 drag-region 只挂非交互标题带；打开路径可执行后缀前后端 SSOT。禁止双轨/假绿。

## §4.1 Preview postMessage
1. `previewProtocol.ts`：新增 `getPreviewHostOrigin` / `isAllowedPreviewMessageOrigin`（白名单 = `window.location.origin`）。
2. `previewHostBridge.subscribeToInspector`：先校验 `event.origin`，再解析 source/type。
3. `enableInspector`：`postMessage(msg, targetOrigin)`，删除 `'*'`；targetOrigin 优先 iframe `contentWindow.location.origin`，回落宿主 origin。
4. `dev-server/previewBridgeScript.ts`：`TARGET_ORIGIN` + `postToParent`；入站 message 校验 origin；运行时无 `postMessage(..., '*')`。
5. `dev-server/sameOriginRequest.ts`：正式同源策略单轨——有 Origin 则比对 Host；无 Origin 须 `Sec-Fetch-Site∈{same-origin,none}` 或 Referer 同源；**禁止缺 Origin 头即放行**。`vite.config.ts` 改为导入该 SSOT，删除内联旧实现。

## §4.2 Tauri 拖拽区
1. `apps/crish-desktop/index.html`：骨架仅外层 `#skel-app` 保留 `data-tauri-drag-region`；icon-card / SVG / caption 去挂，避免多层吞点击。
2. 既有交互控件（WindowControls / PaneHeader 等）已显式 `data-tauri-drag-region="false"` / `no-drag`，未回潮。

## §4.3 Workbench 打开路径
1. Windows `open_path_with_default_app` 已在 §1 join 成败回传（本轮复核保留）；失败走 `Err`，非恒 `ok:true`。
2. 新增前端 SSOT `api/blockedExecutableExtensions.ts`；`useChatSessionActions` 与 `hostOpenersApi.openPathDefault` 共用（IPC/shell 回落前硬拒绝）。
3. Rust `host_openers/execute.rs` 同名列表 + `is_blocked_executable_path`，在存在性检查前拦截。
4. `scripts/check-blocked-executable-ssot.mjs` 对齐门禁；**已正式挂名** `check:blocked-executable-ssot` 并进入 `check:desktop`（紧接 `check:no-pseudo-dispatch`）；已从 `check-no-pseudo-dispatch` **去掉 §4.3 嵌入双扫**（§4.1/§4.2 嵌入仍随 pseudo-dispatch 跑）。

## 收尾小项
1. **R3-1**：`handleFilesSelected` 遇 `File.path` → `pathBatch` → `await handlePathsSelected`（禁止 continue 静默丢弃）；`handlePathsSelected` 定义顺序提前。
2. **check:no-nonvision-dataurl**：`package.json` 已正式挂名并进入 `check:desktop`（本轮复核 PASS）。
3. `package.json` 追加 `check:blocked-executable-ssot` 具名项：**已完成**；`check:desktop` 已串入；pseudo-dispatch 不再双扫 §4.3。

## 改动文件
- NEW `apps/crish-desktop/src/api/blockedExecutableExtensions.ts` (+test)
- NEW `apps/crish-desktop/dev-server/sameOriginRequest.ts`
- NEW `apps/crish-desktop/src/__tests__/sameOriginRequest.test.ts`
- NEW `apps/crish-desktop/src/components/workspace/previewBridgeScript.contract.test.ts`
- NEW `apps/crish-desktop/src/components/chat-card/useChatAttachments.r31.source.test.ts`
- NEW `scripts/check-blocked-executable-ssot.mjs`
- `apps/crish-desktop/src/components/workspace/previewProtocol.ts`
- `apps/crish-desktop/src/components/workspace/previewHostBridge.ts` (+test)
- `apps/crish-desktop/dev-server/previewBridgeScript.ts`
- `apps/crish-desktop/vite.config.ts`
- `apps/crish-desktop/index.html`
- `apps/crish-desktop/src/components/chat-card/useChatAttachments.ts`
- `apps/crish-desktop/src/components/chat-card/useChatSessionActions.ts`
- `apps/crish-desktop/src/api/hostOpenersApi.ts`
- `apps/agent-workbench/src-tauri/src/host_openers/execute.rs`
- `scripts/check-no-pseudo-dispatch.mjs`（保留 §4.1/§4.2 嵌入；§4.3 双扫已移除）
- `package.json`（`check:blocked-executable-ssot` 具名 + `check:desktop` 挂入）

## 测试结果（本机）
- `node scripts/check-no-pseudo-dispatch.mjs` PASS（含 §4.1/§4.2 嵌入；无 §4.3 双扫）
- `node scripts/check-blocked-executable-ssot.mjs` PASS
- package.json 具名脚本解析执行 PASS；`check:desktop` 已含 `check:blocked-executable-ssot`
- `node scripts/check-no-nonvision-dataurl.mjs` PASS
- vitest 相关 **58 passed**（31 §4 核心 + 27 desktopNativeFeatures）：
  - blockedExecutableExtensions / openPathDefault 硬拒绝
  - previewHostBridge origin 白名单 + 明确 targetOrigin
  - previewBridgeScript TARGET_ORIGIN 契约
  - sameOriginRequest 缺 Origin 不放行
  - R3-1 source 守卫
- `cargo test -p crish-agent-workbench open_path_blocks` / `extension_of_path_strips` PASS
- `tsc --noEmit -p apps/crish-desktop/tsconfig.node.json` PASS

## QUALITY-GATE 自检
1. 意图可陈述 — §4.1–4.3 + R3-1
2. 无新旁路 — 无 `postMessage('*')`；无缺 Origin 即放行；可执行拦截在 shell 回落前
3. 对称失败 — origin 非法静默丢弃；可执行前后端均硬失败；打开路径失败不恒 ok
4. 测试非假绿 — 覆盖非法 origin、缺 Origin、TARGET_ORIGIN、可执行拦截、R3-1 源码断言
5. 门禁可执行 — 独立脚本 + package.json 具名 `check:blocked-executable-ssot` 已挂入 `check:desktop` `[x]`；pseudo-dispatch 仅保留 §4.1/§4.2
6. 二次核查 — 待 code-audit

## 未完成 / 交接
1. ~~package.json 正式增加 `check:blocked-executable-ssot` 并挂入 `check:desktop`~~ **已完成**（2026-09-08 ~02:18 ET）；并从 `check-no-pseudo-dispatch` 去掉 §4.3 嵌入双扫。
2. code-audit 出具 `FIX-§4-verification.md`。
3. **不开 §5**（本轮明确范围止于 §4 挂名收尾）。

## 非假装修完
未保留 `'*'` 投递轨；同源策略单轨；骨架多层 drag-region 已清；可执行后缀前后端同表；R3-1 不再静默丢 File.path。
