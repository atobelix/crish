#!/usr/bin/env node
/**
 * scripts/check-npm-licenses.mjs
 * Automated NPM License Scanner (P1-LIC-01)
 *
 * Scans all non-dev / production dependencies in package-lock.json for license compatibility.
 * - Rejects any strong copyleft (GPL, AGPL, SSPL, EUPL, CC-BY-NC) in production dependencies.
 * - Allows dual-licensed packages electing a permissive license (e.g. node-forge electing BSD-3-Clause).
 * - Allows permissive licenses (MIT, Apache-2.0, BSD-2/3, ISC, OFL-1.1, MPL-2.0, BlueOak-1.0.0, 0BSD, CC0, etc.).
 * - Exits 0 on pass, 1 on violation with diagnostic details.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const lockfileArgIdx = process.argv.indexOf('--lockfile');
const LOCKFILE_PATH = lockfileArgIdx !== -1 && process.argv[lockfileArgIdx + 1]
  ? resolve(process.cwd(), process.argv[lockfileArgIdx + 1])
  : resolve(REPO_ROOT, 'package-lock.json');

const VERBOSE = process.argv.includes('--verbose');

if (process.argv.includes('--guide')) {
  console.log(`[check-npm-licenses] 正确做法指引：
  生产依赖必须符合开源许可证合规策略（允许 MIT/Apache-2.0/BSD/ISC 等宽松协议，禁止强 Copyleft 协议）。
  如引入了冲突依赖，请替换为合规替代包或确认其双重许可声明。`);
  process.exit(0);
}
if (process.argv.includes('--list')) {
  console.log('production-dependencies-license-compatibility');
  process.exit(0);
}

// Permissive licenses allowed for production dependencies
const PERMISSIVE_LICENSES = new Set([
  'MIT',
  'MIT-0',
  'Apache-2.0',
  'Apache-1.1',
  'Apache-2.0 WITH LLVM-exception',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSD-3-Clause-Clear',
  'BSD-4-Clause',
  'BSD',
  'ISC',
  'OFL-1.1',
  'MPL-2.0',
  'MPL-2.0+',
  'BlueOak-1.0.0',
  '0BSD',
  'CC0',
  'CC0-1.0',
  'Unlicense',
  'Python-2.0',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'Zlib',
  'WTFPL',
]);

// Strong copyleft patterns strictly prohibited in production dependencies
const STRONG_COPYLEFT_PATTERN = /\b(A?GPL(-\S*)?|SSPL(-\S*)?|EUPL(-\S*)?|CC-BY-NC(-\S*)?)\b/i;

function isStrongCopyleft(id) {
  return STRONG_COPYLEFT_PATTERN.test(id);
}

function isPermissive(id) {
  if (PERMISSIVE_LICENSES.has(id)) return true;
  if (/^Apache-2\.0\b/i.test(id)) return true;
  if (/^BSD-[23]-Clause\b/i.test(id)) return true;
  if (/^MIT\b/i.test(id)) return true;
  return false;
}

/**
 * Parses an SPDX license expression into an AST.
 */
function parseLicense(expr) {
  if (!expr || typeof expr !== 'string') return null;
  const str = expr.trim();
  const rawTokens = [];
  const regex = /(\(|\)|\bOR\b|\bAND\b|[^\s()]+)/g;
  let match;
  while ((match = regex.exec(str)) !== null) {
    rawTokens.push(match[0]);
  }
  let pos = 0;
  function peek() {
    return rawTokens[pos];
  }
  function consume() {
    return rawTokens[pos++];
  }

  function parseOr() {
    let left = parseAnd();
    while (peek() === 'OR') {
      consume();
      const right = parseAnd();
      left = { type: 'OR', left, right };
    }
    return left;
  }

  function parseAnd() {
    let left = parsePrimary();
    while (peek() === 'AND') {
      consume();
      const right = parsePrimary();
      left = { type: 'AND', left, right };
    }
    return left;
  }

  function parsePrimary() {
    const token = consume();
    if (!token) return null;
    if (token === '(') {
      const expr = parseOr();
      if (peek() === ')') consume();
      return expr;
    }
    if (peek() === 'WITH') {
      consume();
      const exc = consume();
      return { type: 'LICENSE', id: `${token} WITH ${exc}` };
    }
    return { type: 'LICENSE', id: token };
  }

  return parseOr();
}

/**
 * Evaluates an AST node for license policy compliance.
 * - Under OR: allows electing an approved permissive branch.
 * - Under AND: all branches must be permissive and copyleft-free.
 */
function evaluate(node) {
  if (!node) {
    return { ok: false, reason: 'Missing or unparseable license expression' };
  }

  if (node.type === 'LICENSE') {
    if (isStrongCopyleft(node.id)) {
      return { ok: false, reason: `Strong copyleft license: ${node.id}`, copyleft: true };
    }
    if (isPermissive(node.id)) {
      return { ok: true, elected: node.id };
    }
    return { ok: false, reason: `Unapproved license: ${node.id}` };
  }

  if (node.type === 'OR') {
    const leftRes = evaluate(node.left);
    const rightRes = evaluate(node.right);
    // If either branch satisfies our permissive policy, elect that branch
    if (leftRes.ok) return { ok: true, elected: leftRes.elected };
    if (rightRes.ok) return { ok: true, elected: rightRes.elected };
    return {
      ok: false,
      reason: `No acceptable branch in OR clause: (${leftRes.reason} OR ${rightRes.reason})`,
    };
  }

  if (node.type === 'AND') {
    const leftRes = evaluate(node.left);
    const rightRes = evaluate(node.right);
    if (!leftRes.ok) return { ok: false, reason: `AND clause failed on left: ${leftRes.reason}` };
    if (!rightRes.ok) return { ok: false, reason: `AND clause failed on right: ${rightRes.reason}` };
    return { ok: true, elected: `${leftRes.elected} AND ${rightRes.elected}` };
  }

  return { ok: false, reason: 'Unknown AST node type' };
}

function run() {
  if (!existsSync(LOCKFILE_PATH)) {
    console.error(`[check-npm-licenses] Error: package-lock.json not found at ${LOCKFILE_PATH}`);
    process.exit(1);
  }

  const lockContent = readFileSync(LOCKFILE_PATH, 'utf8');
  const lockfile = JSON.parse(lockContent);

  if (!lockfile.packages) {
    console.error('[check-npm-licenses] Error: package-lock.json missing "packages" map (npm v2+ required)');
    process.exit(1);
  }

  const scanned = [];
  const violations = [];
  const dualElections = [];
  const licenseBreakdown = new Map();

  for (const [pkgPath, pkg] of Object.entries(lockfile.packages)) {
    // 1. Skip root entry
    if (pkgPath === '') continue;

    // 2. Skip workspace symlinks (already scanned under workspace root path)
    if (pkg.link) continue;

    // 3. Skip development dependencies (dev: true or devOptional: true)
    if (pkg.dev || pkg.devOptional) continue;

    const name = pkg.name || pkgPath.replace(/^.*node_modules\//, '');
    const version = pkg.version || 'unknown';

    // 4. Resolve declared license
    let licenseExpr = pkg.license;
    if (!licenseExpr && pkg.licenses && Array.isArray(pkg.licenses)) {
      licenseExpr = `(${pkg.licenses.map((l) => (typeof l === 'string' ? l : l.type)).join(' OR ')})`;
    } else if (typeof licenseExpr === 'object' && licenseExpr !== null && licenseExpr.type) {
      licenseExpr = licenseExpr.type;
    }

    if (!licenseExpr) {
      violations.push({
        name,
        version,
        path: pkgPath,
        license: 'NONE',
        reason: 'Missing license declaration in production dependency',
      });
      continue;
    }

    const ast = parseLicense(licenseExpr);
    const result = evaluate(ast);

    if (!result.ok) {
      violations.push({
        name,
        version,
        path: pkgPath,
        license: licenseExpr,
        reason: result.reason,
      });
    } else {
      scanned.push({
        name,
        version,
        path: pkgPath,
        declared: licenseExpr,
        elected: result.elected,
      });

      const count = licenseBreakdown.get(result.elected) || 0;
      licenseBreakdown.set(result.elected, count + 1);

      if (licenseExpr !== result.elected) {
        dualElections.push({
          name,
          version,
          declared: licenseExpr,
          elected: result.elected,
        });
      }
    }
  }

  console.log('='.repeat(70));
  console.log('NPM Production Dependency License Scanner (P1-LIC-01)');
  console.log('='.repeat(70));
  console.log(`Total production packages scanned: ${scanned.length + violations.length}`);

  if (VERBOSE) {
    console.log('\n--- Scanned Packages ---');
    for (const p of scanned) {
      console.log(`  ${p.name}@${p.version} [declared: ${p.declared}] -> elected: ${p.elected}`);
    }
  }

  if (dualElections.length > 0) {
    console.log('\nDual-licensed packages with permissive elections:');
    for (const d of dualElections) {
      console.log(`  • ${d.name}@${d.version}: declared "${d.declared}" -> elected "${d.elected}"`);
    }
  }

  console.log('\nElected license distribution:');
  const sortedBreakdown = Array.from(licenseBreakdown.entries()).sort((a, b) => b[1] - a[1]);
  for (const [lic, count] of sortedBreakdown) {
    console.log(`  • ${lic.padEnd(25)} : ${count}`);
  }

  if (violations.length > 0) {
    console.error('\n' + '!'.repeat(70));
    console.error(`LICENSE POLICY VIOLATIONS DETECTED (${violations.length} packages):`);
    console.error('!'.repeat(70));
    for (const v of violations) {
      console.error(`  ✕ Package : ${v.name}@${v.version}`);
      console.error(`    Path    : ${v.path}`);
      console.error(`    License : ${v.license}`);
      console.error(`    Reason  : ${v.reason}\n`);
    }
    console.error('Action required: Replace incompatible dependencies or obtain permissive licensing.');
    process.exit(1);
  }

  console.log('\n✓ All production dependencies satisfy license compatibility policy (0 violations).');
  console.log('='.repeat(70));
  process.exit(0);
}

// Only auto-run if invoked directly
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  run();
}

export { parseLicense, evaluate, isStrongCopyleft, isPermissive, run };
