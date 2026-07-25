import type { ExtensionKind } from '../../api/extensionCatalog';

export type MainView = 'installed' | 'discover';
export type KindFilter = 'all' | ExtensionKind;
export type ManageKind = null | 'skill' | 'mcp';
export type ExpandMode = 'detail' | 'config';

export type ExpandTarget =
  | { scope: 'installed'; id: string; mode: ExpandMode }
  | { scope: 'catalog'; id: string; mode: ExpandMode };

export interface PendingExpand {
  name: string;
  kind: ExtensionKind;
  mode: ExpandMode;
  fallbackId: string;
}
