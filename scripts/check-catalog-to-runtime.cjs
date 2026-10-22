const fs = require('fs');
const path = require('path');

const allFiles = [];
function walk(dir) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, f.name);
    if (f.isDirectory()) {
      if (f.name !== 'node_modules' && f.name !== '.git') walk(full);
    } else if (f.name.endsWith('.ts') || f.name.endsWith('.tsx') || f.name.endsWith('.json')) {
      allFiles.push(full.replace(/\\/g, '/'));
    }
  }
}
walk('apps/crish-desktop/src');

const catalogFiles = allFiles.filter(n =>
  n.includes('/src/api/providerProfiles') ||
  n.includes('/src/api/provider-profiles') ||
  n.includes('/src/api/modelCatalog') ||
  n.includes('/src/api/modelCatalogTypes') ||
  n.includes('/src/api/modelCatalogPure') ||
  n.includes('/src/api/modelCatalogMeta') ||
  n.includes('/src/api/modelCatalogIpc') ||
  n.includes('catalog.json')
);

const externalImports = new Set();
for (const file of catalogFiles) {
  if (!fs.existsSync(file)) continue;
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  lines.forEach((l) => {
    const m = l.match(/from\s+['"]([^'"]+)['"]/);
    if (m) {
      const imp = m[1];
      if (imp.startsWith('.')) {
        const resolved = path.resolve(path.dirname(file), imp).replace(/\\/g, '/');
        // Check if resolved is in catalogFiles
        const inCatalog = catalogFiles.some(cf => resolved === cf || resolved === cf.replace(/\.tsx?$/, ''));
        if (!inCatalog) {
          externalImports.add(`${path.basename(file)} -> ${imp} (${resolved})`);
        }
      }
    }
  });
}

console.log('EXTERNAL IMPORTS FROM CATALOG:');
for (const imp of externalImports) {
  console.log(' ', imp);
}
