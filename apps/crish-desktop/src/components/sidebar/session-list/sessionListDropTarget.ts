/**
 * sessionListDropTarget.ts — 侧栏会话拖拽的落点命中与插入位置解析（纯 DOM 读取，无状态）。
 *
 * 从 useSessionListDrag 拆出：hook 只负责指针生命周期、跨域分派与提交；
 * 「指针下是哪一行 / 哪个分组 / 前还是后」以及「插到哪一行之前」都在这里计算。
 */

import { GENERAL_FOLDER } from '../../../api/projectStore';
import styles from '../SidebarSessionList.module.css';
import {
  type DropPlace,
  FOLDER_SESSION_CN,
  FOLDER_GENERAL_SESSION_CN,
} from './useSessionListDragHelpers';

/** resolveDropTarget 的命中结果。 */
export type SidebarDropHit = {
  overPinned: boolean;
  targetSessionId: string | null;
  place: DropPlace;
  folder: string;
};

export function previewToInsertBeforeId(
  sectionIds: string[],
  overSessionId: string | null,
  place: DropPlace
): string | null {
  if (!overSessionId) return null;
  const idx = sectionIds.indexOf(overSessionId);
  if (idx === -1) return overSessionId;
  if (place === 'before') return overSessionId;
  const next = sectionIds[idx + 1];
  return next ?? null;
}

export function isGeneralFolderName(
  folder: string | null | undefined
): boolean {
  const f = (folder || '').trim();
  return (
    !f ||
    f === GENERAL_FOLDER ||
    f === FOLDER_SESSION_CN ||
    f === FOLDER_GENERAL_SESSION_CN ||
    f === 'general'
  );
}

/** 非置顶分组的容器选择器：常规分组走 general 落区，其余按 data-folder-name 精确匹配。 */
export function folderContainerSelector(folder: string): string {
  return isGeneralFolderName(folder)
    ? '[data-drop-zone="general"]'
    : `[data-folder-name="${CSS.escape ? CSS.escape(folder) : folder.replace(/"/g, '\\"')}"]`;
}

/**
 * 落点在 overSessionId 之后时，换算成「插入到哪一行之前」：
 * 取目标分区内（排除被拖拽的源行）的下一行；已是末行则为 null（追加到末尾）。
 */
export function resolveInsertBeforeIdAfter(
  sessionId: string,
  overSessionId: string,
  isPinned: boolean,
  folder: string
): string | null {
  const listRoot =
    (document.querySelector(
      isPinned ? '[data-drop-zone="pinned"]' : folderContainerSelector(folder)
    ) as HTMLElement | null) || null;
  const ids = listRoot
    ? Array.from(listRoot.querySelectorAll<HTMLElement>('[data-session-id]'))
        .map((n) => n.getAttribute('data-session-id') || '')
        .filter((id) => id && id !== sessionId)
    : [];
  return previewToInsertBeforeId(ids, overSessionId, 'after');
}

export function resolveDropTarget(
  clientX: number,
  clientY: number,
  selfSessionId: string,
  pinnedZone: HTMLElement | null,
  fallbackFolder: string,
  lastPlace: DropPlace,
  instantDy: number
): SidebarDropHit {
  const stack =
    typeof document.elementsFromPoint === 'function'
      ? (document.elementsFromPoint(clientX, clientY) as Element[])
      : ([document.elementFromPoint(clientX, clientY)].filter(
          Boolean
        ) as Element[]);

  let hovered: Element | null = null;
  const ghostClass = styles.sidebarDragGhost || 'sidebar-drag-ghost';
  for (const node of stack) {
    if (!(node instanceof HTMLElement)) continue;
    if (
      node.classList.contains(ghostClass) ||
      node.classList.contains('sidebar-drag-ghost') ||
      node.closest(`.${ghostClass}`) ||
      node.closest('.sidebar-drag-ghost')
    ) {
      continue;
    }
    // 关键防抖：穿透正在被拖拽的源项自身（杜绝将自身识别为落点而引发跳跃到末尾）
    const row = node.closest('[data-session-id]') as HTMLElement | null;
    if (row?.getAttribute('data-session-id') === selfSessionId) {
      continue;
    }
    hovered = node;
    break;
  }

  if (!hovered) {
    return {
      overPinned: false,
      targetSessionId: null,
      place: lastPlace,
      folder: fallbackFolder,
    };
  }

  const overPinned = Boolean(
    hovered.closest('[data-drop-zone="pinned"]') ||
    (styles.pinnedDropZone && hovered.closest(`.${styles.pinnedDropZone}`)) ||
    (styles.pinnedList &&
      hovered.closest(`.${styles.pinnedList}`) &&
      pinnedZone?.contains(hovered)) ||
    (pinnedZone &&
      (hovered === pinnedZone || pinnedZone.contains(hovered as Node)))
  );

  const sessionWrap = hovered.closest(
    '[data-session-id]'
  ) as HTMLElement | null;
  let targetSessionId: string | null =
    sessionWrap?.getAttribute('data-session-id') || null;
  if (targetSessionId === selfSessionId) {
    targetSessionId = null;
  }

  let place: DropPlace = lastPlace;

  // 1. 命中具体会话行时的滞后死区防抖（Hysteresis Deadband 35% ~ 65%）
  if (sessionWrap && targetSessionId) {
    const rect = sessionWrap.getBoundingClientRect();
    if (rect.height > 0) {
      const relY = clientY - rect.top;
      const ratio = relY / rect.height;

      if (ratio < 0.35) {
        place = 'before';
      } else if (ratio > 0.65) {
        place = 'after';
      } else {
        // 处于 35% ~ 65% 的黄金死区：根据明确运动趋势切换；微动或静止时绝对保持上一帧状态，消除震荡
        if (instantDy > 1.5) {
          place = 'after';
        } else if (instantDy < -1.5) {
          place = 'before';
        } else {
          place = lastPlace;
        }
      }
    }
  }

  const folderEl = hovered.closest('[data-folder-name]') as HTMLElement | null;
  const generalZone = hovered.closest(
    '[data-drop-zone="general"]'
  ) as HTMLElement | null;
  let folder = fallbackFolder;

  if (overPinned) {
    folder = fallbackFolder || GENERAL_FOLDER;
  } else if (folderEl) {
    folder =
      folderEl.getAttribute('data-folder-name') ||
      fallbackFolder ||
      GENERAL_FOLDER;
  } else if (generalZone) {
    folder = GENERAL_FOLDER;
  } else if (isGeneralFolderName(fallbackFolder)) {
    folder = GENERAL_FOLDER;
  }

  // 2. 容器边缘与间隙投影兜底：当未精准命中具体 li 时，吸附到该容器的最近项或首尾
  if (!targetSessionId) {
    const activeZone = overPinned
      ? pinnedZone
      : folderEl?.querySelector('ul') ||
        generalZone?.querySelector('ul') ||
        folderEl ||
        generalZone;

    if (activeZone) {
      const candidateRows = Array.from(
        activeZone.querySelectorAll<HTMLElement>('li[data-session-id]')
      ).filter(
        (r) =>
          r.getAttribute('data-session-id') !== selfSessionId &&
          r.offsetParent !== null &&
          r.getBoundingClientRect().height > 0
      );

      if (candidateRows.length > 0) {
        const first = candidateRows[0]!;
        const last = candidateRows[candidateRows.length - 1]!;
        const firstRect = first.getBoundingClientRect();
        const lastRect = last.getBoundingClientRect();

        if (clientY < firstRect.top + firstRect.height * 0.5) {
          targetSessionId = first.getAttribute('data-session-id');
          place = 'before';
        } else if (clientY > lastRect.bottom - lastRect.height * 0.5) {
          targetSessionId = last.getAttribute('data-session-id');
          place = 'after';
        } else {
          let closest = candidateRows[0]!;
          let minDist = Infinity;
          for (const r of candidateRows) {
            const b = r.getBoundingClientRect();
            const dist = Math.abs(clientY - (b.top + b.height / 2));
            if (dist < minDist) {
              minDist = dist;
              closest = r;
            }
          }
          targetSessionId = closest.getAttribute('data-session-id');
          const cRect = closest.getBoundingClientRect();
          place = clientY < cRect.top + cRect.height / 2 ? 'before' : 'after';
        }
      }
    }
  }

  return { overPinned, targetSessionId, place, folder };
}
