const fs = require('fs');
const path = require('path');

const dir = 'apps/crish-desktop/dist/assets';
const diffFile = fs.readdirSync(dir).find(f => f.startsWith('view-diff-') && f.endsWith('.js'));
const code = fs.readFileSync(path.join(dir, diffFile), 'utf8');

// Look for comments, export names, or known identifiers
const keywords = [
  'DiffCard',
  'VirtualPlainCodeViewer',
  'LineBuffer',
  'VirtualCodeEngine',
  'GitPatchFormatter',
  'DiffHeaderControls',
  'AppErrorBoundary',
  'LayerStackManager',
  'ScrollArea',
  'Tooltip'
];

for (const kw of keywords) {
  console.log(kw + ':', code.includes(kw));
}

// Find any strings resembling module paths or names
const matches = code.match(/["'][a-zA-Z0-9_\-\.\/]+["']/g) || [];
const unique = Array.from(new Set(matches)).filter(s => s.length > 5 && s.length < 50);
console.log('Sample strings in view-diff:', unique.slice(0, 30));
