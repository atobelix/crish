const fs = require('fs');
const path = require('path');

const dir = path.resolve('apps/crish-desktop/dist/assets');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
console.log('Total js files in dist:', files.length);

let foundBare = 0;
for (const f of files) {
  const content = fs.readFileSync(path.join(dir, f), 'utf8');
  // 查找静态 import "..." 或 from "..." 且路径不是 . 或 / 开头
  const matches = content.match(/\b(?:from|import)\s*["'](?![./])[^"']+["']/g);
  if (matches) {
    console.log('Bare import in', f, matches);
    foundBare++;
  }
}
if (foundBare === 0) {
  console.log('No bare imports found in dist/assets!');
}
