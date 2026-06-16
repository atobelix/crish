/**
 * Code highlighting — uses Prism.js if available, with basic fallback.
 */
export function highlightCode(root = document) {
  if (window.Prism) {
    root.querySelectorAll('.code-block code, pre code, .markdown-body pre code').forEach(block => {
      if (block.dataset.highlighted) return;
      let text = block.textContent;
      let lang = 'javascript';
      if (text.includes('def ') || text.includes('import sys')) lang = 'python';
      else if (text.includes('<!DOCTYPE') || text.includes('<html')) lang = 'markup';
      else if (text.includes('margin:') || text.includes('padding:')) lang = 'css';
      else if (text.startsWith('$ ') || text.startsWith('npm ')) lang = 'bash';
      block.classList.add(`language-${lang}`);
      window.Prism.highlightElement(block);
      block.dataset.highlighted = 'true';
    });
  } else {
    root.querySelectorAll('.code-block code, pre code, .markdown-body pre code').forEach(block => {
      if (block.dataset.highlighted) return;
      block.innerHTML = block.textContent
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      block.dataset.highlighted = 'true';
    });
  }
}
