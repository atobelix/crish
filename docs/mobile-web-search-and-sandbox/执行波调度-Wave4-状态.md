# Wave 4 执行波调度状态跟踪（UI 表现层全量对齐与跨端加密同步）

> **工作区**：`docs/mobile-web-search-and-sandbox/`  
> **批次编号**：`WAVE-04-UI-ALIGNMENT-AND-ENCRYPTED-SYNC`  
> **调度规则**：单轮派发 5 个子 Agent，文件域严格正交，统一使用 pwsh7，子 Agent 严禁 git commit/reset，必须自测通过后汇报。
> **调度状态**：✅ 全部交付完毕 (5 个子任务 100% 完成，119 项专项测试全绿)

---

## 一、任务分工与文件域矩阵

| 任务 ID | 子 Agent 角色 | 目标文件域 | 核心职责 | 状态 |
| :--- | :--- | :--- | :--- | :--- |
| **W4-1** | Web Source Components Architect | `apps/crish-mobile/src/presentation/components/tools/WebSourceCard.tsx`<br>`apps/crish-mobile/src/presentation/components/tools/WebSourceStrip.tsx`<br>`apps/crish-mobile/src/presentation/components/tools/WebSourceSheet.tsx`<br>`apps/crish-mobile/src/presentation/components/tools/WebSourceComponents.test.tsx` | 横向滑动网页来源微胶囊列表（32px 胶囊）、域名 Favicon/首字母图标、半屏详情抽屉、原站直达与链接复制 | ✅ 交付完毕 (20/20 测试全绿) |
| **W4-2** | Timeline Tool Row & Projection Architect | `apps/crish-mobile/src/presentation/timeline/buildLocalTimeline.ts`<br>`apps/crish-mobile/src/presentation/timeline/buildTimeline.ts`<br>`apps/crish-mobile/src/presentation/timeline/ToolSummaryRow.tsx`<br>配套测试文件 | 清退旧版存量提示；将本地 `message.toolCalls` 与远程 `tool-end` 统一投影为结构化 `ToolBlock`（携带 `webSources`）；实现 24px 极简行高、状态自适应微光点与参数截断 | ✅ 交付完毕 (30/30 专项测试，171/171 回归全绿) |
| **W4-3** | Interactive Citation & Markdown Linkage Architect | `apps/crish-mobile/src/presentation/components/blocks/MarkdownText.tsx`<br>`apps/crish-mobile/src/presentation/components/blocks/CitationPill.tsx`<br>配套测试文件 | 集成 `packages/shared-utils/citation`；将 `[^1]` / `[1]` 解析为交互式上标胶囊；实现轻触触感（Haptics）、高亮联动与摘要悬浮浮层 | ✅ 交付完毕 (21/21 专项测试，98/98 模块回归全绿) |
| **W4-4** | In-App Web Preview Sheet Architect | `apps/crish-mobile/src/presentation/components/webview/WebPreviewSheet.tsx`<br>`apps/crish-mobile/src/presentation/components/webview/WebPreviewStatusCard.tsx`<br>`apps/crish-mobile/src/presentation/components/webview/normalizeDomain.ts`<br>`apps/crish-mobile/src/presentation/components/webview/types.ts`<br>`apps/crish-mobile/src/presentation/components/webview/WebPreviewSheet.test.tsx` | 构建内嵌轻量网页安全预览抽屉；集成 URL SSRF/安全前置校验（11 类高危拦截）、加载进度条、安全域名徽章与外部浏览器直达操作 | ✅ 交付完毕 (25/25 测试全绿) |
| **W4-5** | Cross-Device Encrypted Config Sync Architect | `apps/crish-mobile/src/adapters/sync/pairingConfigSync.ts`<br>`apps/crish-mobile/src/adapters/sync/pairingConfigSync.test.ts`<br>配套适配层 | 配对态下一键安全配置同步；发起 `config.request_secrets_sync`、Nonce 防重放、AES-256-GCM 密文解密验签；硬件安全存储（`secureStore`）写入 | ✅ 交付完毕 (23/23 测试全绿) |

---

## 二、验收门禁要求（DoD）
1. 每个子任务必须产出完整源码与高覆盖率单元测试；
2. 运行单元测试（`npm test`）确保 100% 绿色通过；
3. 遵循反过度设计红线与反退避铁律，杜绝魔术数字与假实现；
4. 运行 `tsc --noEmit` 确保严格零类型错误；
5. 子 Agent 将改动完整保留在工作区，由主 Agent 验证后统一收口提交。
