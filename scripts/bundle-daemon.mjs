import { copyFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const resourcesDir = resolve(root, 'apps/agent-workbench/src-tauri/resources');
const outputDir = resolve(root, 'dist/daemon-binaries');

if (!existsSync(resourcesDir)) {
  mkdirSync(resourcesDir, { recursive: true });
}
if (!existsSync(outputDir)) {
  mkdirSync(outputDir, { recursive: true });
}

const daemonBundle = resolve(root, 'packages/agent-daemon/dist/index.js');
if (!existsSync(daemonBundle)) {
  console.log('[bundle-daemon] Daemon dist not found; run "npm run build:daemon" first');
  process.exit(1);
}

// Copy to resources (Tauri sidecar)
copyFileSync(daemonBundle, resolve(resourcesDir, 'crish-agent-daemon.bundle.js'));
console.log('[bundle-daemon] Copied -> resources/crish-agent-daemon.bundle.js');

// Platform targets for published binaries
const platforms = [
  { name: 'win32-x64', node: 'win-x64', arch: 'x64', platform: 'win32' },
  { name: 'linux-x64', node: 'linux-x64', arch: 'x64', platform: 'linux' },
  { name: 'darwin-x64', node: 'darwin-x64', arch: 'x64', platform: 'darwin' },
  { name: 'darwin-arm64', node: 'darwin-arm64', arch: 'arm64', platform: 'darwin' },
];

// Bundle using esbuild for each platform (inline deps for self-contained artifact)
for (const plat of platforms) {
  const outfile = resolve(outputDir, `crish-daemon-${plat.name}.js`);
  try {
    execSync(
      `npx esbuild packages/agent-daemon/src/index.ts --bundle --platform=node --format=esm ` +
      `--target=es2022 --outfile="${outfile}" --external:"${plat.platform === 'win32' ? '' : 'fsevents'}" ` +
      `--external:ws --sourcemap`,
      { cwd: root, stdio: 'pipe', encoding: 'utf-8', timeout: 120000 }
    );
    console.log(`[bundle-daemon] Built -> ${outfile}`);
  } catch (e) {
    console.error(`[bundle-daemon] esbuild failed for ${plat.name}: ${e.stderr || e.message}`);
  }
}

// Generate SHA256SUMS
const shasumFile = resolve(outputDir, 'SHA256SUMS');
const lines = [];
for (const entry of readdirSync(outputDir)) {
  const fp = resolve(outputDir, entry);
  if (!statSync(fp).isFile() || entry === 'SHA256SUMS') continue;
  const hash = createHash('sha256').update(readFileSync(fp)).digest('hex');
  lines.push(`${hash}  ${entry}`);
}
writeFileSync(shasumFile, lines.join('\n') + '\n');
console.log('[bundle-daemon] SHA256SUMS generated');
console.log(`[bundle-daemon] Output: ${outputDir}`);
