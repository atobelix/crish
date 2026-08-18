/**
 * McpServerList 状态聚合 hook：将 useMcpSettings 的平铺状态收拢为
 * McpServerList 所需的分组对象（servers/ui/actions），消除 29 props 平铺。
 * 由 McpSettingsTab 调用，返回值直接展开传给 McpServerList。
 */
import { useMemo } from 'react';
import type { McpServerInfo, McpStatusSnapshot } from '../../api/mcpApi';
import type { McpServer } from '../../api/clientApi';
import type { SortMode } from './types';

/** 服务数据域 */
export interface McpServersGroup {
  demo: boolean;
  loading: boolean;
  servers: McpServerInfo[];
  status?: McpStatusSnapshot | undefined;
  demoServers: McpServer[];
  demoEnabled: Record<string, boolean>;
  filtered: McpServerInfo[];
  filteredDemo: McpServer[];
  expanded: Record<string, boolean>;
  busyId: string | null;
  canStartStop: boolean;
  controlHint?: string | undefined;
}

/** 工具条 / UI 域 */
export interface McpUiGroup {
  filter: string;
  sortMode: SortMode;
  showAdd: boolean;
  listLabelId: string;
  toolsPanelPrefix: string;
}

/** 操作回调域 */
export interface McpActionsGroup {
  onRefresh: () => void;
  onSetSort: (mode: SortMode) => void;
  onSetFilter: (filter: string) => void;
  onClearFilter: () => void;
  onSetShowAdd: React.Dispatch<React.SetStateAction<boolean>>;
  onToggleServer: (id: string, action: 'start' | 'stop') => void;
  onCopy: (text: string) => void;
  onToggleExpanded: (id: string) => void;
  onToggleDemoEnabled: (id: string) => void;
  onDeleteDemo: (id: string) => void;
  refreshDemo: () => void;
  refreshLive: () => void;
}

export interface McpServerListState {
  servers: McpServersGroup;
  ui: McpUiGroup;
  actions: McpActionsGroup;
}

/**
 * 聚合 McpServerList 所需的平铺状态为三个分组对象。
 * 输入为 useMcpSettings 返回的平铺字段，输出为 McpServerList 的分组 props。
 */
export function useMcpServerListState(input: {
  demo: boolean;
  loading: boolean;
  servers: McpServerInfo[];
  status?: McpStatusSnapshot | undefined;
  demoServers: McpServer[];
  demoEnabled: Record<string, boolean>;
  filtered: McpServerInfo[];
  filteredDemo: McpServer[];
  expanded: Record<string, boolean>;
  busyId: string | null;
  filter: string;
  sortMode: SortMode;
  canStartStop: boolean;
  controlHint?: string | undefined;
  showAdd: boolean;
  listLabelId: string;
  toolsPanelPrefix: string;
  onRefresh: () => void;
  onSetSort: (mode: SortMode) => void;
  onSetFilter: (filter: string) => void;
  onClearFilter: () => void;
  onSetShowAdd: React.Dispatch<React.SetStateAction<boolean>>;
  onToggleServer: (id: string, action: 'start' | 'stop') => void;
  onCopy: (text: string) => void;
  onToggleExpanded: (id: string) => void;
  onToggleDemoEnabled: (id: string) => void;
  onDeleteDemo: (id: string) => void;
  refreshDemo: () => void;
  refreshLive: () => void;
}): McpServerListState {
  return useMemo(() => {
    const {
      demo,
      loading,
      servers,
      status,
      demoServers,
      demoEnabled,
      filtered,
      filteredDemo,
      expanded,
      busyId,
      filter,
      sortMode,
      canStartStop,
      controlHint,
      showAdd,
      listLabelId,
      toolsPanelPrefix,
      onRefresh,
      onSetSort,
      onSetFilter,
      onClearFilter,
      onSetShowAdd,
      onToggleServer,
      onCopy,
      onToggleExpanded,
      onToggleDemoEnabled,
      onDeleteDemo,
      refreshDemo,
      refreshLive,
    } = input;
    return {
      servers: {
        demo,
        loading,
        servers,
        status,
        demoServers,
        demoEnabled,
        filtered,
        filteredDemo,
        expanded,
        busyId,
        canStartStop,
        controlHint,
      },
      ui: {
        filter,
        sortMode,
        showAdd,
        listLabelId,
        toolsPanelPrefix,
      },
      actions: {
        onRefresh,
        onSetSort,
        onSetFilter,
        onClearFilter,
        onSetShowAdd,
        onToggleServer,
        onCopy,
        onToggleExpanded,
        onToggleDemoEnabled,
        onDeleteDemo,
        refreshDemo,
        refreshLive,
      },
    };
  }, [input]);
}
