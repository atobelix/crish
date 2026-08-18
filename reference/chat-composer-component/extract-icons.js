const fs = require('fs');
const path = require('path');

const targetDir = path.join(__dirname, 'assets', 'icons');
if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

const vscodeIconsDir = path.join(__dirname, 'tmp-vscode-icons', 'icons');
const materialIconsDir = path.join(__dirname, 'tmp-material-icons', 'icons');

// Comprehensive High-Frequency 160+ Extension Map across AI, Mobile, Web, System, CAD & Data
const extensionToIconMap = {
  // 1. Office & Documents
  'doc': { repo: 'vscode', file: 'file_type_word.svg' },
  'docx': { repo: 'vscode', file: 'file_type_word.svg' },
  'dot': { repo: 'vscode', file: 'file_type_word.svg' },
  'dotx': { repo: 'vscode', file: 'file_type_word.svg' },
  'xls': { repo: 'vscode', file: 'file_type_excel.svg' },
  'xlsx': { repo: 'vscode', file: 'file_type_excel.svg' },
  'csv': { repo: 'vscode', file: 'file_type_excel.svg' },
  'tsv': { repo: 'vscode', file: 'file_type_excel.svg' },
  'xlsm': { repo: 'vscode', file: 'file_type_excel.svg' },
  'ppt': { repo: 'custom_ppt' },
  'pptx': { repo: 'custom_ppt' },
  'pot': { repo: 'custom_ppt' },
  'pps': { repo: 'custom_ppt' },
  'pdf': { repo: 'vscode', file: 'file_type_pdf.svg' },
  'txt': { repo: 'material', file: 'document.svg' },
  'rtf': { repo: 'material', file: 'document.svg' },
  'log': { repo: 'material', file: 'log.svg' },

  // 2. AI & Data Science / ML (AI与数据科学)
  'ipynb': { repo: 'material', file: 'jupyter.svg' },
  'onnx': { repo: 'material', file: 'tune.svg' },
  'pt': { repo: 'material', file: 'python.svg' },
  'pth': { repo: 'material', file: 'python.svg' },
  'safetensors': { repo: 'material', file: 'tune.svg' },
  'h5': { repo: 'material', file: 'database.svg' },
  'hdf5': { repo: 'material', file: 'database.svg' },
  'parquet': { repo: 'material', file: 'database.svg' },
  'feather': { repo: 'material', file: 'database.svg' },

  // 3. Web & Frontend (Web与前端)
  'html': { repo: 'material', file: 'html.svg' },
  'htm': { repo: 'material', file: 'html.svg' },
  'xhtml': { repo: 'material', file: 'html.svg' },
  'css': { repo: 'material', file: 'css.svg' },
  'scss': { repo: 'material', file: 'sass.svg' },
  'sass': { repo: 'material', file: 'sass.svg' },
  'less': { repo: 'material', file: 'less.svg' },
  'styl': { repo: 'material', file: 'stylus.svg' },
  'js': { repo: 'material', file: 'javascript.svg' },
  'mjs': { repo: 'material', file: 'javascript.svg' },
  'cjs': { repo: 'material', file: 'javascript.svg' },
  'jsx': { repo: 'material', file: 'react.svg' },
  'ts': { repo: 'material', file: 'typescript.svg' },
  'mts': { repo: 'material', file: 'typescript.svg' },
  'cts': { repo: 'material', file: 'typescript.svg' },
  'tsx': { repo: 'material', file: 'react_ts.svg' },
  'vue': { repo: 'material', file: 'vue.svg' },
  'svelte': { repo: 'material', file: 'svelte.svg' },
  'astro': { repo: 'material', file: 'astro.svg' },
  'wasm': { repo: 'material', file: 'webassembly.svg' },

  // 4. Backend & Programming Languages (后端与语言)
  'py': { repo: 'material', file: 'python.svg' },
  'pyc': { repo: 'material', file: 'python.svg' },
  'pyd': { repo: 'material', file: 'python.svg' },
  'pyw': { repo: 'material', file: 'python.svg' },
  'java': { repo: 'material', file: 'java.svg' },
  'class': { repo: 'material', file: 'java.svg' },
  'jar': { repo: 'material', file: 'java.svg' },
  'c': { repo: 'material', file: 'c.svg' },
  'h': { repo: 'material', file: 'c.svg' },
  'cpp': { repo: 'material', file: 'cpp.svg' },
  'hpp': { repo: 'material', file: 'cpp.svg' },
  'cc': { repo: 'material', file: 'cpp.svg' },
  'cxx': { repo: 'material', file: 'cpp.svg' },
  'cs': { repo: 'material', file: 'csharp.svg' },
  'csx': { repo: 'material', file: 'csharp.svg' },
  'go': { repo: 'material', file: 'go.svg' },
  'rs': { repo: 'material', file: 'rust.svg' },
  'php': { repo: 'material', file: 'php.svg' },
  'rb': { repo: 'material', file: 'ruby.svg' },
  'swift': { repo: 'material', file: 'swift.svg' },
  'kt': { repo: 'material', file: 'kotlin.svg' },
  'kts': { repo: 'material', file: 'kotlin.svg' },
  'scala': { repo: 'material', file: 'scala.svg' },
  'dart': { repo: 'material', file: 'dart.svg' },
  'ex': { repo: 'material', file: 'elixir.svg' },
  'exs': { repo: 'material', file: 'elixir.svg' },
  'erl': { repo: 'material', file: 'erlang.svg' },
  'hs': { repo: 'material', file: 'haskell.svg' },
  'lua': { repo: 'material', file: 'lua.svg' },
  'pl': { repo: 'material', file: 'perl.svg' },
  'pm': { repo: 'material', file: 'perl.svg' },
  'r': { repo: 'material', file: 'r.svg' },
  'm': { repo: 'material', file: 'matlab.svg' },
  'zig': { repo: 'material', file: 'zig.svg' },
  'nim': { repo: 'material', file: 'nim.svg' },
  'elm': { repo: 'material', file: 'elm.svg' },
  'clj': { repo: 'material', file: 'clojure.svg' },

  // 5. Configuration & Data (配置与数据)
  'json': { repo: 'material', file: 'json.svg' },
  'json5': { repo: 'material', file: 'json.svg' },
  'jsonc': { repo: 'material', file: 'json.svg' },
  'yaml': { repo: 'material', file: 'yaml.svg' },
  'yml': { repo: 'material', file: 'yaml.svg' },
  'xml': { repo: 'material', file: 'xml.svg' },
  'toml': { repo: 'material', file: 'settings.svg' },
  'env': { repo: 'material', file: 'tune.svg' },
  'ini': { repo: 'material', file: 'settings.svg' },
  'conf': { repo: 'material', file: 'settings.svg' },
  'config': { repo: 'material', file: 'settings.svg' },
  'properties': { repo: 'material', file: 'settings.svg' },
  'prisma': { repo: 'material', file: 'prisma.svg' },
  'proto': { repo: 'material', file: 'protobuf.svg' },
  'graphql': { repo: 'material', file: 'graphql.svg' },
  'gql': { repo: 'material', file: 'graphql.svg' },
  'lock': { repo: 'material', file: 'lock.svg' },
  'editorconfig': { repo: 'material', file: 'editorconfig.svg' },
  'gitignore': { repo: 'material', file: 'git.svg' },
  'dockerignore': { repo: 'material', file: 'docker.svg' },

  // 6. Security, Certs & Keys (安全与证书密钥)
  'pem': { repo: 'material', file: 'certificate.svg' },
  'crt': { repo: 'material', file: 'certificate.svg' },
  'cer': { repo: 'material', file: 'certificate.svg' },
  'key': { repo: 'material', file: 'key.svg' },
  'pub': { repo: 'material', file: 'key.svg' },

  // 7. Shell & DevOps (Shell与DevOps)
  'sh': { repo: 'material', file: 'console.svg' },
  'bash': { repo: 'material', file: 'console.svg' },
  'zsh': { repo: 'material', file: 'console.svg' },
  'fish': { repo: 'material', file: 'console.svg' },
  'bat': { repo: 'material', file: 'console.svg' },
  'cmd': { repo: 'material', file: 'console.svg' },
  'ps1': { repo: 'material', file: 'console.svg' },
  'dockerfile': { repo: 'material', file: 'docker.svg' },
  'docker': { repo: 'material', file: 'docker.svg' },
  'k8s': { repo: 'material', file: 'kubernetes.svg' },
  'tf': { repo: 'material', file: 'terraform.svg' },
  'hcl': { repo: 'material', file: 'terraform.svg' },
  'nginx': { repo: 'material', file: 'nginx.svg' },

  // 8. Database (数据库)
  'sql': { repo: 'material', file: 'database.svg' },
  'db': { repo: 'material', file: 'database.svg' },
  'sqlite': { repo: 'material', file: 'database.svg' },
  'sqlite3': { repo: 'material', file: 'database.svg' },
  'rdb': { repo: 'material', file: 'database.svg' },

  // 9. Markup & Documentation (文档与标记)
  'md': { repo: 'material', file: 'markdown.svg' },
  'markdown': { repo: 'material', file: 'markdown.svg' },
  'mdx': { repo: 'material', file: 'mdx.svg' },
  'tex': { repo: 'material', file: 'tex.svg' },

  // 10. Mobile Apps (移动工程)
  'apk': { repo: 'material', file: 'android.svg' },
  'aab': { repo: 'material', file: 'android.svg' },
  'ipa': { repo: 'material', file: 'apple.svg' },

  // 11. 3D & Game Engine (3D建模与游戏引擎)
  'blend': { repo: 'material', file: 'blender.svg' },
  'stl': { repo: 'material', file: '3d.svg' },
  'obj': { repo: 'material', file: '3d.svg' },
  'fbx': { repo: 'material', file: '3d.svg' },

  // 12. Images & Design (图像与设计)
  'png': { repo: 'material', file: 'image.svg' },
  'jpg': { repo: 'material', file: 'image.svg' },
  'jpeg': { repo: 'material', file: 'image.svg' },
  'gif': { repo: 'material', file: 'image.svg' },
  'svg': { repo: 'material', file: 'svg.svg' },
  'webp': { repo: 'material', file: 'image.svg' },
  'ico': { repo: 'material', file: 'favicon.svg' },
  'bmp': { repo: 'material', file: 'image.svg' },
  'psd': { repo: 'material', file: 'adobe-photoshop.svg' },
  'ai': { repo: 'material', file: 'adobe-illustrator.svg' },
  'fig': { repo: 'material', file: 'figma.svg' },
  'sketch': { repo: 'material', file: 'sketch.svg' },
  'xd': { repo: 'material', file: 'figma.svg' },

  // 13. Audio & Video (音频与视频)
  'mp3': { repo: 'material', file: 'audio.svg' },
  'wav': { repo: 'material', file: 'audio.svg' },
  'flac': { repo: 'material', file: 'audio.svg' },
  'aac': { repo: 'material', file: 'audio.svg' },
  'ogg': { repo: 'material', file: 'audio.svg' },
  'mp4': { repo: 'material', file: 'video.svg' },
  'mov': { repo: 'material', file: 'video.svg' },
  'avi': { repo: 'material', file: 'video.svg' },
  'mkv': { repo: 'material', file: 'video.svg' },

  // 14. Archives & Executables (压缩包与执行文件)
  'zip': { repo: 'material', file: 'zip.svg' },
  'rar': { repo: 'material', file: 'zip.svg' },
  '7z': { repo: 'material', file: 'zip.svg' },
  'tar': { repo: 'material', file: 'zip.svg' },
  'gz': { repo: 'material', file: 'zip.svg' },
  'bz2': { repo: 'material', file: 'zip.svg' },
  'exe': { repo: 'material', file: 'exe.svg' },
  'msi': { repo: 'material', file: 'exe.svg' }
};

const customPptSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="16" height="16"><path fill="#C43E1C" d="M16 3A13 13 0 1 0 29 16 13 13 0 0 0 16 3zm0 2a11 11 0 0 1 11 11H16z"/><path fill="#E85C33" d="M16 16h11a11 11 0 0 1-11 11z"/><path fill="#D24726" d="M16 16v11A11 11 0 0 1 5 16z"/><path fill="#F06B43" d="M5 16A11 11 0 0 1 16 5v11z"/><rect fill="#B73516" x="3" y="9" width="15" height="14" rx="2.5"/><path fill="#FFFFFF" d="M7 12.5h4a2.5 2.5 0 0 1 0 5H8.5v2H7v-7zm1.5 1.5v2h2.5a1 1 0 0 0 0-2H8.5z"/></svg>`;

const iconContentMap = {};
let successCount = 0;

for (const [ext, spec] of Object.entries(extensionToIconMap)) {
  if (spec.repo === 'custom_ppt') {
    iconContentMap[ext] = customPptSvg;
    successCount++;
    continue;
  }

  let srcPath = null;
  if (spec.repo === 'vscode') {
    srcPath = path.join(vscodeIconsDir, spec.file);
  } else if (spec.repo === 'material') {
    srcPath = path.join(materialIconsDir, spec.file);
  }

  if (srcPath && fs.existsSync(srcPath)) {
    let svgContent = fs.readFileSync(srcPath, 'utf8');
    svgContent = svgContent.replace(/width="[^"]*"/g, '').replace(/height="[^fill="]*"/g, '');
    iconContentMap[ext] = svgContent;
    successCount++;
  } else {
    // Check fallback in material icons
    const altPath = path.join(materialIconsDir, `${ext}.svg`);
    if (fs.existsSync(altPath)) {
      let svgContent = fs.readFileSync(altPath, 'utf8');
      svgContent = svgContent.replace(/width="[^"]*"/g, '').replace(/height="[^fill="]*"/g, '');
      iconContentMap[ext] = svgContent;
      successCount++;
    } else {
      console.warn(`Icon missing for extension: ${ext}`);
      iconContentMap[ext] = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`;
    }
  }
}

// Write compiled JS asset file
const jsContent = `/* 100% High-Frequency Multi-Color 160+ File Extension Icon Dictionary */
window.COMPREHENSIVE_FILE_ICON_MAP = ${JSON.stringify(iconContentMap, null, 2)};
`;

fs.writeFileSync(path.join(__dirname, 'js', 'icon-assets.js'), jsContent, 'utf8');
console.log(`Successfully mapped ${successCount} vibrant color SVG icons across ${Object.keys(extensionToIconMap).length} file extensions!`);
