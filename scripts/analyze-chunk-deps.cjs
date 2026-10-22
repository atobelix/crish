const fs = require('fs');
const path = require('path');

// 读取 chat-provider-catalog 包含的所有源码文件中的 import
const catalogFiles = [
  'apps/crish-desktop/src/api/providerProfiles.ts',
  'apps/crish-desktop/src/api/provider-profiles/index.ts',
  'apps/crish-desktop/src/api/modelCatalog.ts',
  'apps/crish-desktop/src/api/modelCatalogTypes.ts',
  'apps/crish-desktop/src/api/modelCatalogPure.ts',
  'apps/crish-desktop/src/api/modelCatalogMeta.ts',
  'apps/crish-desktop/src/api/modelCatalogIpc.ts',
];

for (const file of catalogFiles) {
  if (!fs.existsSync(file)) continue;
  const content = fs.readFileSync(file, 'utf8');
  const imports = content.match(/from\s+['"][^'"]+['"]/g) || [];
  console.log(`\n=== ${file} ===`);
  for (const imp of imports) {
    if (imp.includes('chat-bridge') || imp.includes('chatBridge') || imp.includes('lifecycle')) {
      console.log('  ', imp);
    }
  }
}
