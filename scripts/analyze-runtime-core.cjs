const fs = require('fs');
const path = require('path');

const manifestPath = 'apps/crish-desktop/dist/.vite/manifest.json';
if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.log('Manifest keys:', Object.keys(manifest).length);
  for (const [k, v] of Object.entries(manifest)) {
    if (v.file && v.file.includes('chat-runtime-core')) {
      console.log('chat-runtime-core entry:', k, v);
    }
  }
}

// 检查 dist/assets 下最大的 chunk
const dir = 'apps/crish-desktop/dist/assets';
const files = fs.readdirSync(dir);
for (const f of files) {
  const stat = fs.statSync(path.join(dir, f));
  if (stat.size > 200 * 1024) {
    console.log(f, (stat.size / 1024).toFixed(2), 'kB');
  }
}
