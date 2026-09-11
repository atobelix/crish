# Style Token Unification (OPT-4)

**Scope:** `apps/crish-desktop` — audit + consolidate high-traffic surfaces onto existing tokens.
**Date:** 2026-07-29
**Goal:** Consistency only (no visual redesign).

---

## 1. Token entrypoints

| File | Role |
|------|------|
| [`apps/crish-desktop/src/index.css`](../../../apps/crish-desktop/src/index.css) | Import root — loads tokens first, then shell / chat / settings / theme layers |
| [`apps/crish-desktop/src/styles/tokens.css`](../../../apps/crish-desktop/src/styles/tokens.css) | Canonical `:root` + `html[data-theme="dark"]` design tokens (color, space, radius, type, shadow, layout) |
| [`apps/crish-desktop/src/styles/design-system.css`](../../../apps/crish-desktop/src/styles/design-system.css) | Supplementary slate scale + elevation utilities |
| [`apps/crish-desktop/src/styles/theme-dark.css`](../../../apps/crish-desktop/src/styles/theme-dark.css) | Component-level dark overrides (beyond raw tokens) |
| [`apps/crish-desktop/src/styles/z-index.css`](../../../apps/crish-desktop/src/styles/z-index.css) | Layer scale (`--z-*`) |
| [`apps/crish-desktop/src/styles/breakpoints.css`](../../../apps/crish-desktop/src/styles/breakpoints.css) | Breakpoint custom properties |
| [`apps/crish-desktop/src/styles/focus-visible.css`](../../../apps/crish-desktop/src/styles/focus-visible.css) | Soft focus rings (no heavy input shadows) |

Import order (from `index.css`): **tokens → design-system → responsive → z-index → shell\* → chat → settings\* → panels → theme-dark → a11y layers**.

---

## 2. Audit snapshot (hardcoded hex / duplicate patterns)

### High-frequency hex / fallback themes (modules + global CSS)

| Pattern | Approx. hotspots | Preferred token |
|---------|------------------|-----------------|
| `#22c55e` / `#2dbe6c` / `#16a34a` greens | DiffCard, ChatToolCall, ChangeOverview, shell-menus, panels | `--accent-green` / `--color-success` / `--color-active` |
| `#ef4444` / `#dc2626` / `#c44` reds | ApprovalAsk, ChatToolCall, DiffCard, InlineAgent, chat.css | `--accent-red` / `--color-error` / `--danger-color` (alias) |
| `#f59e0b` orange | ChatStatusRibbons, ApprovalAsk, ChatMsgFilter | `--accent-orange` / `--color-warning` |
| `#3b82f6` / `#1a73e8` / `#6c8cff` blues | BinaryTree, ChatMessageRow, StatusRibbons, tab-drag | `--accent-color` or `--accent-blue` (prefer theme accent) |
| `#ffffff` text on accent | shell-layout close, settings-models | `--text-on-accent` |
| `#e81123` / `#c50f1f` | inset window close only | **new** `--window-close-bg` / `--window-close-fg` |
| Stale hex **fallbacks** on vars (`var(--accent-*, #22c55e)`) | Widespread in modules | Prefer bare `var(--token)` once tokens are guaranteed |

### Spacing / radius (already partially tokenized)

Token ladder exists (`--space-0_5` … `--space-16`, `--radius-xs` … `--radius-full`). Residual debt is raw `px` in modules (settings panes, DiffCard, shell-workspace) rather than missing tokens.

---

## 3. Surfaces migrated this pass

### A. App top bar — `styles/shell/shell-layout.css`

| Before | After |
|--------|--------|
| `height/min/max: var(--header-height, 36px)` | `var(--header-height)` |
| Sidebar btn / trail btns `28px` | `var(--titlebar-item-h)` |
| `padding` / `gap` raw `6/8/10px` | `--space-1` / `--space-1_5` / `--space-2` / `--space-2_5` |
| Icon `16px` / `18px` | `--icon-size` / `--icon-size-lg` |
| Close hover `color: #ffffff` | `var(--text-on-accent)` |
| Hover `var(--sidebar-hover, rgba(...))` | `var(--sidebar-hover)` |
| Trail `z-index: 1` | `var(--z-decorative)` |
| Rail collapse width `36px` | `var(--header-height)` |
| Transition cubic raw | `--duration-normal` + `--easing-enter` |

Also: `.win-btn.close:hover` text → `--text-on-accent`.

### B. Settings tabs / cover chrome — `components/SettingsPanel.module.css`

| Before | After |
|--------|--------|
| Header pad `14px` | `--space-3_5` |
| Nav back height `36px` | `--control-height-lg` |
| Search margins / icon left / pad | space scale + `calc(--space-6 + --space-1_5)` for 30px icon inset |
| Cover nav padding `10px 12px 14px` | `--space-2_5` / `--space-3` / `--space-3_5` |
| Content pad `24px 20px 40px`, gap `14px` | `--space-6` / `--space-5` / `--space-10`, gap `--space-3_5` |
| `.sidebarTab` pad `8px 12px`, min-height `36px` | `--space-2` / `--space-3`, `--control-height-lg` |
| Tab icon box `20px` | `calc(var(--icon-size) + var(--space-1))` |
| Search focus | keeps soft focus (bg only, **no** input shadow) |

### C. Chat empty — `components/ChatEmptyState.module.css`

| Before | After |
|--------|--------|
| Wrong fallbacks (`--space-2, 6px`, `--space-5, 16px`, …) | Bare tokens with correct resolved values |
| Session pad `28px 0 12px` | `calc(var(--space-6) + var(--space-1)) 0 var(--space-3)` |
| Project title sizes `26px` / `24px` | `calc(--font-size-2xl + --space-1/0_5)` |
| Action radius `999px` | `--radius-full` |
| Prompt borders `rgba(0,0,0,0.04)` fallback | `var(--border-color)` |
| Focus `border-color: var(--focus-ring, blue)` (invalid as color) | `box-shadow: var(--focus-ring)` soft ring |

### D. Inset chrome close — `styles/shell/shell-workspace.css`

| Before | After |
|--------|--------|
| `#e81123` / `#c50f1f` hardcoded | `var(--window-close-bg)` / `var(--window-close-fg)` |

---

## 4. New tokens added (`tokens.css`)

```css
/* legacy/semantic aliases used across modules (prefer --color-* going forward) */
--danger-color: var(--color-error);
--accent-danger: var(--color-error);
--warning-color: var(--color-warning);

/* Windows caption close (shared by app top bar + inset chrome) */
--window-close-bg: #e81123;
--window-close-fg: #c50f1f;

/* modal / dialog scrim (OPT-B3) */
--bg-overlay: var(--shadow-color);
```

No dark overrides required for window-close (OS-standard reds). Aliases resolve through `--color-*` which dark already redefines. `--bg-overlay` shares `--shadow-color` (`#000`).

---

## 5. Residual debt (not in this pass)

| Area | Issue | Suggested next step |
|------|--------|---------------------|
| Module CSS modules | Hundreds of `var(--token, #hex)` stale fallbacks | Strip fallbacks file-by-file; tokens always defined in `:root` |
| shell-workspace hex | ~~`#1a73e8` accent fallbacks~~ **closed OPT-C4** | BinaryTree **closed OPT-D2** |
| panels.css hex | ~~Mac traffic-lights / `#4ade80` / `#d2d2d2`~~ **closed OPT-C4** | non-hex space/hairline dual fallbacks remain |
| settings-models | ~~green/red hex / switch / pills~~ **closed OPT-C4** | — |
| settings-plugins / advanced / usage / extensions | ~~green/red/orange residual~~ **closed OPT-D5** | non-hex dual fallbacks in plugins polish FB remain |
| Spacing raw px | Many modules still use bare `6px`/`8px`/`12px` | Prefer `--space-*` when touching files |
| `HARDCODED-TOKEN-AUDIT.md` (repo root) | Baseline audit still valid for coverage % | Re-run counts after next wave |

---

## 8. Residual closed — OPT-B3 (2026-07-29)

**Surfaces:** DiffCard, ApprovalAskCard, ChatToolCall (+ ToolCallHeader), settings-base.

### Changes

| Surface | Before | After |
|---------|--------|--------|
| `DiffCard.module.css` | `var(--accent-green/red/orange/blue, #hex)`, `var(--bg-card/#ffffff)`, `var(--text-muted, #71717a)`, adaptive color-mix hex fallbacks | Bare `var(--accent-*)`, `var(--bg-card)`, `var(--text-muted)`; line add/del bg → `var(--accent-*-light-adaptive, var(--accent-*-light))` |
| `ApprovalAskCard.module.css` | orange/danger/green hex fallbacks on risk border, chips, timeout bar, armed outline | Bare `var(--accent-orange)`, `var(--accent-danger)`, `var(--accent-green)` |
| `ChatToolCallBlock.module.css` | green/red hex on icon slot, retry, diff stats, batch approve/deny | Bare `var(--accent-green)` / `var(--accent-red)` |
| `ToolCallHeader.tsx` | inline `color="var(--accent-*, #hex)"` | Bare token refs (snapshot updated) |
| `settings-base.css` | danger `#c44`, model hints `#16a34a`/`#b91c1c`, switch `#f0f0f0`/`#22b671`/`#a7f3d0`/`#ffffff`, eco overlay `#000` | Bare danger/accent tokens; off-track mix uses `var(--bg-tertiary)`; knob `var(--bg-elevated)`; focus `var(--accent-green-muted)`; eco `var(--bg-overlay)` |

### Token added (`tokens.css`)

```css
--bg-overlay: var(--shadow-color); /* modal/dialog scrim */
```

No visual redesign; hex fallbacks removed only (switch off-track base now theme-aware via `--bg-tertiary` instead of fixed `#f0f0f0`).

---

## 6. Before / after (token usage summary)

| Surface | Before | After |
|---------|--------|--------|
| Top bar chrome | Mixed tokens + hex + magic px | Tokens for size, space, color, z, motion |
| Settings sidebar tabs | Tokens for color; raw px layout | Layout + color on space/control tokens |
| Chat empty | Tokens with **wrong** fallbacks; some raw px | Correct tokens; focus ring fixed |
| Window close (inset) | Raw Windows reds | Named tokens |

**Visual intent:** preserve existing computed sizes (token values already in `:root`). Only invalid focus color and documented aliases/window-close colors change semantically.

---

## 7. References

- Agent-05 CSS variables notes: `analysis - 副本/agents/agent-05-analysis.md`, `agent-05-plan.md` (drag tokens / no fallback reliance)
- Prior audit: `HARDCODED-TOKEN-AUDIT.md`
- AGENTS guidance: soft focus borders, no heavy input shadows (settings search / empty focus preserved)

---

## 9. Residual closed — OPT-C4 (2026-07-29)

**Surfaces:** shell-* CSS, settings-models, panels (+ token additions).

### Changes

| Surface | Before | After |
|---------|--------|--------|
| `shell/shell-layout.css` | `var(--bg-*/--text-*/--accent-green/--border-*, #hex)` boot/spinner/chip | Bare tokens (`--bg-secondary`, `--text-primary`, `--accent-green`, …) |
| `shell/shell-workspace.css` | `#1a73e8` accent fallbacks on drag/tab placeholders; `#000` chrome mix; nested `#f2f2f2`/`#ffffff`/`#8a8a8a` | Bare `--accent-color` / `--bg-*` / `--text-tertiary`; chrome mix uses `--shadow-color` |
| `shell/shell-dragdrop.css` | `var(--accent-color, #1a73e8)` | Bare `--accent-color` |
| `shell/shell-polish.css` | green `#2dbe6c` fallbacks; `var(--bg-elevated, #fff)` | Bare `--accent-green` / `--bg-elevated` |
| `shell/shell-menus.css` | `var(--accent-green, #22c55e)` sort filter | Bare `--accent-green` |
| `settings/settings-models.css` | red/green hex fallbacks; switch `#19b36b`/`#f0f0f0`/`#fff`; pill `rgba(22,163,74,…)` / warn `#ca8a04`/`#b45309`; rail `#ffffff` | Bare accents; switch aligns with settings-base (`--accent-green`, theme-aware off-track, `--bg-elevated` knob); pills via `color-mix` + `--color-active` / `--color-warning`; rail text `--text-on-accent` |
| `panels.css` | term prompt `#4ade80`; Mac traffic lights; spinner green fallbacks; checklist `#d2d2d2` | `--terminal-prompt`; `--mac-dot-*`; bare `--accent-green`; `--border-color` |

### Tokens added (`tokens.css`)

```css
--terminal-prompt: #4ade80; /* classic terminal prompt green (light + dark) */
--mac-dot-red: #ff5f56;
--mac-dot-yellow: #ffbd2e;
--mac-dot-green: #27c93f;
```

Also: light `--terminal-bar-fill` → `color-mix(..., var(--shadow-color) 3%)`; dark → `color-mix(..., var(--text-primary) 4%)` (was raw rgba).

No visual redesign; binary-tree / BinaryTree left untouched. Switch on-color moves from fixed `#19b36b` to theme `--accent-green` (same family as settings-base OPT-B3).

### Residual still open

| Area | Issue | Suggested next |
|------|--------|----------------|
| Module CSS modules | Remaining `var(--token, #hex)` / raw px outside this pass | File-by-file strip |
| BinaryTree / tab-drag | ~~Accent blue fallbacks (explicitly out of OPT-C4)~~ **closed OPT-D2** | — |
| settings-plugins / advanced / usage / extensions | ~~Same green/red residual as models~~ **closed OPT-D5** | non-hex dual fallbacks in plugins polish FB |
| panels.css non-hex | Many `var(--space-*, Npx)` / hairline dual fallbacks | Spacing pass |
| shell-polish / shell-menus | Non-hex token dual fallbacks (`var(--hairline, var(--border-subtle))`) | Optional cleanup |
| Comment-only hex in settings-models | Historical notes mention `#22b671` / `#f0fdf4` | Ignore or scrub comments |

---

## 10. Residual closed — OPT-D5 (2026-07-29)

**Surfaces:** `settings-plugins`, `settings-advanced`, `settings-usage`, adjacent `settings-extensions`.

### Changes

| Surface | Before | After |
|---------|--------|--------|
| `settings/settings-plugins.css` | `var(--accent-green, #2dbe6c)` on usage bar-fill / ratio-in / `.ext-installed-mark`; `var(--accent-orange, #f59e0b)` on cost fill; `var(--settings-content-max, 720px)` | Bare `var(--accent-green)` / `var(--accent-orange)` / `var(--settings-content-max)` |
| `settings/settings-advanced.css` | `var(--accent-red, #b91c1c)` on rules danger hover; content-max dual fallback | Bare `var(--accent-red)` / `var(--settings-content-max)` |
| `settings/settings-usage.css` | Raw `#22b671` in `color-mix` for `.is-out` bar + ratio-out; content-max dual | Bare `var(--accent-green)` / `var(--settings-content-max)` |
| `settings/settings-extensions.css` | `.ext-installed-mark` raw `#22b671` / `#f0fdf4` + dark hex mixes (overrides plugins after import) | `var(--accent-green)` + `var(--accent-green-light)` border/bg; dark override dropped (tokens theme-aware) |

No new tokens (0 aliases). No visual redesign; hex fallbacks / raw greens removed only. Status pill aligns with settings-plugins / models green family (`--accent-green` / `--accent-green-light`).

### Residual still open after D5

| Area | Issue | Suggested next |
|------|--------|----------------|
| `settings-plugins.css` polish FB block | Many `var(--space-*, Npx)` / `var(--hairline, var(--border-subtle))` / `var(--focus-ring, …)` duals | Optional spacing/hairline pass (same as panels) |
| BinaryTree | ~~Accent blue fallbacks (OPT-D2)~~ **closed OPT-D2** | — |
| Comment-only hex in settings-models | Historical `#22b671` / `#f0fdf4` notes | Ignore or scrub comments |

---

## 11. Residual closed — OPT-D2 (2026-07-29)

**Surfaces:** BinaryTree workspace, unit session tab strip, tab-drag CSS + ghost inline styles.

### Changes

| Surface | Before | After |
|---------|--------|--------|
| `binary-tree/BinaryTreeWorkspace.module.css` | `var(--bg-*/--text-*/--border-*, #hex)`; drop zone `var(--accent-color, #1a73e8)`; ghost `rgba(0,0,0,0.18)`; nested hairline hex | Bare `--bg-primary` / `--text-*` / `--border-color` / `--hairline`; drop + border/glow → bare `--accent-color` (same as shell-workspace OPT-C4); ghost shadow → `color-mix(..., var(--shadow-color) 18%)` |
| `binary-tree/UnitSessionTabStrip.module.css` | text/border/shadow hex fallbacks; `var(--focus-ring, var(--accent, #3b82f6))` as **outline color** (invalid — `--focus-ring` is a box-shadow); nested strip chrome fallbacks | Bare text/border/shadow tokens; focus → `outline: none; box-shadow: var(--focus-ring)` (soft focus, matches shell-polish / focus-visible.css); strip line → `--hairline`; active bg keeps `var(--shell-inset-bg, var(--bg-primary))` (shell context dual, no hex) |
| `styles/tab-drag.css` | `--dnd-indicator-color: var(--accent-color, #4a9eff)`; ghost bg `#ffffff`; accent border `#1a73e8`; raw `rgba` shadows | Bare `--accent-color` / `--bg-primary`; shadows via `--shadow-color` color-mix |
| `hooks/tab-drag/tabDragGhost.ts` | Inline ghost styles mirrored CSS hex / rgba | Same bare tokens + `--shadow-color` mixes (keeps drag physics / layout unchanged) |

### Token mappings (highlights)

| Hardcoded / fallback | Token |
|----------------------|--------|
| `#1a73e8` / `#4a9eff` accent blues | `--accent-color` (theme accent; aligns shell drag) |
| `#3b82f6` focus outline (via invalid `--focus-ring` color use) | `--focus-ring` as **box-shadow** (soft ring) |
| `#fff` / `#ffffff` surfaces | `--bg-primary` |
| `#111` / `#666` / `#999` text | `--text-primary` / `--text-secondary` / `--text-tertiary` |
| `#e5e5e5` / nested border | `--border-color` / `--border-subtle` / `--hairline` |
| `#000` / `rgba(0,0,0,…)` shadows | `--shadow-color` via `color-mix` |
| `#f7f7f7` empty state | `--bg-secondary` |

### Tokens added

None — existing tokens sufficient.

### Visual risk notes

- Drop/tab-drag indicators use **theme `--accent-color`** (light: warm charcoal; dark: near-white), not fixed Material blue — same intentional shift as OPT-C4 shell-workspace.
- Unit tab keyboard focus moves from hard blue outline to soft `--focus-ring` (design-system standard); no layout/sash/drag algorithm changes.

---

## 12. Residual closed — OPT-E2 (2026-07-29)

**Surfaces:** chat CSS cluster — StatusRibbons, Composer, MessageRow, MsgFilterBar.

### Changes

| Surface | Before | After |
|---------|--------|--------|
| `ChatStatusRibbons.module.css` | `var(--accent-color, #6c8cff)` ×7; `var(--danger-color, #c44)` ×4; `var(--accent-orange, #f59e0b)` ×9; `var(--accent, #3b82f6)` ×2; `var(--accent-green, #22c55e)` ×1 | Bare `--accent-color` / `--danger-color` / `--accent-orange` / `--accent-green` (legacy bare `--accent` → `--accent-color`) |
| `ChatComposer.module.css` | `var(--accent-color, #6c8cff)` on active slash cmd / desc mix ×2 | Bare `var(--accent-color)` |
| `ChatMessageRow.module.css` | `var(--accent, #3b82f6)` search-hit; raw `#e8e8e6` user-bubble mix; `var(--accent-color, #6af)` pin flash | Bare `--accent-color`; bubble → `color-mix(..., var(--bg-elevated) 12%)` |
| `ChatMsgFilterBar.module.css` | `var(--accent-orange, #f59e0b)` empty count | Bare `var(--accent-orange)` |

### Tokens added

None — existing tokens sufficient.

### Hex counts (color)

| File | Before | After |
|------|--------|-------|
| `ChatStatusRibbons.module.css` | 23 | 0 |
| `ChatComposer.module.css` | 2 | 0 |
| `ChatMessageRow.module.css` | 3 | 0 |
| `ChatMsgFilterBar.module.css` | 1 | 0 |
| **Total** | **29** | **0** |

No visual redesign; non-hex dual fallbacks (`var(--hairline, var(--border-subtle))`, `var(--chat-col-max, 760px)`, etc.) left as residual debt (same class as panels / plugins polish).

---

## 13. Residual closed — OPT-E3 (2026-07-29)

**Surfaces:** provider health, account status, toast stack, error boundary, change-overview mini accept, CardPanel / AgentCard.

### Changes

| Surface | Before | After |
|---------|--------|--------|
| `provider/HealthCheckIndicator.module.css` | `var(--accent-green/orange, #hex)` on healthy/degraded; `var(--error, #ef4444)` on down; pulse keyframes hex | Bare `--accent-green` / `--accent-orange` / `--accent-red` (unknown `--error` → `--accent-red`) |
| `accounts/AccountStatusIndicator.module.css` | green/orange/red hex fallbacks + breathe keyframes | Bare `--accent-green` / `--accent-orange` / `--accent-red` |
| `ToastStack.module.css` | elevated/text/border hex fallbacks; `rgba(0,0,0,0.18)` shadow; white `rgba` btn fills | Bare bg/text/border tokens; shadow → `color-mix(..., var(--shadow-color) 18%)`; btn fills → `color-mix(..., var(--text-primary) N%)` |
| `AppErrorBoundary.module.css` | bg/error nested hex duals; `#3b82f6`/`#2563eb` link | Bare `--bg-*` / `--color-error*` / `--accent-color` / `--accent-hover` |
| `ChangeOverviewCard.module.css` | accept mini btn green hex ×3 | Bare `--accent-green` |
| `CardPanel.module.css` | text secondary/primary hex | Bare `--text-secondary` / `--text-primary` |
| `AgentCard.module.css` | danger btn `var(--accent-red, #ff6b6b)` | Bare `--accent-red` |

### Tokens added

None — existing tokens sufficient.

### Hex counts (color)

| File | Before | After |
|------|--------|-------|
| `HealthCheckIndicator.module.css` | 13 | 0 |
| `AccountStatusIndicator.module.css` | 12 | 0 |
| `ToastStack.module.css` | 7 | 0 |
| `AppErrorBoundary.module.css` | 8 | 0 |
| `ChangeOverviewCard.module.css` | 3 | 0 |
| `CardPanel.module.css` | 2 | 0 |
| `AgentCard.module.css` | 1 | 0 |
| **Total** | **46** | **0** |

No visual redesign; non-hex dual fallbacks (`var(--font-size-*, Npx)`, focus-ring duals on toast) left as residual debt.

---

## 14. Residual closed — OPT-E4 (2026-07-29)

**Surfaces:** settings UI / sidebar / MCP / models / skills module CSS residual hex.

### Changes

| Surface | Before | After |
|---------|--------|--------|
| `settings/SettingsUI.module.css` | tooltip `var(--bg-*/--border-*/--text-*, #hex)` light+dark; raw `rgba(0,0,0,…)` shadows | Bare `--bg-primary` / `--bg-elevated` / `--border-subtle` / `--text-primary`; shadows → `color-mix(..., var(--shadow-color) N%)` |
| `sidebar/SidebarSessionList.module.css` | `var(--accent-primary, #3b82f6)`; legacy `var(--accent, #3b82f6)` running pulse / drop lines | Bare `--accent-primary` (unknown bare `--accent` collapsed) |
| `McpSettingsTab.module.css` | orange warn pill/dot/badge/error-line hex fallbacks | Bare `--accent-orange` |
| `Sidebar.module.css` | green update chip + icon-collapse active `#3b82f6` / `#2dbe6c` fallbacks | Bare `--accent-green` / `--accent-primary` |
| `WorkspaceChromeBars.module.css` | `var(--ws-session-line, #f3f3f3)` + comment hex | Bare `--ws-session-line` (set in shell-workspace) |
| `ModelsSettingsTab.module.css` | raw `#22c55e` pill/badge mixes; toggle `#ffffff`; red danger `#b91c1c` fallbacks | `--color-active` mixes; thumb → `--text-on-accent`; bare `--accent-red`; shadow → `--shadow-color` mix |
| `SkillsSettingsTab.module.css` | orange/green hex fallbacks on warn/stats/dot/active | Bare `--accent-orange` / `--accent-green` |

### Tokens added

None — existing tokens sufficient (`tokens.css` untouched).

### Hex counts (color)

| File | Before | After |
|------|--------|-------|
| `SettingsUI.module.css` | 11 | 0 |
| `SidebarSessionList.module.css` | 6 | 0 |
| `McpSettingsTab.module.css` | 6 | 0 |
| `Sidebar.module.css` | 3 | 0 |
| `WorkspaceChromeBars.module.css` | 1 (+2 comment) | 0 |
| `ModelsSettingsTab.module.css` | 5 | 0 |
| `SkillsSettingsTab.module.css` | 4 | 0 |
| **Total** | **~36** | **0** |

No visual redesign; no `tokens.css` churn; Chat* (E2) / HealthCheck·AccountStatus·Toast (E3) left alone. Non-hex dual fallbacks (`var(--hairline, var(--border-subtle))`, etc.) remain residual debt.

---

## 15. Residual closed — OPT-F2 (2026-07-29)

**Surfaces:** provider / settings / workspace cluster residual hex.

### Changes

| Surface | Before | After |
|---------|--------|--------|
| `provider/ModelDetailPanel.module.css` | `var(--accent, #3b82f6)` cap badges ×3; `var(--error, #ef4444)` deprecated ×2 | Bare `--accent-color`; unknown `--error` → bare `--accent-red` (same as OPT-E3) |
| `provider/AuthConfigSection.module.css` | `var(--accent, #3b82f6)` active auth tab ×3 | Bare `--accent-color` |
| `settings/UserViewDebugPanel.module.css` | `var(--success-color, #1a7f37)` ok badge; `var(--warning-color, #9a6700)` warn badge | Bare `--color-success` (no `--success-color` token); bare `--warning-color` |
| `Workspace.module.css` | `var(--text-primary, #111)` active outline; `var(--accent-color, #333/#1a73e8)` placeholder/drop; raw `rgba(55,65,81,0.03)` | Bare `--text-primary` / `--accent-color`; bg → `color-mix(..., var(--control-mix-color) 3%)` |
| `SettingsUsageTab.module.css` | raw `rgba(0,0,0,0.4)` scrim; bg/border/shadow hex fallbacks; `var(--accent-primary, #4f46e5)` bar fill | `color-mix(..., var(--bg-overlay) 40%)`; bare `--bg-primary` / `--border-subtle` / `--shadow-lg` / `--accent-primary` |

### Tokens added

None — existing tokens sufficient (`tokens.css` untouched).

### Hex counts (color)

| File | Before | After |
|------|--------|-------|
| `ModelDetailPanel.module.css` | 5 | 0 |
| `AuthConfigSection.module.css` | 3 | 0 |
| `UserViewDebugPanel.module.css` | 4 | 0 |
| `Workspace.module.css` | 6 | 0 |
| `SettingsUsageTab.module.css` | 5 | 0 |
| **Total** | **23** | **0** |

No visual redesign; no `tokens.css` churn; chat-markdown / ProjectPicker (F3) and board edits left alone. Non-hex dual fallbacks (`var(--font-size-*, Npx)`, `var(--space-*, Npx)`, etc.) remain residual debt.

---

## 16. Residual closed — OPT-F3 (2026-07-29)

**Surfaces:** chat markdown styles + chrome bits (project picker, right tool dock header, sidebar context menus, overview card, model picker, chat header).

### Changes

| Surface | Before | After |
|---------|--------|--------|
| `styles/chat/chat-markdown.css` | `var(--accent-green, #16a34a)` on task-box checked border/bg/check ×3 | Bare `--accent-green` |
| `ProjectPickerMenu.module.css` | `var(--accent-red, #ef4444)` delete hover color + mix | Bare `--accent-red` |
| `right-tool-dock/RightToolDockHeader.module.css` | text/bg/border hex fallbacks; `rgba` hairline dual; `var(--focus-ring, var(--accent, #3b82f6))` as outline color; ghost `rgba(0,0,0,0.18)` shadow | Bare `--text-tertiary` / `--bg-primary` / `--border-color` / `--text-primary`; hairline chain without rgba; focus → `outline: none; box-shadow: var(--focus-ring)`; shadow → `color-mix(..., var(--shadow-color) 18%)` |
| `sidebar/SidebarContextMenus.module.css` | `var(--accent-green, #22c55e)` sort-filter on/check ×2 | Bare `--accent-green` |
| `OverviewCard.module.css` | `var(--accent-orange/green, #hex)` status dots | Bare `--accent-orange` / `--accent-green` |
| `ModelPicker.module.css` | `var(--accent-red-light, #fef2f2)` / `var(--accent-red, #b91c1c)` error pill | Bare `--accent-red-light` / `--accent-red` |
| `chat-card/ChatHeader.module.css` | `var(--sidebar-hover, rgba(0,0,0,0.06))`; invalid focus-ring outline hex dual | Bare `--sidebar-hover`; focus → `outline: none; box-shadow: var(--focus-ring)` |

### Tokens added

None — existing tokens sufficient (`tokens.css` / `theme-dark` untouched).

### Hex counts (color)

| File | Before | After |
|------|--------|-------|
| `chat-markdown.css` | 3 | 0 |
| `ProjectPickerMenu.module.css` | 2 | 0 |
| `RightToolDockHeader.module.css` | 7 | 0 |
| `SidebarContextMenus.module.css` | 2 | 0 |
| `OverviewCard.module.css` | 2 | 0 |
| `ModelPicker.module.css` | 2 | 0 |
| `ChatHeader.module.css` | 2 | 0 |
| **Total** | **20** | **0** |

No visual redesign; no `tokens.css` churn. Non-hex dual fallbacks (`var(--hairline, var(--border-subtle, var(--border-color)))`, `var(--font-size-xs, 12px)`, shell-inset duals, etc.) remain residual debt.

---

## 17. Residual closed — OPT-G2 (2026-07-29)

**Surfaces:** final tiny color-hex residual strip (TerminalCard / InlineAgent / QuickOpen / ScheduledTasks / chat.css / settings-models comments + 1–2-hex modules).

### Changes

| Surface | Before | After |
|---------|--------|--------|
| `TerminalCard.module.css` | `var(--terminal-err, #f87171)` | Bare `var(--terminal-err)` |
| `InlineAgentPanel.module.css` | `var(--accent-red/#c44)`, `var(--danger-color, #c44)` ×2, `var(--accent-orange, #f59e0b)` mix | Bare `--accent-red` / `--danger-color` / `--accent-orange` |
| `QuickOpen.module.css` | `var(--accent-color, #4a9eff)` active inset | Bare `var(--accent-color)` |
| `ScheduledTasksPanel.module.css` | `var(--accent-orange, #f59e0b)` err status | Bare `var(--accent-orange)` |
| `styles/chat.css` | orange/danger/red hex fallbacks ×3 | Bare `--accent-orange` / `--danger-color` / `--accent-red` |
| `settings/settings-models.css` | comment-only `#22b671` / `#f0fdf4` notes ×2 | Scrubbed to tokenized prose (no hex) |
| `SettingsProfileTab.module.css` | `var(--danger-color, #c44)` | Bare `var(--danger-color)` |
| `CheatsheetModal.module.css` | `var(--bg-overlay, #000)` eco scrim | Bare `var(--bg-overlay)` |
| `provider/ProviderDetail.module.css` | toggle knob raw `#fff` | `var(--bg-elevated)` (same family as settings switch knobs) |

### Tokens added

None — existing tokens sufficient (`tokens.css` / `theme-*.css` untouched).

### Hex counts (color)

| File | Before | After |
|------|--------|-------|
| `TerminalCard.module.css` | 1 | 0 |
| `InlineAgentPanel.module.css` | 4 | 0 |
| `QuickOpen.module.css` | 1 | 0 |
| `ScheduledTasksPanel.module.css` | 1 | 0 |
| `chat.css` | 3 | 0 |
| `settings-models.css` | 2 (comment) | 0 |
| `SettingsProfileTab.module.css` | 1 | 0 |
| `CheatsheetModal.module.css` | 1 | 0 |
| `ProviderDetail.module.css` | 1 | 0 |
| **Total** | **15** | **0** |

No visual redesign. Left open (out of G2 1–2-hex sweep): `FirstRunWizard.module.css` (`#fff` ×3 + overlay `#000` fallback); non-CSS TSX/TS inline hex; `App.module.css` / `chat-composer.css` dual fallbacks outside this target list.

