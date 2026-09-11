/**
 * scripts/check-no-pseudo-dispatch.mjs
 * §2.1 / §9: forbid empty dispatch* stubs and chat-injection paths.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SCAN_ROOTS = [
  path.join(ROOT, 'apps/crish-desktop/src'),
  path.join(ROOT, 'scripts'),
];
const FORBIDDEN_SYMBOLS = [
  'dispatchWorkflowAssistantCard',
  'dispatchSkillContextCard',
  'dispatchGoalModeCard',
  'dispatchGrillMeCard',
  'dispatchAttachmentCards',
];
const IGNORE_DIR = new Set(['node_modules', 'dist', 'coverage', '.git', 'target']);
const errors = [];

function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIR.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (/chat-injection/i.test(ent.name)) {
        errors.push(`[assert2] chat-injection dir: ${path.relative(ROOT, full)}`);
      }
      walk(full, out);
      continue;
    }
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(ent.name)) continue;
    out.push(full);
  }
}

function scanFile(file) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  if (/check-no-pseudo-dispatch\.mjs$/.test(rel)) return;
  if (/chat-injection/i.test(rel)) {
    errors.push(`[assert2] chat-injection path: ${rel}`);
  }
  const text = fs.readFileSync(file, 'utf8');
  for (const sym of FORBIDDEN_SYMBOLS) {
    if (text.includes(sym)) {
      errors.push(`[assert1] forbidden stub symbol ${sym}: ${rel}`);
    }
  }
  const stubRe =
    /export\s+function\s+(dispatch\w*Card)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*(?:\/\/[^\n]*\s*)*return\s+(?:''|""|null)\s*;?\s*\}/gms;
  let m;
  while ((m = stubRe.exec(text)) !== null) {
    errors.push(`[assert3] empty dispatch stub ${m[1]}: ${rel}`);
  }
}

const files = [];
for (const root of SCAN_ROOTS) walk(root, files);
for (const f of files) scanFile(f);

// ---- §4.1 / §4.2 gates（§4.3 已正式挂 check:blocked-executable-ssot，不再双扫）----
(function checkSec4Gates() {
  const hostBridge = path.join(ROOT, 'apps/crish-desktop/src/components/workspace/previewHostBridge.ts');
  const bridgeScript = path.join(ROOT, 'apps/crish-desktop/dev-server/previewBridgeScript.ts');
  const sameOrigin = path.join(ROOT, 'apps/crish-desktop/dev-server/sameOriginRequest.ts');
  const indexHtml = path.join(ROOT, 'apps/crish-desktop/index.html');

  for (const f of [hostBridge, bridgeScript, sameOrigin, indexHtml]) {
    if (!fs.existsSync(f)) {
      errors.push(`[§4] missing file: ${path.relative(ROOT, f).replace(/\\/g, '/')}`);
    }
  }
  if (errors.some((e) => String(e).startsWith('[§4] missing'))) return;

  const hb = fs.readFileSync(hostBridge, 'utf8');
  if (!hb.includes('isAllowedPreviewMessageOrigin')) {
    errors.push('[§4.1] previewHostBridge missing origin whitelist check');
  }
  if (/postMessage\([^\n]*,\s*'\*'\s*\)/.test(hb)) {
    errors.push("[§4.1] previewHostBridge still postMessage(..., '*')");
  }

  const bs = fs.readFileSync(bridgeScript, 'utf8');
  if (!bs.includes('TARGET_ORIGIN')) {
    errors.push('[§4.1] previewBridgeScript missing TARGET_ORIGIN');
  }
  const runtime = bs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  if (/postMessage\([^)]*,\s*'\*'\s*\)/.test(runtime)) {
    errors.push("[§4.1] previewBridgeScript runtime still postMessage(..., '*')");
  }

  const so = fs.readFileSync(sameOrigin, 'utf8');
  if (/if\s*\(!origin\)\s*return\s*true/.test(so)) {
    errors.push('[§4.1] sameOriginRequest still allows missing Origin alone');
  }
  if (!so.includes('sec-fetch-site') || !so.includes('referer')) {
    errors.push('[§4.1] sameOriginRequest must require Sec-Fetch-Site or Referer when Origin absent');
  }

  const html = fs.readFileSync(indexHtml, 'utf8');
  const dragCount = (html.match(/data-tauri-drag-region/g) || []).length;
  if (dragCount !== 1) {
    errors.push(`[§4.2] index.html expected exactly 1 data-tauri-drag-region on skeleton, found ${dragCount}`);
  }
  if (/<svg[^>]*data-tauri-drag-region/.test(html)) {
    errors.push('[§4.2] skeleton SVG must not carry data-tauri-drag-region');
  }
})();

if (errors.length) {
  console.error(`\nFAIL pseudo-dispatch gate (${errors.length}):`);
  for (const [i, e] of errors.entries()) console.error(`  ${i + 1}. ${e}`);
  process.exit(1);
}

console.log('PASS pseudo-dispatch / chat-injection + sec4.1/4.2 gates');
