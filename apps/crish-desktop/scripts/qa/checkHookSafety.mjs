import fs from 'fs';
import path from 'path';
import url from 'url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const componentsDir = path.resolve(__dirname, '../../src/components');

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(function(file) {
    file = path.join(dir, file);
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) { 
      results = results.concat(walk(file));
    } else if (file.endsWith('.tsx')) {
      results.push(file);
    }
  });
  return results;
}

const files = walk(componentsDir);
let hasError = false;

for (const file of files) {
  const content = fs.readFileSync(file, 'utf-8');
  const lines = content.split('\n');
  
  let conditionalReturnLine = -1;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Only detect component top-level early returns (e.g. if (cond) return null; at 2 spaces)
    const condMatch = line.match(/^ {2}if\s*\(.*?\)\s*(?:return|\{\s*return)/);
    if (condMatch) {
      conditionalReturnLine = i + 1;
      continue;
    }
    
    if (conditionalReturnLine !== -1) {
      const hookMatch = line.match(/^ {2}(?:const|let|var)\s+.*?=\s*(useRef|useCallback|useState|useEffect|useMemo)\b/);
      if (hookMatch) {
        console.error(`Error: Found React Hook '${hookMatch[1]}' at line ${i + 1} after top-level early return at line ${conditionalReturnLine} in ${file}`);
        hasError = true;
        conditionalReturnLine = -1;
      }
      
      // Component function end
      if (line.match(/^(\}\)?;?|\}\);?|export default|export const)/)) {
        conditionalReturnLine = -1;
      }
    }
  }
}

if (hasError) {
  process.exit(1);
} else {
  console.log("Hook safety check passed. All top-level hooks are safely positioned.");
}
