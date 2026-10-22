const fs = require('fs');

const s = fs.readFileSync('C:/Users/orange/.gemini/antigravity/brain/54540d08-6294-475e-9734-6c89f324f5ba/.system_generated/steps/1540/output.txt', 'utf8');
const idx = s.indexOf('TOP 20 MODULES');
if (idx !== -1) {
  const chunk = s.slice(idx, idx + 4000);
  console.log(chunk);
}
