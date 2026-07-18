# Style & UX Guidelines

## 1. Tooltips / Hover Tips
* **Use Custom Tooltips**: Always use the custom `<Tooltip>` component (imported from `@/components/settings/SettingsUI` or similar relative path) instead of native HTML `title` attributes for hover hints.
* **Avoid Browser Defaults**: Native browser `title` tooltips look inconsistent and outdated. Wrapping interactive elements in `<Tooltip content={...}>` ensures tooltips have a premium, rounded pill design with soft shadows and correct color themes.

## 2. Input Boxes & Focus States
* **No Heavy Box Shadows**: Do not add box shadows (`box-shadow`) to input fields, search boxes, or composers by default, especially on flat layouts. Keep the design clean, flat, and light.
* **Subtle Active Borders**: When inputs or buttons (such as `.shortcut-key-btn.recording` or `.input-container`) are in an active, focused, or recording state, **never** apply thick, dark, or solid black borders (e.g., using `var(--text-primary)` or `0 0 0 1px` ring styles).
* **Controlled Contrast**: Border lines should only be slightly darker/grayer than the component's background, just enough to outline the active area (e.g., using a 60/40 mix of `var(--border-color)` and `var(--text-primary)`). Always prioritize restraint and visual softness to protect user eye strain.
* **Double Check Contrast**: The active/focused state border change should be clearly visible and distinguishable to the naked eye (so it doesn't look like nothing happened), but must remain soft and light-gray (e.g. a 75/25 mix of `var(--border-color)` and `var(--text-primary)`), never reaching dark or black.
  * **Exception – Flat Landing Layouts**: For full-page empty state composers or similarly prominent landing-style inputs (e.g. `data-empty-kind="session-empty"`), the focus state border should use a very subtle mix of the **exact same** `var(--border-color)` with at most 5% of `var(--text-primary)` — **virtually no darkening at all**. The visual context (cursor position, placeholder fading) is sufficient to signal focus. Do not add any border-color transition.

## 3. Hover Effects
* **No Hover Jumping (translateY)**: When cards, chips, or prompt pills (such as `.quick-prompt-card`) are hovered, it is strictly forbidden to use vertical movement/jumping (such as `transform: translateY(-1px)`). Hover effects must be limited to soft background, border, and text color transitions.
