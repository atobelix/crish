import { IncrementalMarkdownParser } from '../api/IncrementalMarkdownParser';

let parser = new IncrementalMarkdownParser();
let lastFullText = '';

self.onmessage = (e: MessageEvent<{ id?: number; fullText?: string; type?: string }>) => {
  const { id, fullText, type } = e.data;

  if (type === 'reset') {
    parser = new IncrementalMarkdownParser();
    lastFullText = '';
    return;
  }

  if (fullText == null || id == null) return;

  const changeOffset = computeChangeOffset(fullText);
  const updates = parser.push(fullText, changeOffset);
  const html = parser.getHtml();
  lastFullText = fullText;

  self.postMessage({ id, html, updates });
};

function computeChangeOffset(fullText: string): number {
  if (!lastFullText) return 0;
  const minLen = Math.min(lastFullText.length, fullText.length);
  let i = 0;
  while (i < minLen && lastFullText[i] === fullText[i]) i++;
  return i;
}
