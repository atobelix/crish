# Conex Documentation Index

Index of the `docs/` tree. Live sources are `architecture/`, `rust-rewrite/`, `plans/`, and `organization/`; developer guides live in `guides/`; the open-source collaboration surface lives in `opensource/`; everything else is archived under `archive/` (read-only historical records).

---

## Active sources

- [architecture/](architecture/) — active architecture specs: system map, run control, daemon protocol, ADRs, desktop composition, observability.
- [rust-rewrite/](rust-rewrite/) — active Rust rewrite campaign: master plan, semantic contracts (01/02/03), task sheets (PE-01~12), audits, verification.
- [plans/](plans/) — active plans and progress ledger (`progress/system-control-ledger.md`, waves, OPT-E8).
- [organization/](organization/) — documentation governance: inventories, tree analysis, open-source docs plan (A1/A2/A3).

## Guides

- [guides/error-handling.md](guides/error-handling.md) — `@crish/shared-types` error system.
- [guides/hooks.md](guides/hooks.md) — lifecycle hooks (observe/on/emit).
- [guides/plugin-development.md](guides/plugin-development.md) — `@crish/plugin-sdk`.
- [guides/subagent-development.md](guides/subagent-development.md) — `@crish/agent-subagent`.
- [guides/testing/](guides/testing/) — integration test roadmap and Tauri smoke guide.

## Open source surface

- [opensource/CONTRIBUTING-PROVIDERS.md](opensource/CONTRIBUTING-PROVIDERS.md) — provider contribution guide (Chinese).
- [opensource/provider-dx/](opensource/provider-dx/) — provider system docs for external contributors (English): architecture, contributing, dev environment, catalog, troubleshooting.

## Archive (read-only history)

- [archive/legacy/](archive/legacy/) — superseded root-level plans/audits/execution records from the TS era (kept for reference; most reference deleted `packages/*`).
- [archive/provider-m4/](archive/provider-m4/) — M4 Provider delivery batch: POST-M4 reports, config contract, audit/, security/, performance/, perf/.
- [archive/campaigns/](archive/campaigns/) — closed multi-agent repair campaigns (benchmark-evolution-plans, v2_plan_review, refac, refactor-guides, round_12_audit, ui-jank-message-dnd-rootfix, system-completion-plans, crish_desktop_architectural_remediation_plan, systematic_solution_plan).
- [archive/redesign/](archive/redesign/) — parallel redesign drafts overlapping `rust-rewrite/` (rust-architecture-redesign, system-enhancement-plans, architecture-improvement, architecture-review, analysis, design, conversation_flow_plan).
- [archive/prototypes/](archive/prototypes/) — abandoned prototypes (`loading page/` Vite project, `new/` HTML copies).

---

## Repository entrypoints

- [README.md](../README.md) — product overview and build commands.
- [ARCHITECTURE.md](../ARCHITECTURE.md) — architecture truth document.
- [CONTRIBUTING.md](../CONTRIBUTING.md) — contribution guide.
