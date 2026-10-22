const fs = require('fs');
const path = require('path');

const dir = 'apps/crish-desktop/dist/assets';
const indexFile = fs.readdirSync(dir).find(f => f.startsWith('index-') && f.endsWith('.js'));
const diffFile = fs.readdirSync(dir).find(f => f.startsWith('view-diff-') && f.endsWith('.js'));

const indexCode = fs.readFileSync(path.join(dir, indexFile), 'utf8');
const lines = indexCode.split('\n');

for (const line of lines.slice(0, 10)) {
  if (line.includes(diffFile)) {
    console.log('Line importing diffFile:', line);
  }
}
