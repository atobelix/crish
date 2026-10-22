const fs = require('fs');
const code = fs.readFileSync('apps/crish-desktop/dist/assets/chat-provider-catalog-DsrDPqqi.js', 'utf8');
const offset = 59773;
console.log('--- AROUND OFFSET ---');
console.log(code.substring(Math.max(0, offset - 300), Math.min(code.length, offset + 300)));
console.log('--- END ---');
