const fs = require('fs');
const path = require('path');

// 扫描所有在 chat-runtime-core 里的文件，看谁直接引用了 components/
const targets = [];
function findFiles(dir) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, f.name);
    if (f.isDirectory()) findFiles(full);
    else if (f.name.endsWith('.ts') || f.name.endsWith('.tsx')) {
      if (!f.name.includes('.test.')) {
        targets.push(full);
      }
    }
  }
}
findFiles('apps/crish-desktop/src/api/chat-bridge');
targets.push('apps/crish-desktop/src/api/chatBridge.ts');
targets.push('apps/crish-desktop/src/api/StreamRenderBuffer.ts');
targets.push('apps/crish-desktop/src/services/StreamRecovery.ts');

for (const t of targets) {
  if (!fs.existsSync(t)) continue;
  const c = fs.readFileSync(t, 'utf8');
  const lines = c.split('\n');
  lines.forEach((l, idx) => {
    if (l.includes('from') && (l.includes('components') || l.includes('store') || l.includes('prompts'))) {
      console.log(`${path.basename(t)}:${idx + 1}: ${l.trim()}`);
    }
  });
}
