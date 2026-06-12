/**
 * ThinkingBlock - 思考内容折叠块
 */

import { useState } from 'preact/hooks';
import { IconChevronRight } from '../icons';

export function ThinkingBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const thoughtContent = content.replace(/^\[思考\]\s*/, '');

  return (
    <div class="repl-thinking-block">
      <div class="repl-thinking-header" onClick={() => setExpanded(!expanded)}>
        <span class={`repl-thinking-arrow ${expanded ? 'expanded' : ''}`}><IconChevronRight /></span>
        <span class="repl-thinking-title">Thinking...</span>
      </div>
      {expanded && <div class="repl-thinking-content">{thoughtContent}</div>}
    </div>
  );
}