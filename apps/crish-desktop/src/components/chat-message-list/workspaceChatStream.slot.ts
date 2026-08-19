/**
 * 业务域扩槽：chat 叶文档流。
 * 不把 ChatMessageListProps 写进 view-registry，避免 services → components 反向边。
 */
import type { ChatMessageListProps } from './chatMessageListProps';

declare module '../../services/view-registry/SlotTypes' {
  interface SlotMap {
    'workspace.chat.stream': {
      kind: 'single';
      ownerProps: ChatMessageListProps;
    };
  }
}

export {};
