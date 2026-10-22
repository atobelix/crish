const fs = require('fs');
const code = fs.readFileSync('apps/crish-desktop/dist/assets/chat-runtime-core-mYTBAhv1.js', 'utf8');
const offset = 88439;
console.log('--- AROUND OFFSET 88439 ---');
console.log(code.substring(Math.max(0, offset - 300), Math.min(code.length, offset + 300)));
console.log('--- END ---');
