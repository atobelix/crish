# Wave 9–10 Dispatch Board

**For:** human orchestrator
**Date:** 2026-07-29
**真源:** `system-control-ledger.md` + master plan E0 / B3 / D0 residual
**Context:** Wave 7 **done**; W8-2 smoke **413 PASS**; W8-1/W8-3 soft/followUp **partial**; Wave 9 MCP draft/stop/hydrate **dispatched**; E0 still **partial**.

**Landed (do not re-implement):** pi force/steer/followUp queue (W6-1), soft Stop=L2 / Force=L3 (W7-5/8), hooks observe/on/emit + compact (B2/W7-1), compositionRoot facades (W5-2), draft MCP I-DRAFT (W7-9).

---

## Wave 9 (already dispatched — await results)

| ID | Goal | Notes |
|----|------|-------|
| W9-* | Live MCP draft / stop / hydrate slices | Extend `e0-mcp-journey.md`; **no** invent PASS for model send |

---

## Wave 10 — up to 8 agents

| ID | Goal | Ownership | Depends-on | Acceptance |
|----|------|-----------|------------|------------|
| **W10-1** | **MCP full send journey** — 新建→发→流→(工具)→Stop L2→可选 Force→重启 hydrate | `docs/plans/progress/e0-mcp-journey.md` only (record); live tauri-mcp | **Precondition:** live model/API + provider configured; else **SKIP** and note blocker. Prefers W9 draft smoke green | `e0-mcp-journey.md` updates **only observed** steps; full path PASS or explicit PENDING per step; ledger E0 note |
| **W10-2** | **Multi-unit split MCP (E0-5)** — split 双 unit，两会话 UI 独立，I-SHELL 不串坞 | scripts / progress notes; shell read-only | W9 draft path stable; multi-unit UI usable | Live: 2 strips / 2 leaves; focus A 不关 B tool; no shell mint; doc slice in `e0-mcp-journey.md` or sibling |
| **W10-3** | **B3 compositionRoot — sidebar「新对话」** 去掉散落 `getState().openNewDraftTab` | `apps/crish-desktop/src/components/sidebar/**` (handlers + General/Projects sections); `compositionRoot.ts` + test only if facade gap | W5-2 root exists | 新对话 / project draft **only** via `getCompositionRoot().shell.openNewDraftTab` (or `session.enterDraft`); no new getState in these paths; `compositionRoot` tests still green |
| **W10-4** | **D0 fixture parity (ROI pick)** — same md/stream fixtures: TS vs Rust SoT 一致；**not** full conex-stream wire | `apps/crish-desktop` md/api tests + any existing fixture dirs; **no** large crate redesign | D0-2 dead TS md already purged | Shared fixtures assert parity; doc residual note: D0-3 closed or list remaining; **defer D0-4 conex-stream eval** |
| **W10-5** | **Soft inject / queue productization** (if W8-1/W8-3 still partial) | `packages/agent-runtime` input queue / control; `apps/crish-desktop` `chat-stream` send + `runControlClient`; composer queueMode alignment | W6-1 queue + W8-1/W8-3 status | Runtime: steer @ safe point, followUp only idle-promote; UI busy-send → L1 `soft_inject`/`follow_up` **without** abort; metrics `run_control_L1`; tests green; **no** force mid-stream for default send |
| **W10-6** | **Integration fix** — triage bugs found by W9/W10 MCP; smallest correct fix | **Only** paths implicated by MCP bugs (declare ownership in PR/note) | After W10-1 and/or W10-2 findings | Repro fixed; targeted vitest + re-smoke MCP step; no drive-by refactors |
| **W10-7** | **Docs close-out** — ledger + ARCHITECTURE + run-control/hooks pointers | `docs/plans/progress/**`, `docs/architecture/**`, master plan §21 footnote only | After W10-1…6 land or SKIP | Ledger Wave 8/9/10 rows true; E0/B3/D0 status accurate; no duplicate truth tables |
| **W10-8** | **Optional: strip a11y polish residual** | `UnitSessionTabStrip*` + a11y tests only | W6-7 roving done | Overflow fade/keyboard edge cases; existing a11y tests pass + 1–2 new; **skip** if no residual found |

---

## Parallelism & order

```
W10-3 (B3 sidebar) ──┐
W10-4 (fixture)    ──┼── parallel (no shared writes)
W10-5 (soft inject)──┘     ⚠ avoid same chat-stream files as W10-6
W10-1 (full send MCP) ── precondition model ──► W10-6 (fix)
W10-2 (multi-unit MCP) ─────────────────────► W10-6
W10-8 optional anytime (strip only)
W10-7 docs last (or after each SKIP decision)
```

**Max parallel product writers:** W10-3 + W10-4 + W10-5 (+ W10-8). MCP agents read-only vs product except W10-6.

---

## Gate targets (Wave 10 end)

| Gate | Target |
|------|--------|
| E0-4 | Full send/stop/(tool)/restart **if** model available; else documented SKIP |
| E0-5 | Multi-unit MCP partial→PASS or explicit residual |
| B3 | Sidebar new-draft path via compositionRoot |
| D0 | Fixture parity closed; conex-stream still residual-by-choice |
| Soft inject | Product path matches pi steer/followUp + L1 metrics |
| Smoke | Re-run W8-2 slice or expand after W10-6 |

---

## Orchestrator checklist

1. Confirm provider/model before starting **W10-1**; else dispatch W10-2…5 first.
2. Reconcile W8-1 / W8-3 before/with **W10-5** (do not duplicate queue rings).
3. One Integrator (human or W10-6/7) owns merge + ledger row.
4. No product code from Docs/MCP record agents.

**Out of Wave 10:** process-out hooks, OTel e2e, full `check:desktop` unless free; conex-stream production wire (D0-4).
