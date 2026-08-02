# Agent Core Directives & Guidelines

## 0. Anti-Overengineering Red Lines (反过度设计硬性红线)

- **Strictly Enforce Guardrails**: All agents MUST strictly obey the Anti-Overengineering Red Line Rules defined in [ANTI_OVERENGINEERING_GUARDRAILS.md](file:///c:/Software/conex/ANTI_OVERENGINEERING_GUARDRAILS.md).
- **Forbidden Over-Engineering**: Never re-introduce kernel-level sandboxes (macOS Seatbelt/Linux Seccomp), SharedArrayBuffer ring buffers (`sab_ring_buffer`), automatic background model-switching (`DynamicModelRouter`), pre-request DNS A/AAAA resolvers, sliding-window `CircuitBreaker`, 6-stage tool middleware pipelines, `IpcRouter` nested serialization, 95% `React.memo` CI scripts. (Note: Web Workers & WorkerPool themselves are **strongly encouraged** for multi-window text parsing offloading).

## 1. CI Governance & Decoupling Rules (CI 治理与解耦断言 6 条规则)

1. **按类型分级行数门禁**：UI 组件限 500 行、业务逻辑限 400 行、类型契约放宽至 800 行，避免一刀切。
2. **注释与空行免惩罚**：仅计算有效代码行，过滤空行与文档注释，鼓励开发者写完善的文档。
3. **渐进预警与分级阻断**：接近上限时产生 CI 警告提醒重构，只有严重超标（如 >650 行）才硬性阻断 PR。
4. **状态爆炸识别单一职责**：限制单文件多组件 (`no-multi-comp`) 与单组件 `useState` 数量（>12个），自动拦截“包罗万象”的上帝组件。
5. **分层硬性解耦与禁逆向依赖**：底层工具包绝不能反向引入上层业务包，前端禁止深路径直接调用引擎内部私有模块（一律经 IPC transport / commandMap / storeAccess 分层）。
6. **零循环依赖与极速 CI 扫描**：全局硬阻断循环依赖 (`no-circular`)，排除 `dist/` 和 `node_modules`，将扫描耗时控制在 2 秒以内。

## 2. Tooltips / Hover Tips

- **Use Custom Tooltips**: Always use the custom `<Tooltip>` component (imported from `@/components/settings/SettingsUI` or similar relative path) instead of native HTML `title` attributes for hover hints.
- **Avoid Browser Defaults**: Native browser `title` tooltips look inconsistent and outdated. Wrapping interactive elements in `<Tooltip content={...}>` ensures tooltips have a premium, rounded pill design with soft shadows and correct color themes.

## 3. Input Boxes & Focus States

- **No Heavy Box Shadows**: Do not add box shadows (`box-shadow`) to input fields, search boxes, or composers by default, especially on flat layouts. Keep the design clean, flat, and light.
- **Subtle Active Borders**: When inputs or buttons (such as `.shortcut-key-btn.recording` or `.input-container`) are in an active, focused, or recording state, **never** apply thick, dark, or solid black borders (e.g., using `var(--text-primary)` or `0 0 0 1px` ring styles).
- **Controlled Contrast**: Border lines should only be slightly darker/grayer than the component's background, just enough to outline the active area (e.g., using a 60/40 mix of `var(--border-color)` and `var(--text-primary)`). Always prioritize restraint and visual softness to protect user eye strain.
- **Double Check Contrast**: The active/focused state border change should be clearly visible and distinguishable to the naked eye (so it doesn't look like nothing happened), but must remain soft and light-gray (e.g. a 75/25 mix of `var(--border-color)` and `var(--text-primary)`), never reaching dark or black.
  - **Exception – Flat Landing Layouts**: For full-page empty state composers or similarly prominent landing-style inputs (e.g. `data-empty-kind="session-empty"`), the focus state border should use a very subtle mix of the **exact same** `var(--border-color)` with at most 5% of `var(--text-primary)` — **virtually no darkening at all**. The visual context (cursor position, placeholder fading) is sufficient to signal focus. Do not add any border-color transition.
- **Maximum 10% Focus Contrast Limit**: Under no circumstances should focus or active states apply hard solid lines. The focused border's grayness/darkening must never exceed **10% of the baseline background's text contrast mix** (e.g., maximum `color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%)`). Standard elements should preferentially use a soft **3% to 6% mix** to maintain visual softness.

## 4. Debugging via Chrome DevTools Protocol (CDP)

### Startup

Run `npm run dev:workbench` from root. This launches the full Tauri desktop app including:

- Rust engine (crates/*, in-process with the Tauri shell)
- React frontend in WebView2 (Vite HMR enabled)

### CDP Debug Port

The WebView2 process (`msedgewebview2.exe`) is automatically started with `--remote-debugging-port=9222`.

**Connect to CDP at:**

```
http://127.0.0.1:9222/json/list       → list available targets
ws://127.0.0.1:9222/devtools/page/... → full CDP session
```

**Available via CDP:**

- Inspect DOM, read console logs, execute JS
- Take screenshots of the app window
- Monitor network requests (Tauri IPC / engine event traffic)
- Read app state (React stores, Zustand state)

### ⚠️ CRITICAL: Disable Browser-Side DevTools Inspection (禁用 DevTools 浏览器端检查)

- **Disable Browser-Side Inspection**: Strictly forbid using browser-side DevTools plugins, standalone Chrome instances, or browser-side inspection tools for UI testing.
- **Direct CDP 9222 Only**: All UI debugging, state inspection, DOM checks, and screenshots MUST be performed directly against the Tauri WebView2 process via port 9222 (`http://127.0.0.1:9222`).
- **Do NOT** open `http://localhost:5174` in a standalone browser to debug.
- Browser mode has no Tauri host capabilities (no file dialogs, no shell, no engine IPC).
- Browser mode cannot reach the engine — IPC calls will fail silently.
- Browser mode gives false negatives: UI renders but features don't work, leading to wasted debugging.
- **Only use CDP** via the `ws://127.0.0.1:9222` endpoint for accurate debugging and screenshots.

### ⚠️ CRITICAL: Avoid Sandbox / Mock Seeding Environment in UI Testing (严禁在虚假/Mock 测试环境中测试)

- **Bypass Mock Seeding**: By default, initial load or opening new windows in `npm run dev:workbench` may inject in-memory mock sandbox sessions (e.g. `测试会话 A/B/C`).
- **Forbidden Mock Environment Testing**: All agents (including subagents and newly launched window instances) MUST NEVER test, inspect, screenshot, or evaluate features against isolated mock sandbox states or temporary seed data.
- **Load Live User Data & Stores**: For accurate visual inspection and UI diagnostics, agents MUST evaluate or hydrate state from real window store facades (`window.__CRISH_SESSION_STORE__`, `window.__CRISH_LAYOUT_STORE__`, `window.__CRISH_TREE_STORE__`) or actual LocalStorage keys (`crish_session_index_v1`, `crish-layout-tree-v1`) to reflect actual user UI layouts and session history.
- **New Window Mandatory Check**: Before taking screenshots or declaring verification pass in a newly opened window or subagent, agents MUST explicitly confirm that the workspace/session state is hydrated with real user data, NOT fallback mock sandbox sessions.

### Other Running Services

| Service          | Port | Type                                                  |
| ---------------- | ---- | ----------------------------------------------------- |
| Vite dev server  | 5174 | HTTP (frontend source)                                |
| CDP (WebView2)   | 9222 | CDP (debugging)                                       |
| Tauri MCP Socket | 4000 | TCP (opt-in: `CRISH_MCP_SOCKET=1` + token, see below) |

### Debugging via Model Context Protocol (MCP)

The Tauri app can start a socket server for MCP debugging (via `tauri-plugin-mcp`) at `127.0.0.1:4000`.
**Disabled by default** (security hardening PE-07 T07.5 / I-01): the socket starts **only** when the app is launched with `CRISH_MCP_SOCKET=1`; release builds never start it.

```powershell
$env:CRISH_MCP_SOCKET = "1"   # 显式开启（仅精确值 "1" 生效；其余取值一律关闭）
npm run dev:workbench
```

- **Auth token (mandatory)**: the plugin generates a random token at startup and writes it to `%TEMP%\tauri-mcp-4000.token`; every request must carry it (`authToken`), otherwise the connection is rejected (constant-time comparison). To pin a fixed token, set `TAURI_MCP_AUTH_TOKEN` before launch.
- The socket binds **loopback only** (`127.0.0.1`).

**Connect to MCP at:**
To allow AI assistants (like Cursor, Grok, or Antigravity) to connect via the `tauri-plugin-mcp-server` bridge:

- Configure the MCP server with the following environment variables:
  ```json
  "tauri-mcp": {
    "command": "npx",
    "args": ["-y", "tauri-plugin-mcp-server"],
    "env": {
      "TAURI_MCP_CONNECTION_TYPE": "tcp",
      "TAURI_MCP_TCP_PORT": "4000"
    }
  }
  ```
- This ensures the bridge connects via TCP to port `4000` instead of defaulting to Named Pipes (`\\.\pipe\tmp\tauri-mcp.sock`) on Windows. The bridge auto-loads the token from `%TEMP%\tauri-mcp-4000.token` on every connect — no extra config needed.
- **Prerequisite**: the app must be running with `CRISH_MCP_SOCKET=1` (see above); otherwise port 4000 is not listening.

## 5. Mandatory Verification Command Suite Execution

- **Full Verification After Major Changes**: All agents MUST strictly execute and pass the complete command verification suite defined in [FULL_CHECK_COMMANDS.md](file:///c:/Software/conex/FULL_CHECK_COMMANDS.md) after completing any major refactor, modification, or iteration round. Continuously append all required check commands to [FULL_CHECK_COMMANDS.md](file:///c:/Software/conex/FULL_CHECK_COMMANDS.md) and reference it across all agent directives.
