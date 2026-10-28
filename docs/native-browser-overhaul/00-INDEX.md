# 原生浏览器彻底改造战役索引与导航锚点 (00-INDEX)

> **战役代号**：`native-browser-overhaul`  
> **战役工作区**：`docs/native-browser-overhaul/`  
> **当前状态**：Wave 1 ~ Wave 5 主体已落地；2026-10-27 收口复核后仍有遗留项（见 §四 与《[续航锚点-20261027-收口审查接续](./续航锚点-20261027-收口审查接续.md)》）  
> **指导思想**：**“非必要不兼容。不允许打补丁，不允许硬编码，有合理的抽象，适合未来的功能需求，代码尽量简洁，具有优秀的可维护性。需要删除的代码就删除，需要系统性的重构。”**

---

## 一、战役文档体系清单（符合一级子目录规范）

### 1.1 根目录白名单文档（总纲与分维详案）
| 序号 | 文档名称 | 责任 Agent | 状态 | 核心成果 |
| :---: | :--- | :--- | :---: | :--- |
| **00** | [00-总方案-原生浏览器彻底改造与子Webview架构方案.md](./00-总方案-原生浏览器彻底改造与子Webview架构方案.md) | 主控 Agent | **已审定** | 战役总纲、全链路架构拓扑、交互时序、死代码删除清单 |
| **01** | [01-分维-Tauri2原生子Webview管理器与Rust内核实现.md](./01-分维-Tauri2原生子Webview管理器与Rust内核实现.md) | 子 Agent 1 & 5 | **已交付** | `NativeWebviewManager` 单例、COM Token 注册表（`EventTokenRegistry`）、9 条 IPC 命令 |
| **02** | [02-分维-前端占位挖洞与几何同步引擎实现.md](./02-分维-前端占位挖洞与几何同步引擎实现.md) | 子 Agent 3 | **已交付** | `NativeBrowserSurface` 占位、四边界外对齐取整、Hit-Test 穿透看门狗 |
| **03** | [03-分维-安全分区权限门控与旧代理清退方案.md](./03-分维-安全分区权限门控与旧代理清退方案.md) | 子 Agent 4 | **已交付** | 物理级 UDF（`browser-storage/`）、零特权暴露、2,000+ 行死代码物理清除 |
| **04** | [04-分维-DOM原生拾取与AI协同能力演进.md](./04-分维-DOM原生拾取与AI协同能力演进.md) | 子 Agent 6 | **已交付** | 免代理 `<4KB` DOM 探针、原生 CDP、"Send to AI" 结构化芯片直通 |

---

### 1.2 子文件夹一级结构
#### 📁 `audits/` —— 6 大独立挑刺与整改审计报告
- 📄 [01-architecture-elegance-and-anti-patching-audit.md](./audits/01-architecture-elegance-and-anti-patching-audit.md)（架构优雅度、反补丁、后端 Axum 代理死代码清理审计）
- 📄 [02-concurrency-and-win32-runtime-audit.md](./audits/02-concurrency-and-win32-runtime-audit.md)（COM STA 线程模型、Tokio 并发死锁、EventRegistrationToken 句柄泄漏审计）
- 📄 [03-frontend-geometry-and-airspace-audit.md](./audits/03-frontend-geometry-and-airspace-audit.md)（非模态局部浮层 Airspace 穿透漏洞、内联弹性抽屉重构、125% DPI 亚像素缝隙审计）
- 📄 [04-real-world-web-robustness-audit.md](./audits/04-real-world-web-robustness-audit.md)（第三方 OAuth 联合登录 `window.opener` 死锁、大文件下载与 Blob 导出、本地自签名免配放行审计）
- 📄 [05-systemic-refactoring-and-anti-slacking-audit.md](./audits/05-systemic-refactoring-and-anti-slacking-audit.md)（DEF-05-01 ~ DEF-05-12 系统性缺陷清单与防偷懒审查）
- 📄 [06-final-verification-and-anti-slacking-audit.md](./audits/06-final-verification-and-anti-slacking-audit.md)（最终验收审计；总裁决段已按 2026-10-27 代码现状勘误，以缺陷矩阵为准）

#### 📁 `analysis/` —— 6 大基础架构调研分析
- 📄 [01-tauri-child-webview-architecture.md](./analysis/01-tauri-child-webview-architecture.md)（Tauri 2 Multi-Webview 与 WRY 底层机制）
- 📄 [02-pi-desktop-reference-analysis.md](./analysis/02-pi-desktop-reference-analysis.md)（标杆仓库 `pi-desktop` WebContentsView 架构精粹）
- 📄 [03-frontend-layout-and-geometry-sync.md](./analysis/03-frontend-layout-and-geometry-sync.md)（前端几何测量与双相同步引擎）
- 📄 [04-security-partition-and-permissions.md](./analysis/04-security-partition-and-permissions.md)（安全边界与权限模型设计）
- 📄 [05-ipc-and-event-streaming-contract.md](./analysis/05-ipc-and-event-streaming-contract.md)（Rust ↔ TS 全双工 IPC 通信契约）
- 📄 [06-ai-interop-and-cdp-capabilities.md](./analysis/06-ai-interop-and-cdp-capabilities.md)（AI Agent 与原生 Webview 协同路径）

---

## 二、实施波次完成状态（Wave Execution Summary）

| 波次 | 阶段目标 | 覆盖文件域 | 实施状态 | 验收结果 |
| :---: | :--- | :--- | :---: | :--- |
| **Wave 1** | **Rust 内核基建**：Tauri unstable 特性开启、`NativeWebviewManager` 单例与 COM Token 注册表（原 `StaDispatcher` 后经 2026-10-27 审查判定为零使用死代码并物理删除——COM 注销改用 STA 主线程显式触发） | `apps/agent-workbench/src-tauri/` | ✅ **已完成** | `cargo check` 0 error，单测全绿 |
| **Wave 2** | **安全存储与协议**：独立 UDF 目录挂载、下载事件管道（`add_DownloadStarting` → `browser://download-progress`）、9 条 IPC 命令；OAuth 新窗口受控分流**未实施**（见 §四） | `src-tauri/src/browser/` | ✅ **已完成（除 OAuth 分流）** | 9 条命令与命令清单对齐 |
| **Wave 3** | **前端 Surface 重构**：`NativeBrowserSurface` 占位、四边界规整、内联抽屉、Hit-Test 看门狗 | `apps/crish-desktop/` | ✅ **已完成** | 剔除 iframe，`PreviewCard` 成功对接入原生视口 |
| **Wave 4** | **全面物理清退与探针**：删除 2,000+ 行历史代理与伪装代码、接入 `<4KB` 免代理 DOM 探针 | 全仓库（前端 Vite + 后端 Axum 代理） | ✅ **已完成** | 物理删除 9 个文件，`npm run typecheck` 0 error |
| **Wave 5** | **立体化集成验收**：Google 搜索无阻断、分屏拖拽零卡顿、断言校验（OAuth 分流未闭环，见 §四） | 全仓库测试与真实桌面端验收 | ◐ **部分完成** | 2026-10-27 复核：`browser::` 85/85、`command_manifest` 14/14、`npm run typecheck` 0 error |

---

## 三、反退避 6 大刚性验收断言跟踪结果

- [x] **A1 · 任意公网网页自由浏览**：Google 搜索回车即刻呈现结果，零“已阻止此内容”红白拦截（原生 Webview 顶层视口放行）。
- [x] **A2 · 登录态跨重启持久化**：独立的 `browser-storage/` 存储分区支持真实 Cookie 长期保存。
- [ ] **A3 · OAuth 联合登录时序闭环**：**未实施**。当前无 `add_NewWindowRequested` / `put_NewWindow` 分流，依赖 WebView2 默认弹窗行为；「受控模态 Webview 挂载」登记为后续分维任务（§四）。
- [x] **A4 · 大文件下载与 Blob 导出**：事件管道已接线（`add_DownloadStarting` + 逐操作 `BytesReceivedChanged` / `StateChanged` → `browser://download-progress`，state: `progress`/`completed`/`interrupted`；前端 `useNativeBrowserInstance` 已消费）。落盘沿用 WebView2 默认下载目录；**真实宿主下载触发验收待补**。
- [x] **A5 · 分栏拖拽与 Airspace 零撕裂**：四边界独立四舍五入杜绝 1px 白边，Hit-Test 穿透门闩杜绝粘手（后端如实返回 `unsupported`，不再伪装成功）。
- [x] **A6 · 架构净收敛（持续）**：物理删除超 2,000 行历史旧代理死代码；2026-10-27 又删除 `sta_dispatcher.rs` 与 `NativeTokenGuard`。当前仍有少量增量死代码警告（`inspector_bridge.rs` 两个未使用函数、`workspace.rs` 未读字段），未达「零死代码」。全工程编译与门禁通过。

---

## 四、2026-10-27 收口复核遗留项

| 项 | 状态 | 说明 |
| :--- | :---: | :--- |
| OAuth 新窗口受控分流 | **未实施** | 需 `add_NewWindowRequested` + `put_NewWindow` + 前端受控模态 Webview 挂载，横跨 Rust / 前端 / 真机验收，待独立任务书 |
| 本地文件预览 UI | **机制就绪，UI 未接** | 后端 `workspaceRoot` → `file:` 门禁已贯通；`NativeBrowserSurface` 尚未传入工作区根（当前传 None = `file:` 全禁，安全缺省） |
| `browser_storage_get_usage` | **未实现** | 03-分维 §3.4 的 2GB 阈值统计命令 + 设置页提示 |
| 下载管道真机验收 | **待补** | 单测覆盖状态映射与 wire 契约；需在真实宿主触发一次下载确认事件流与 token 注销 |
| 增量死代码 | **待清理** | `inspector_bridge.rs:34,38` 两个未使用函数；`workspace.rs:85` 未读字段 |
