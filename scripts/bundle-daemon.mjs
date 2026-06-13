import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const resourcesDir = resolve(root, 'apps/agent-workbench/src-tauri/resources');

if (!existsSync(resourcesDir)) {
  mkdirSync(resourcesDir, { recursive: true });
}

const daemonBundle = resolve(root, 'packages/agent-daemon/dist/index.js');

if (!existsSync(daemonBundle)) {
  console.log('[bundle-daemon] Daemon dist not found; run "npm run build:daemon" first');
  process.exit(1);
}

copyFileSync(daemonBundle, resolve(resourcesDir, 'crish-agent-daemon.bundle.js'));
console.log('[bundle-daemon] Copied -> resources/crish-agent-daemon.bundle.js');
console.log('[bundle-daemon] For standalone .exe, use: pkg packages/agent-daemon/dist/index.js --targets node18-win-x64 --output apps/agent-workbench/src-tauri/resources/crish-agent-daemon.exe');
