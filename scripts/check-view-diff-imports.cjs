const fs = require('fs');
const dir = 'apps/crish-desktop/dist/assets';
const idxFile = fs.readdirSync(dir).find(f => f.startsWith('index-'));
const diffFile = fs.readdirSync(dir).find(f => f.startsWith('view-diff-') && f.endsWith('.js'));
const code = fs.readFileSync(dir + '/' + idxFile, 'utf8');

const regex = new RegExp('import\\{([^}]+)\\}from[ ]*["\']\\./' + diffFile + '["\']');
const m = code.match(regex);
if (m) {
  const imports = m[1].split(',').map(s => s.trim());
  console.log('Number of imports from view-diff:', imports.length);
  console.log('Sample imports:', imports.slice(0, 10));
} else {
  console.log('No regex match for import from', diffFile);
}
