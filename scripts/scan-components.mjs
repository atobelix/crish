import fs from 'fs';
import path from 'path';

function getFiles(dir, files = []) {
  const fileList = fs.readdirSync(dir);
  for (const file of fileList) {
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isDirectory()) {
      getFiles(filePath, files);
    } else if (file.endsWith('.tsx') || file.endsWith('.jsx')) {
      if (!file.endsWith('.test.tsx') && !file.endsWith('.test.ts')) {
        files.push(filePath);
      }
    }
  }
  return files;
}

const allFiles = getFiles('apps/crish-desktop/src/components');
console.log('Total component TSX/JSX files:', allFiles.length);
fs.writeFileSync('scripts/component-files-list.json', JSON.stringify(allFiles, null, 2));
