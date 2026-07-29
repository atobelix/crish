# D0 residual — markdown fixture parity

**Agent:** Implementer W10-D0 / W10-4  
**Date:** 2026-07-29  
**Scope:** completed-message path — Rust async SoT vs TS sync / worker fallback  
**Ownership:** `apps/crish-desktop` markdown\* tests; thin crate fixture mirror in `conex-markdown`

## Goal

Same small fixture set through:

1. **Rust async path** (completed chat: `AsyncMarkdownBlock` → `useAsyncMarkdownHtml` → `parseMarkdownToHtmlAsync` → `md_render`)
2. **TS sync fallback** (`parseMarkdownToHtml` / worker when Rust missing)

must not diverge **critically** (structure + CSS SoT classes). Sync fallback is **kept**.

## Existing coverage (found)

| Layer | Path | Role |
|-------|------|------|
| TS lists/GFM contract | `apps/crish-desktop/src/api/markdownRender.lists.test.ts` | Sync parser deep contract (~60 cases) |
| TS async plumbing | `apps/crish-desktop/src/api/markdownRenderAsync.test.ts` | Cache / Rust ok / worker missing / hook |
| TS cache | `apps/crish-desktop/src/api/markdownCache.test.ts` | LRU keys / eviction |
| Rust integration | `crates/conex-markdown/tests/integration.rs` | Port of lists contract for `render_markdown` |
| Completed-message UI | `AsyncMarkdownBlock.tsx` | Streaming = plain text; complete = async SoT |

No shared fixture module existed before this slice.

## What landed

### Shared fixtures (desktop)

`apps/crish-desktop/src/api/fixtures/markdown-parity-cases.ts`

| id | Shape |
|----|--------|
| `lists` | tight UL + `**P0**` bold markers + h3 |
| `code_fence` | ```` ```ts ```` fence + chrome |
| `bold` | inline `**world**` / `**P0**` |
| `list_bold_code` | heading + list + fence + closing bold (completed-message shape) |

Also documents **intentional engine differences** (see below).

### Parity tests (desktop)

`apps/crish-desktop/src/api/markdownRender.parity.test.ts` (15 tests)

Per fixture:

1. **TS sync** satisfies structural contracts (`mustContain` / counts / no `p>li`)
2. **Async + Rust missing** → worker schedule → **byte-for-byte equal** to TS sync (same parser)
3. **Async + Rust mock** prefers `md_render` HTML; worker not called; structure holds

Plus: sync fallback export guardrail; dashes-inside-fence not list-items on both paths.

### Rust mirror

`crates/conex-markdown/tests/parity_fixtures.rs` (4 tests)

Same four markdown sources; structural CSS contracts only. Comment points back to the TS fixture module (keep sources aligned).

## Intentional differences (do not assert equality)

| Area | Rust | TS | Policy |
|------|------|-----|--------|
| Code tokens | syntect spans | highlight.js `hljs-*` | Outer `md-code-block` / `md-code-pre` / lang class required; **inner spans may differ** |
| Lang badge | alias table | hljs may map `ts`→`typescript` | Accept `ts\|typescript`, `js\|javascript` via regex |
| Sanitize | ammonia at render | escape + component DOMPurify | Body XSS escape still required both sides |
| Full HTML | — | — | **No** Rust↔TS byte-for-byte requirement |
| Sync ↔ worker async | N/A | same `parseMarkdownToHtml` | **Yes** byte-for-byte when Rust missing |

## Commands / results

```bash
# Desktop markdown suite
npx vitest run \
  src/api/markdownRender.parity.test.ts \
  src/api/markdownRender.lists.test.ts \
  src/api/markdownRenderAsync.test.ts \
  src/api/markdownCache.test.ts \
  src/api/markdown-render/markdownSanitizer.test.ts \
  --coverage.enabled=false
# → 5 files, 113 passed

# Rust parity fixtures
cargo test -p conex-markdown --test parity_fixtures
# → 4 passed
```

## Residual

| Item | Status |
|------|--------|
| Small fixture set (lists / fence / bold / combined) | **Closed** |
| Sync fallback retained | **Yes** — not deleted; guarded by test |
| Rust↔TS full HTML golden dump | Deferred — intentional token-span drift; structural only |
| Shared JSON loaded by both languages (seek-cases style) | Optional follow-up; sources currently dual-maintained with cross-comments |
| D0-4 conex-stream wire / eval | **Out of scope** (Wave 10 board) |
| Stream-path incremental parser parity | N/A — stream is plain text + lite strip, not HTML |

## Policy compliance

| Rule | Status |
|------|--------|
| Do not delete sync fallback | Yes |
| No large crate redesign | Yes (4 structural tests only) |
| Completed-message path focus | Yes |
| Document intentional diffs | Yes (fixture module + this note) |

## Files touched

- `apps/crish-desktop/src/api/fixtures/markdown-parity-cases.ts` **new**
- `apps/crish-desktop/src/api/markdownRender.parity.test.ts` **new**
- `crates/conex-markdown/tests/parity_fixtures.rs` **new**
- `docs/plans/progress/d0-md-fixture-parity.md` **new** (this file)
