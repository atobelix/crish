const fs = require('fs');
const log = fs.readFileSync('C:\\Users\\orange\\.gemini\\antigravity\\brain\\54540d08-6294-475e-9734-6c89f324f5ba\\.system_generated\\tasks\\task-1365.log', 'utf8');
const lines = log.split('\n');
const idx = lines.findIndex(l => l.includes('Module distribution'));
if (idx !== -1) {
  console.log(lines.slice(idx, idx + 40).join('\n'));
}
