// WebView 渲染库生成脚本（批 E，2026-11-03)：把 katex / mermaid 的官方
// dist 产物转成 TS 字符串模块（src/presentation/components/blocks/webview/
// generated/)，供公式 / 图块的本地 WebView HTML 内联引用——内容不出设备、
// 不走任何第三方服务。
//
// 为什么生成字符串模块而不是运行时读资产：WebView 的 html 源需要完整文档
// 字符串，字符串模块让拼装成为纯函数（buildWebHtml 可单测）、渲染同步可达，
// 且与图标出处钉版（iconPaths）同为本仓「外部产物字节钉版」先例。
// katex / mermaid 只作 devDependencies：App 包不直引这两个包，运行时只消费
// 本脚本的生成物；升级版本后重跑本脚本并同步生成物头部的版本钉版。
//
// 用法：node scripts/generate-webview-libs.mjs（在 apps/crish-mobile 下）
import { existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import { dirname, join, resolve} from 'node:path';
import { fileURLToPath} from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function findPackageDir(name) {
const candidates = [
join(appDir, 'node_modules', name),
join(appDir, '..', '..', 'node_modules', name),
];
for (const dir of candidates) {
if (existsSync(join(dir, 'package.json'))) return dir;
}
throw new Error(`找不到包 ${name}（先 npm install)`);
}

function readPackage(name) {
const dir = findPackageDir(name);
const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
return { dir, version: pkg.version};
}

/** JS 源码内联进 <script> 前的安全处理：源码中的 </script 只可能出现在
* 字符串 / 正则字面量内，替换为 <\/script 不改变其值 / 语义（\/ === /) */
function sanitizeForInlineScript(name, source) {
const hits = source.match(/<\/script/gi)?.length?? 0;
if (hits === 0) return source;
console.log(`${name}: 内联转义 </script × ${hits}`);
return source.replace(/<\/script/gi, '<\\/script');
}

const katex = readPackage('katex');
const katexJsRaw = readFileSync(join(katex.dir, 'dist', 'katex.min.js'), 'utf8');
const katexJs = sanitizeForInlineScript('katex.min.js', katexJsRaw);

// CSS：字体一律内嵌 woff2 的 data URI（woff / ttf 备选指向同字体的 woff2——
// 现行 Android WebView 均支持 woff2)，不留任何相对 url 引用。
const fontDataUri = (fontsDir, file) => {
const woff2 = file.replace(/\.(woff|ttf)$/, '.woff2');
const buf = readFileSync(join(fontsDir, woff2));
return `data:font/woff2;base64,${buf.toString('base64')}`;
};
let katexCss = readFileSync(join(katex.dir, 'dist', 'katex.min.css'), 'utf8');
katexCss = katexCss.replace(
/url\(fonts\/([^)]+)\)/g,
(_m, file) => `url(${fontDataUri(join(katex.dir, 'dist', 'fonts'), file)})`
);
if (/url\(fonts\//.test(katexCss)) {
throw new Error('katex CSS 仍有未内嵌的字体 url() 引用');
}

const mermaid = readPackage('mermaid');
const mermaidJsRaw = readFileSync(
join(mermaid.dir, 'dist', 'mermaid.min.js'),
'utf8'
);
const mermaidJs = sanitizeForInlineScript('mermaid.min.js', mermaidJsRaw);

const outDir = join(
appDir,
'src',
'presentation',
'components',
'blocks',
'webview',
'generated'
);
mkdirSync(outDir, { recursive: true});

const header = (lines) =>
[
'// 【生成文件 · 勿手改】由 scripts/generate-webview-libs.mjs 生成，',
...lines.map((line) => `// ${line}`),
'// 升级依赖版本后重跑脚本并同步此钉版；内容为第三方库官方 dist 产物',
'// 的字节内嵌（KaTeX / Mermaid 均 MIT)，运行时经本地 WebView 引用，',
'// 不出设备、不走第三方服务。',
'',
].join('\n');

writeFileSync(
join(outDir, 'katex.ts'),
header([
`来源：katex@${katex.version} dist/katex.min.js + dist/katex.min.css`,
'（字体已转 data URI 内嵌，仅 woff2)。',
]) +
`export const KATEX_JS = ${JSON.stringify(katexJs)};\n` +
`export const KATEX_CSS = ${JSON.stringify(katexCss)};\n`
);

writeFileSync(
join(outDir, 'mermaid.ts'),
header([`来源：mermaid@${mermaid.version} dist/mermaid.min.js(UMD)。`]) +
`export const MERMAID_JS = ${JSON.stringify(mermaidJs)};\n`
);

console.log(
`katex@${katex.version}: js ${katexJs.length} B, css(+fonts) ${katexCss.length} B`
);
console.log(`mermaid@${mermaid.version}: js ${mermaidJs.length} B`);
console.log(`生成完毕 → ${outDir}`);
