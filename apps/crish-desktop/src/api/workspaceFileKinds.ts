/** 工作区文件名分类与路径叶函数，不依赖文件系统访问实现。 */
export function pathBasename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || p;
}

export function detectFileKind(
  name: string
): 'text' | 'image' | 'pdf' | 'table' | 'binary' {
  const n = name.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(n)) return 'image';
  if (/\.pdf$/i.test(n)) return 'pdf';
  if (/\.(csv|tsv)$/i.test(n)) return 'table';
  if (
    /\.(txt|md|markdown|mdx|json|jsonc|ts|tsx|js|jsx|mjs|cjs|css|scss|less|html|htm|xml|yml|yaml|toml|ini|env|py|rs|go|java|kt|c|cpp|h|hpp|cs|php|rb|sh|bash|zsh|ps1|bat|cmd|log|sql|graphql|vue|svelte|lock|gitignore|dockerignore|editorconfig|prettierrc|eslintrc|conf|cfg|properties|gradle|swift|m|mm|r|lua|vim|dart|scala|clj|ex|exs|erl|hs|ml|fs|fsx|nim|zig|v|sv|vhdl|asm|s|tex|rst|adoc|org)$/i.test(
      n
    ) ||
    n === 'dockerfile' ||
    n === 'makefile' ||
    n === 'cmakelists.txt' ||
    n.startsWith('.')
  ) {
    return 'text';
  }
  return 'binary';
}

/** Markdown / MDX：可渲染预览 */
export function isMarkdownFilename(name: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(name || '');
}
