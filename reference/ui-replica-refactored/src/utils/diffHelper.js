import { escapeHTML } from './escape.js';

/**
 * Compute tool metrics from call array.
 */
export function computeToolMetrics(calls) {
  const viewed = new Set();
  const edited = new Set();
  calls.forEach(call => {
    const name = call.name.toLowerCase();
    if (name.includes('read') || name.includes('view') || name.includes('grep') || name.includes('search')) {
      viewed.add(call.result?.split('\n')[0] || call.args);
    }
    if (name.includes('write') || name.includes('edit') || name.includes('apply') || name.includes('replace')) {
      edited.add(call.result?.split('\n')[0] || call.args);
    }
  });
  return { tools: calls.length, edited: edited.size, viewed: viewed.size };
}

/**
 * Render diff view HTML from diff object.
 */
export function renderDiffView(diff) {
  if (!diff || !diff.hunks) return `<pre><code>${escapeHTML(diff)}</code></pre>`;
  const hunksHtml = diff.hunks.map(hunk => {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    const linesHtml = hunk.lines.map(line => {
      const marker = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';
      const lineClass = `diff-${line.type}`;
      const oldNum = line.type === 'added' ? '' : oldLine++;
      const newNum = line.type === 'removed' ? '' : newLine++;
      return `<div class="diff-line ${lineClass}">
        <span class="diff-num">${oldNum || ''}</span>
        <span class="diff-num">${newNum || ''}</span>
        <span class="diff-marker">${marker}</span>
        <span class="diff-content">${escapeHTML(line.content)}</span>
      </div>`;
    }).join('');
    return `<div class="diff-hunk-header">@@ -${hunk.oldStart} +${hunk.newStart} @@</div>${linesHtml}`;
  }).join('');
  return `<div class="diff-view">${hunksHtml}</div>`;
}
