/**
 * codeIndentProjection — settingsStore.markdown.codeBlockIndent → DOM tab-size。
 * 与 themeProjection 同构：首次播种 + subscribe；同值幂等跳过。
 */
import { useSettingsStore } from './settingsStore';
import {
  applyCodeBlockIndentToDocument,
  readCodeBlockIndent,
} from '../api/codeBlockIndent';

export function initCodeIndentProjection(): () => void {
  let prev: string | undefined;

  const apply = () => {
    const next = readCodeBlockIndent();
    if (next === prev) return;
    prev = next;
    applyCodeBlockIndentToDocument(next);
  };

  apply();
  return useSettingsStore.subscribe(apply);
}
