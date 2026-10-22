const fs = require('fs');
const path = require('path');

const storeDir = 'apps/crish-desktop/src/store';
function walk(dir) {
  const files = fs.readdirSync(dir, { withFileTypes: true });
  for (const f of files) {
    const full = path.join(dir, f.name);
    if (f.isDirectory()) walk(full);
    else if (f.name.endsWith('.ts') || f.name.endsWith('.tsx')) {
      const c = fs.readFileSync(full, 'utf8');
      const matches = c.match(/from\s+['"][^'"]*(?:chat-bridge|chatBridge|StreamRenderBuffer|StreamRecovery)[^'"]*['"]/g);
      if (matches) {
        console.log(full, matches);
      }
    }
  }
}
walk(storeDir);
