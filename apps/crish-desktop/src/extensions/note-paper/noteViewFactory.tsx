import { lazy, type ComponentType } from 'react';
import type { ViewRenderContext } from '../../services/view-registry';

/** activate 只拿 lazy 句柄，禁止同步拉 Strict 面板整树 */
export function createNotePaperView(): ComponentType<ViewRenderContext> {
  return lazy(() => import('./NoteLeafHost'));
}
