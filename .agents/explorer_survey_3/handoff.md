# Explorer 3 Handoff Report: System Architecture & Red Line Constraints Survey

## 1. Observation

Direct observations from the project codebase and system governance documentation:

1. **System Governance & Red Line Directives**:
   - `C:\Software\conex\.agents\AGENTS.md`:
     - Line 10: "UI 组件限 500 行、业务逻辑限 400 行、类型契约放宽至 800 行"
     - Line 13: "限制单文件多组件 (`no-multi-comp`) 与单组件 `useState` 数量（>12个）"
     - Line 19: "Always use the custom `<Tooltip>` component ... instead of native HTML `title` attributes"
     - Line 24: "Do not add box shadows (`box-shadow`) to input fields, search boxes, or composers by default"
     - Line 28: "Exception – Flat Landing Layouts: ... focus state border should use a very subtle mix ... with at most 5% of `var(--text-primary)` — virtually no darkening at all"
     - Line 29: "Maximum 10% Focus Contrast Limit: ... focused border's grayness/darkening must never exceed 10% of the baseline background's text contrast mix ... Standard elements should preferentially use a soft 3% to 6% mix"
   - `C:\Software\conex\docs\archive\legacy\ANTI_OVERENGINEERING_GUARDRAILS.md`:
     - Lines 10-15: Forbidden OS kernel sandboxes (macOS Seatbelt / Linux Seccomp)
     - Lines 17-20: Forbidden SharedArrayBuffer ring buffers (`sab_ring_buffer`)
     - Lines 25-30: Forbidden automatic background model-switching (`DynamicModelRouter` / `FallbackChain`)
     - Lines 32-35: Forbidden pre-request DNS A/AAAA resolvers
     - Lines 42-46: Forbidden microservice sliding-window `CircuitBreaker`
     - Lines 48-52: Forbidden 6-stage tool middleware pipeline
     - Lines 53-56: Forbidden nested `IpcRouter` in Tauri commands
     - Lines 60-65: Forbidden blind 95% `React.memo` CI assertions

2. **Existing Composer & Visual Styling Baseline**:
   - `apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css`:
     - Lines 22, 31: `box-shadow: none !important;`
     - Lines 30, 48: `border-color: color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%) !important;`
   - `apps/crish-desktop/src/components/chat-composer/ChatComposer.tsx`:
     - Line 13: `import { Tooltip } from '../Tooltip';`

3. **CI Check Enforcement Suite**:
   - `package.json`:
     - Line 44: `"check:desktop": "npm --workspace @crish/crish-desktop run typecheck && npm run check:ui-layer"`
     - Line 45: `"check:ui-layer": "node scripts/check-ui-layer.mjs"`
     - Line 58: `"lint:depcruise": "depcruise --config .dependency-cruiser.cjs packages apps"`
   - `.dependency-cruiser.cjs`:
     - Lines 69-78: `no-circular` error rule for circular dependency blocking across monorepo.
     - Lines 95-120: Layer 0..3 reverse dependency blocking.
     - Lines 22-38: Store / API / Component micro-decoupling rules (`store` does not import `components`, `components` read `store` only via `storeAccess`).
   - `scripts/check-ui-layer.mjs`:
     - Lines 72-85: `components/ui/` atomic elements forbidden from importing business components (`components/*`), `store/`, `hooks/`, `api/`, or `services/`.

4. **Tauri IPC & Rust Kernel Architecture**:
   - `apps/agent-workbench/src-tauri/src/core_run_commands.rs`:
     - Lines 80-99: Native `#[tauri::command]` handlers (`core_run_task`, `core_cancel_run`, `core_approve_tool`, `core_deny_tool`) invoking orchestrator and session loop directly.
   - `apps/agent-workbench/src-tauri/src/core_error.rs`:
     - Unified IPC error model `CoreError { kind, detail }`.
   - `crates/conex-types/src/`:
     - Standard `AgentMessage`, `AgentEvent`, `CrishError` domain types.

5. **Prototype Tiptap Source**:
   - `C:\Software\conex\reference\chat-composer-tiptap\src\components\Editor.tsx`:
     - Monolithic component containing Tiptap `useEditor`, `StarterKit`, `Placeholder`, `TaskList`, `TaskItem`, `GlobalDragHandle`, and `SlashCommands` extension.

---

## 2. Logic Chain

1. **Premise**: Migrating the monolithic Tiptap prototype directly into `apps/crish-desktop/src/components/chat-composer/` without refactoring would violate line count limits (UI component > 500 lines if extended with attachments/queues), cause component state explosion (> 12 `useState`), and risk breaking CI decoupling rules (`check:ui-layer`, `lint:depcruise`).
2. **Step 1 (Frontend Decomposition)**: To satisfy the line-count guardrails (UI ≤ 500 lines, logic ≤ 400 lines, type contracts ≤ 800 lines) and `no-multi-comp` rules, the migration MUST decompose the editor into modular components:
   - Shell: `TiptapComposerContainer.tsx` (UI shell ≤ 250 lines)
   - Field: `TiptapEditorField.tsx` (ProseMirror core ≤ 350 lines)
   - Slash menu: `TiptapSlashMenu.tsx` & `TiptapSlashExtension.ts` (menu & extension ≤ 220 lines)
   - State hook: `useTiptapComposerState.ts` (custom hook ≤ 300 lines)
   - Types: `composerTypes.ts` (contract ≤ 150 lines)
3. **Step 2 (Styling & Tooltip Enforcement)**:
   - CSS in `ChatComposer.module.css` must adhere to visual softness: focus border MUST use `color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%)` (3%-10% mix limit) and zero darkening (max 5% mix) on flat landing pages (`data-empty-kind="session-empty"`). Heavy box shadows are strictly forbidden (`box-shadow: none !important`).
   - Native HTML `title` attributes are replaced by custom `<Tooltip content={...}>`.
4. **Step 3 (IPC Bridge Compliance)**:
   - Submission of Markdown content from Tiptap ProseMirror state invokes `core_run_task` via `daemonClient.ts` directly.
   - Avoid creating custom HashMap IPC routing wrappers inside Tauri commands (Rule 8 compliance).
5. **Step 4 (Data Model Serialization)**:
   - Rich text from Tiptap is serialized into standard Markdown text strings before passing across IPC to Rust kernel (`AgentMessageRole::User`), keeping Rust `conex-types` data structures clean and unburdened by frontend-specific ASTs.

---

## 3. Caveats

1. **ProseMirror AST to Markdown Losslessness**: Complex inline nodes or custom block extensions added in future iterations must ensure high-fidelity serialization to Markdown so that Rust prompt builders (`agent-provider`) receive valid text.
2. **Third-Party Tiptap CSS Isolation**: Tailwind/Prose Mirror default styles from `chat-composer-tiptap` must be converted to CSS Modules (`ChatComposer.module.css`) to avoid global CSS namespace pollution in `crish-desktop`.

---

## 4. Conclusion

The system architecture and governance Red Line rules strictly define the design parameters for the Tiptap composer migration:
1. **Frontend Architecture**: Decomposed into 5 modular files (< 500 lines for UI, < 400 lines for hooks, < 800 lines for types) with state isolated in `useTiptapComposerState.ts`.
2. **UI & Styling**: Styled with CSS `color-mix()` (3%–10% focus mix limit, max 5% mix on landing state), `box-shadow: none !important`, and wrapped in custom `<Tooltip>`.
3. **IPC & Kernel**: Markdown serialization across direct `core_run_task` Tauri commands to `conex-types` and `orchestrator` without nested IPC routers, ring buffers, or kernel sandboxes.

---

## 5. Verification Method

Independent verification of compliance can be performed using the official check commands:

1. **UI Layer & Atomic Dependency Verification**:
   ```powershell
   npm run check:ui-layer
   ```
   *Expected outcome*: Exit code 0, verifying no inverse business dependencies from atomic UI components.

2. **Monorepo Dependency & Zero Circular Dependency Verification**:
   ```powershell
   npm run lint:depcruise
   ```
   *Expected outcome*: Exit code 0, confirming zero circular dependencies (`no-circular`) and strict layer decoupling.

3. **TypeScript Static Type Verification**:
   ```powershell
   npm run check:core
   ```
   *Expected outcome*: All TS workspaces (`crish-desktop`, `agent-workbench`, `shared-types`, `shared-utils`) compile with zero errors.

4. **Rust Cargo Check & Test Verification**:
   ```powershell
   cargo check --manifest-path apps/agent-workbench/src-tauri/Cargo.toml
   cargo test --workspace
   ```
   *Expected outcome*: Rust kernel crates and Tauri shell compile cleanly and pass all unit tests.
