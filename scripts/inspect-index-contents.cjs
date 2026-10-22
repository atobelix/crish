const fs = require('fs');
const path = require('path');

const dir = 'apps/crish-desktop/dist/assets';
const indexFile = fs.readdirSync(dir).find(f => f.startsWith('index-') && f.endsWith('.js'));
const code = fs.readFileSync(path.join(dir, indexFile), 'utf8');

// Look for comments, paths, or identifiers indicating module sources
const lines = code.split('\n');
console.log('Total lines:', lines.length, 'Size:', (code.length / 1024).toFixed(1), 'KB');

// Let's inspect packages/ or src/ imports or distinctive identifiers
const keywords = [
  '@radix-ui',
  'lucide',
  'motion',
  '@tauri-apps',
  'qrcode',
  'zod',
  'packages/block-paper',
  'packages/conversation-flow',
  'packages/editor-kit',
  'src/components',
  'src/store',
  'src/api'
];

for (const kw of keywords) {
  let count = 0;
  let pos = 0;
  while ((pos = code.indexOf(kw, pos)) !== -1) {
    count++;
    pos += kw.length;
  }
  console.log(kw + ':', count);
}
