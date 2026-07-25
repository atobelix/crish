# Agent Core Directives & Guidelines

## 0. Anti-Overengineering Red Lines (反过度设计硬性红线)
* **Strictly Enforce Guardrails**: All agents MUST strictly obey the Anti-Overengineering Red Line Rules defined in [ANTI_OVERENGINEERING_GUARDRAILS.md](file:///c:/Software/conex/ANTI_OVERENGINEERING_GUARDRAILS.md).
* **Forbidden Over-Engineering**: Never re-introduce kernel-level sandboxes (macOS Seatbelt/Linux Seccomp), SharedArrayBuffer ring buffers (`sab_ring_buffer`), automatic background model-switching (`DynamicModelRouter`), pre-request DNS A/AAAA resolvers, sliding-window `CircuitBreaker`, 6-stage tool middleware pipelines, `IpcRouter` nested serialization, 95% `React.memo` CI scripts. (Note: Web Workers & WorkerPool themselves are **strongly encouraged** for multi-window text parsing offloading).

## 1. CI Governance & Decoupling Rules (CI 治理与解耦断言 6 条规则)
1. **按类型分级行数门禁**：UI 组件限 500 行、业务逻辑限 400 行、类型契约放宽至 800 行，避免一刀切。
2. **注释与空行免惩罚**：仅计算有效代码行，过滤空行与文档注释，鼓励开发者写完善的文档。
3. **渐进预警与分级阻断**：接近上限时产生 CI 警告提醒重构，只有严重超标（如 >650 行）才硬性阻断 PR。
4. **状态爆炸识别单一职责**：限制单文件多组件 (`no-multi-comp`) 与单组件 `useState` 数量（>12个），自动拦截“包罗万象”的上帝组件。
5. **分层硬性解耦与禁逆向依赖**：底层工具包绝不能反向引入上层业务包，前端禁止深路径直接调用 Daemon 内部私有模块。
6. **零循环依赖与极速 CI 扫描**：全局硬阻断循环依赖 (`no-circular`)，排除 `dist/` 和 `node_modules`，将扫描耗时控制在 2 秒以内。

## 2. Tooltips / Hover Tips
* **Use Custom Tooltips**: Always use the custom `<Tooltip>` component (imported from `@/components/settings/SettingsUI` or similar relative path) instead of native HTML `title` attributes for hover hints.
* **Avoid Browser Defaults**: Native browser `title` tooltips look inconsistent and outdated. Wrapping interactive elements in `<Tooltip content={...}>` ensures tooltips have a premium, rounded pill design with soft shadows and correct color themes.

## 3. Input Boxes & Focus States
* **No Heavy Box Shadows**: Do not add box shadows (`box-shadow`) to input fields, search boxes, or composers by default, especially on flat layouts. Keep the design clean, flat, and light.
* **Subtle Active Borders**: When inputs or buttons (such as `.shortcut-key-btn.recording` or `.input-container`) are in an active, focused, or recording state, **never** apply thick, dark, or solid black borders (e.g., using `var(--text-primary)` or `0 0 0 1px` ring styles).
* **Controlled Contrast**: Border lines should only be slightly darker/grayer than the component's background, just enough to outline the active area (e.g., using a 60/40 mix of `var(--border-color)` and `var(--text-primary)`). Always prioritize restraint and visual softness to protect user eye strain.
* **Double Check Contrast**: The active/focused state border change should be clearly visible and distinguishable to the naked eye (so it doesn't look like nothing happened), but must remain soft and light-gray (e.g. a 75/25 mix of `var(--border-color)` and `var(--text-primary)`), never reaching dark or black.
  * **Exception – Flat Landing Layouts**: For full-page empty state composers or similarly prominent landing-style inputs (e.g. `data-empty-kind="session-empty"`), the focus state border should use a very subtle mix of the **exact same** `var(--border-color)` with at most 5% of `var(--text-primary)` — **virtually no darkening at all**. The visual context (cursor position, placeholder fading) is sufficient to signal focus. Do not add any border-color transition.
* **Maximum 10% Focus Contrast Limit**: Under no circumstances should focus or active states apply hard solid lines. The focused border's grayness/darkening must never exceed **10% of the baseline background's text contrast mix** (e.g., maximum `color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%)`). Standard elements should preferentially use a soft **3% to 6% mix** to maintain visual softness.

## 4. Hover Effects
* **No Hover Jumping (translateY)**: When cards, chips, or prompt pills (such as `.quick-prompt-card`) are hovered, it is strictly forbidden to use vertical movement/jumping (such as `transform: translateY(-1px)`). Hover effects must be limited to soft background, border, and text color transitions.


