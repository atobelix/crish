const fs = require('fs');
const path = require('path');

// 递归收集一个文件的所有本地 import
function getImports(filePath, visited = new Set()) {
  if (visited.has(filePath) || !fs.existsSync(filePath)) return visited;
  visited.add(filePath);

  const content = fs.readFileSync(filePath, 'utf8');
  const importRe = /from\s+['"]([^'"]+)['"]/g;
  let match;
  while ((match = importRe.exec(content))) {
    let importPath = match[1];
    if (importPath.startsWith('.')) {
      let resolved = path.resolve(path.dirname(filePath), importPath);
      if (!fs.existsSync(resolved)) {
        if (fs.existsSync(resolved + '.ts')) resolved += '.ts';
        else if (fs.existsSync(resolved + '.tsx')) resolved += '.tsx';
        else if (fs.existsSync(resolved + '/index.ts')) resolved += '/index.ts';
      }
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        getImports(resolved, visited);
      }
    }
  }
  return visited;
}

// 收集 catalog 的所有依赖模块
const catalogEntry = path.resolve('apps/crish-desktop/src/api/modelCatalog.ts');
const catalogProfiles = path.resolve('apps/crish-desktop/src/api/providerProfiles.ts');
const catalogDeps = new Set([...getImports(catalogEntry), ...getImports(catalogProfiles)]);

// 收集 runtime 的所有依赖模块
const runtimeEntry = path.resolve('apps/crish-desktop/src/api/chatBridge.ts');
const runtimeDeps = getImports(runtimeEntry);

console.log('Catalog total recursive deps:', catalogDeps.size);
console.log('Runtime total recursive deps:', runtimeDeps.size);

// 求交集
const shared = [];
for (const dep of catalogDeps) {
  if (runtimeDeps.has(dep)) {
    const rel = path.relative(path.resolve('apps/crish-desktop'), dep).replace(/\\/g, '/');
    shared.push(rel);
  }
}

console.log('\n=== SHARED INTERMEDIATE MODULES ===');
shared.forEach(s => console.log(' ', s));
