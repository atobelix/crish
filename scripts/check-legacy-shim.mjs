#!/usr/bin/env node
/**
 * Legacy shim removal check (guardrail 24/25).
 *
 * Walks packages/ and apps/ recursively, reads .ts/.tsx files, and checks
 * for deprecated/legacy patterns that should have been removed after the
 * v0.3.0 migration. Exits 0 if clean, 1 if violations are found.
 *
 * No external dependencies — only Node.js built-ins (fs, path).
 *
 * Run: node scripts/check-legacy-shim.mjs
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const SCAN_DIRS = [resolve(root, 'packages'), resolve(root, 'apps')];

// Directory fragments that should never be walked.
const EXCLUDE_DIR_FRAGMENTS = new Set([
  'node_modules',
  'dist',
  'build',
  '.turbo',
  'target',
  '.git',
]);

// File-level exclusions: tests may reference legacy names as negative cases.
function isExcludedFile(filePath) {
  if (filePath.endsWith('.test.ts')) return true;
  if (filePath.endsWith('.test.tsx')) return true;
  if (filePath.endsWith('.spec.ts')) return true;
  if (filePath.endsWith('.spec.tsx')) return true;
  if (filePath.includes(`${sep}__tests__${sep}`)) return true;
  if (filePath.includes(`${sep}tests${sep}integration${sep}`)) return true;
  return false;
}

// Each pattern: name, regex, guardrail reason.
// `anchor` is used to allow path-aware scoping (e.g. daemon-logger allowed
// only inside agent-daemon).
const PATTERNS = [
  {
    name: 'definePlugin( call',
    regex: /\bdefinePlugin\s*\(/,
    reason: 'guardrail 24 — old 17-line plugin shim API removed in v0.3.0',
  },
  {
    name: 'new SessionError(',
    regex: /\bnew\s+SessionError\s*\(/,
    reason: 'guardrail 25 — old error class removed',
  },
  {
    name: 'new ProviderError(',
    regex: /\bnew\s+ProviderError\s*\(/,
    reason: 'guardrail 25 — old error class removed',
  },
  {
    name: 'new ProtocolError(',
    regex: /\bnew\s+ProtocolError\s*\(/,
    reason: 'guardrail 25 — old error class removed',
  },
  {
    name: 'new PermissionError(',
    regex: /\bnew\s+PermissionError\s*\(/,
    reason: 'guardrail 25 — old error class removed',
  },
  {
    name: "Logger imported from @crish/shared-utils",
    regex:
      /import\s+\{[^}]*\bLogger\b[^}]*\}\s+from\s+['"]@crish\/shared-utils['"]/,
    reason: 'R2 — Logger now comes from @crish/logger; shared-utils re-export removed',
  },
  {
    name: "Logger imported via shared-utils (any form)",
    regex: /import\s+[^;]*\bLogger\b[^;]*from\s+['"][^'"]*shared-utils['"]/,
    reason: 'R2 — Logger now comes from @crish/logger; shared-utils re-export removed',
  },
];

function walkTsFiles(dir, accumulator) {
  if (!existsSync(dir)) return accumulator;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return accumulator;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (EXCLUDE_DIR_FRAGMENTS.has(entry)) continue;
      walkTsFiles(full, accumulator);
    } else if (st.isFile()) {
      if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
        if (isExcludedFile(full)) continue;
        accumulator.push(full);
      }
    }
  }
  return accumulator;
}

function collectFiles() {
  const files = [];
  for (const dir of SCAN_DIRS) {
    walkTsFiles(dir, files);
  }
  return files;
}

const files = collectFiles();
let violations = 0;
const details = [];

for (const file of files) {
  let content;
  try {
    content = readFileSync(file, 'utf-8');
  } catch {
    continue;
  }
  const lines = content.split(/\r?\n/);
  for (const { name, regex, reason, allowedIf } of PATTERNS) {
    if (allowedIf && allowedIf(file)) continue;
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        const rel = relative(root, file).split(sep).join('/');
        const loc = `${rel}:${i + 1}`;
        details.push(`  [VIOLATION] ${loc}: ${name} — ${reason}`);
        violations += 1;
      }
    }
  }
}

if (violations > 0) {
  console.error(
    `check-legacy-shim: FAIL — ${violations} violation(s) found across ${files.length} scanned files`
  );
  for (const line of details) console.error(line);
  console.error(
    '\nResolve by migrating to the new APIs (see analysis/iterative-repair/v2/ROUND-12-ci-docs.md).'
  );
  process.exit(1);
}

console.log(
  `check-legacy-shim: PASS — 0 violations across ${files.length} scanned files`
);
