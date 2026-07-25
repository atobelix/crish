import fs from 'fs';
import path from 'path';

const files = JSON.parse(fs.readFileSync('scripts/component-files-list.json', 'utf8'));

const eventRegex = /on(Click|MouseDown|PointerDown|KeyDown|ContextMenu|MouseOver|MouseEnter|MouseLeave|DoubleClick|Change|Submit|Focus|Blur)\s*=\s*/g;
const classNameRegex = /className\s*=\s*(?:{([^}]+)}|"([^"]+)"|'([^']+)')/g;
const dataAttrRegex = /data-[\w-]+(?:\s*=\s*(?:{([^}]+)}|"([^"]+)"|'([^']+)'))?/g;
const ariaRegex = /aria-[\w-]+(?:\s*=\s*(?:{([^}]+)}|"([^"]+)"|'([^']+)'))?/g;
const titleRegex = /title\s*=\s*(?:{([^}]+)}|"([^"]+)"|'([^']+)')/g;

const results = [];

for (const filePath of files) {
  const code = fs.readFileSync(filePath, 'utf8');
  const fileEvents = [];
  let match;

  // Find line numbers for event handlers
  const lines = code.split('\n');
  lines.forEach((line, idx) => {
    let evMatch;
    const lineEvReg = /on(Click|MouseDown|PointerDown|KeyDown|ContextMenu|MouseOver|MouseEnter|MouseLeave|DoubleClick|Change|Submit|Focus|Blur)\s*=\s*/g;
    while ((evMatch = lineEvReg.exec(line)) !== null) {
      fileEvents.push({
        event: 'on' + evMatch[1],
        lineNum: idx + 1,
        snippet: line.trim()
      });
    }
  });

  results.push({
    file: filePath,
    eventsCount: fileEvents.length,
    events: fileEvents
  });
}

console.log(`Analyzed ${results.length} files.`);
const totalEvents = results.reduce((sum, r) => sum + r.eventsCount, 0);
console.log(`Total event handlers found: ${totalEvents}`);

fs.writeFileSync('scripts/parsed-events-summary.json', JSON.stringify(results, null, 2));
