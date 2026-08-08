import type { CardState, CardGroupState } from '../types';

const PANEL_TITLE_MAP: Record<string, string> = {
  agent: '协作体', overview: '总览', files: '文件', preview: '预览',
  diff: '变更', terminal: '终端', tasks: '任务', runtime: '运行',
  chat: '对话', settings: '设置', plan: '计划',
};

export function getPanelTitle(cardId: string): string {
  return PANEL_TITLE_MAP[cardId] || cardId;
}

export function resolveWorkspacePanelKey(key: string | null | undefined): string | null {
  if (key == null) return null;
  const id = String(key).trim();
  if (!id) return null;
  if (id === 'settings' || id === 'runtime') return null;
  if (id === 'browser') return 'preview';
  if (id === 'plan') return 'tasks';
  return id;
}

export function makePanelCard(cardId: string): CardState {
  return { id: cardId, title: getPanelTitle(cardId) };
}

export function makePanelGroup(cardId: string, wsId: string, opts?: { groupId?: string; heightRatio?: number }): CardGroupState {
  return {
    id: opts?.groupId ?? `group-${cardId}-${wsId}`,
    activeCardId: cardId, cards: [makePanelCard(cardId)],
    heightRatio: opts?.heightRatio ?? 1,
  };
}
