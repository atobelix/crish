const fs = require('fs');
const path = require('path');

const manifestPath = 'apps/crish-desktop/dist/.vite/manifest.json';
if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const [k, v] of Object.entries(manifest)) {
    if (v.file && v.file.includes('chat-runtime-core')) {
      console.log('Manifest key for chat-runtime-core:', k);
      console.log('Imports:', v.imports);
      console.log('Dynamic imports:', v.dynamicImports);
    }
  }
}
