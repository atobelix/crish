const fs = require('fs');
const path = require('path');

const dir = 'apps/crish-desktop/dist/assets';
const storeFile = fs.readdirSync(dir).find(f => f.startsWith('app-store-') && f.endsWith('.js'));
const code = fs.readFileSync(path.join(dir, storeFile), 'utf8');

console.log('Store file size:', (code.length / 1024).toFixed(1), 'KB');

// Find all matches for paths or module-like strings
const matches = code.match(/["'][a-zA-Z0-9_\-\.\/]+["']/g) || [];
const unique = Array.from(new Set(matches)).filter(s => s.length > 5 && s.length < 50);
console.log('Sample strings in app-store:', unique.slice(0, 30));
