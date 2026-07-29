# OPT-E8 — session-actions/ docs purge note

| Field | Value |
|-------|-------|
| Agent | Docs cleanup OPT-E8 |
| Date | 2026-07-29 |
| Kill | #8 (`architecture-dedup-inventory.md` §8) |
| Scope | `analysis/**` + `docs/**` only (no product TS) |
| Not edited (E1-owned) | `optimization-wave-board.md`, `system-control-ledger.md`, `architecture-dedup-inventory.md` |

## Live product map (post W4-2)

`apps/crish-desktop/src/store/session-actions/` **deleted**.

| Role | Path |
|------|------|
| Barrel | `apps/crish-desktop/src/store/sessionActions.ts` |
| CRUD | `sessionCrudActions.ts` |
| Messages | `sessionMessageActions.ts` |
| Ordering | `sessionOrderingActions.ts` |
| Agents | `sessionAgentActions.ts` |

Product UI / protocol “SessionAction” (More 菜单、Split View 等) is **orthogonal** — see `docs/architecture/workbench-session-actions-and-split-view.md` (clarified naming).

## Files edited (18)

### analysis/

1. `analysis/write_set_isolation_matrix_v2.md` — HISTORICAL banner
2. `analysis/master_repair_plan_v2/write_set_isolation_matrix_v2.md` — HISTORICAL banner
3. `analysis/2026-07-24-综合协同修复方案.md` — HISTORICAL banner
4. `analysis/2026-07-24-前端性能与拖拽问题审查报告.md` — banner + inline path note

### docs/

5. `docs/comprehensive_problem_analysis.md` — banner + path rewrite for “current” claims
6. `docs/systematic_solution_plan.md` — banner + OA-6 / V-50 / V-52 live greps
7. `docs/systematic_solution_plan/plan.md` — same
8. `docs/v2_plan_review/write_set_isolation_matrix_v2_CORRECTED.md` — banner + S4 correction note
9. `docs/v2_plan_review/v2_review_summary.md` — banner covering sibling JSON audits
10. `docs/round_12_audit/04_store_integrity.md` — banner
11. `docs/round_12_audit/10_layer_de_deviation.md` — banner
12. `docs/round_12_audit/audit_R1R2.md` — banner
13. `docs/round_12_audit/solution_A.md` — banner
14. `docs/round_12_audit/solution_B.md` — banner
15. `docs/round_12_audit/solution_C.md` — banner
16. `docs/crish_desktop_architectural_remediation_plan/05_state_api_layer.md` — banner + V-5 live check
17. `docs/architecture/workbench-session-actions-and-split-view.md` — retitle + product-vs-deleted-dir note
18. `docs/README.md` — link blurb clarifies product SessionAction ≠ deleted store dir

## Remaining intentional `session-actions/` mentions

All remaining hits should be one of:

| Class | Examples | Why keep |
|-------|----------|----------|
| **E1-owned kill tracking** | `architecture-dedup-inventory.md` §8, `system-control-ledger.md` (W4-2 删), `optimization-wave-board.md` OPT-E8 | Owned by E1; document the kill itself |
| **Deletion / wave history** | `docs/plans/2026-07-system-architecture-control-master-plan.md` Wave 4 “删 session-actions” | Correct historical fact of deletion |
| **Banner + body historical narrative** | round_12 solutions/audits, write_set matrices, systematic plans | Banner marks deleted; body not mass-rewritten (OPT-E8 rule) |
| **v2 JSON path audits (frozen)** | `docs/v2_plan_review/v2_path_audit.json`, `v2_cross_index.json`, `v2_remediation_review.json` | Machine-era snapshots; covered by `v2_review_summary.md` banner |
| **Daemon protocol filename (not store dir)** | `docs/refac/audit-P12-codebase-structure.md` → `session-actions.ts` under protocol validators | Different artifact (protocol module), not `store/session-actions/` |
| **Product doc filename / cross-links** | `workbench-session-actions-and-split-view.md`, `docs/system-completion-plans/.../04-session-fork-checkpoint-ui.md` | Product SessionAction contract; clarified ≠ deleted store folder |
| **This purge note** | `opt-e8-session-actions-docs-purge.md` | Inventory of remaining intentional refs |

## Verify recipe

```text
rg "session-actions/" analysis docs --glob '!**/node_modules/**'
```

Expect: every store-dir hit either (a) sits under a **HISTORICAL (OPT-E8 / W4-2)** banner, (b) records W4-2 deletion / kill #8, (c) is frozen JSON under `v2_plan_review/`, or (d) is this note / E1 board.

No product TypeScript was modified.
