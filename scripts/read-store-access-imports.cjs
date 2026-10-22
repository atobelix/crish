const fs = require('fs');
const c = fs.readFileSync('apps/crish-desktop/src/api/storeAccess.ts', 'utf8');
const lines = c.split('\n');
lines.forEach((l, idx) => {
  if (l.includes('from')) console.log(`${idx + 1}: ${l.trim()}`);
});
