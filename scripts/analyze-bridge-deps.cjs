const fs = require('fs');
const path = require('path');

const bridgeDir = 'apps/crish-desktop/src/api/chat-bridge';
function walk(dir) {
  const files = fs.readdirSync(dir, { withFileTypes: true });
  for (const f of files) {
    const full = path.join(dir, f.name);
    if (f.isDirectory()) walk(full);
    else if (f.name.endsWith('.ts') || f.name.endsWith('.tsx')) {
      const c = fs.readFileSync(full, 'utf8');
      const matches = c.match(/from\s+['"][^'"]*store[^'"]*['"]/g);
      if (matches) {
        console.log(full, matches);
      }
    }
  }
}
walk(bridgeDir);
