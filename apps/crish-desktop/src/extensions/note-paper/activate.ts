/**
 * 官方捆绑笔记扩展：registerView('note')，不是内核第 12 槽。
 */
import { viewRegistry, type ViewRenderContext } from '../../services/view-registry';
import { createNotePaperView } from './noteViewFactory';
import { NOTE_URI_RESOLVER } from './noteUri';

let currentDeactivate: (() => void) | null = null;
let officialOverride: boolean | null = null;

export function shouldActivateOfficialNotePaper(): boolean {
  return officialOverride ?? true;
}

/** 测 / 未来设置注入；null 恢复默认开 */
export function setOfficialNotePaperActivateForTesting(
  value: boolean | null
): void {
  officialOverride = value;
}

function noteViewTitle(ctx: ViewRenderContext): string {
  const raw = ctx.params?.docId;
  if (typeof raw === 'string') {
    const id = raw.trim();
    if (id) {
      return id.length > 16 ? `笔记 · ${id.slice(0, 8)}…` : `笔记 · ${id}`;
    }
  }
  return '笔记';
}

export function activateNotePaper(): () => void {
  if (currentDeactivate) {
    currentDeactivate();
  }

  const unregisterView = viewRegistry.registerView({
    id: 'note',
    title: noteViewTitle,
    icon: 'notebook-pen',
    category: 'tool',
    singleton: true,
    component: createNotePaperView(),
  });
  const unregisterUri = viewRegistry.registerUriResolver(NOTE_URI_RESOLVER);

  const deactivate = (): void => {
    unregisterView();
    unregisterUri();
    if (currentDeactivate === deactivate) {
      currentDeactivate = null;
    }
  };
  currentDeactivate = deactivate;
  return deactivate;
}

export function deactivateNotePaper(): void {
  if (!currentDeactivate) return;
  currentDeactivate();
}