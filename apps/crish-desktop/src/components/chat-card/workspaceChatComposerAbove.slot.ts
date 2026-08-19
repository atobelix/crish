/**
 * 业务域扩槽：chat 叶 composer 上沿（冷静审批条）。
 * 不把 ChatComposerAboveProps 写进 view-registry，避免 services → components 反向边。
 */
import type { ChatComposerAboveProps } from './chatComposerAboveProps';

declare module '../../services/view-registry/SlotTypes' {
  interface SlotMap {
    'workspace.chat.composerAbove': {
      kind: 'single';
      ownerProps: ChatComposerAboveProps;
    };
  }
}

export {};
