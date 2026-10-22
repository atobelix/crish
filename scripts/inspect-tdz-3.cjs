const fs = require('fs');
const lines = fs.readFileSync('apps/crish-desktop/dist/assets/chat-runtime-core-mYTBAhv1.js', 'utf8').split('\n');
const line = lines[66]; // line 67 (0-indexed 66)
const col = 88439;
console.log('Line 67 length:', line?.length);
console.log('Code around col:', line?.substring(Math.max(0, col - 200), Math.min(line?.length, col + 200)));
