import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import {
  listMcpServers,
  mcpStateKind,
  probeMcpControl,
  startMcpServer,
  stopMcpServer,
  type McpServerInfo,
  type McpStatusSnapshot,
} from '../../api/mcpApi';
import { isDemoMode } from '../../api/appMode';
import { clientApi, type McpServer } from '../../api/clientApi';
import {
  copyText,
  errText,
  START_STOP_HINT,
  STATE_SORT_RANK,
  type DemoTransport,
  type SortMode,
} from './types';

export type UseMcpSettingsOptions = {
  onShowToast?: ((msg: string) => void) | undefined;
  onAvailabilityChange?: ((available: boolean) => void) | undefined;
};

export function useMcpSettings({
  onShowToast,
  onAvailabilityChange,
}: UseMcpSettingsOptions = {}) {
  const demo = isDemoMode();
  const listLabelId = useId();
  const toolsPanelPrefix = useId();

  const [loading, setLoading] = useState(true);
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [status, setStatus] = useState<McpStatusSnapshot | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filterSortState, setFilterSortState] = useState<{
    filter: string;
    sortMode: SortMode;
  }>({ filter: '', sortMode: 'name' });
  const filter = filterSortState.filter;
  const sortMode = filterSortState.sortMode;
  const setFilter = (val: React.SetStateAction<string>) =>
    setFilterSortState((prev) => ({ ...prev, filter: typeof val === 'function' ? val(prev.filter) : val }));
  const setSortMode = (val: React.SetStateAction<SortMode>) =>
    setFilterSortState((prev) => ({ ...prev, sortMode: typeof val === 'function' ? val(prev.sortMode) : val }));

  const [probeState, setProbeState] = useState<{
    canStartStop: boolean;
    controlHint: string | undefined;
  }>({ canStartStop: false, controlHint: undefined });
  const canStartStop = probeState.canStartStop;
  const controlHint = probeState.controlHint;
  const setCanStartStop = (val: React.SetStateAction<boolean>) =>
    setProbeState((prev) => ({ ...prev, canStartStop: typeof val === 'function' ? val(prev.canStartStop) : val }));
  const setControlHint = (val: React.SetStateAction<string | undefined>) =>
    setProbeState((prev) => ({ ...prev, controlHint: typeof val === 'function' ? val(prev.controlHint) : val }));

  // demo 本地 mock
  const [demoServers, setDemoServers] = useState<McpServer[]>([]);
  const [demoEnabled, setDemoEnabled] = useState<Record<string, boolean>>({});

  const [addFormState, setAddFormState] = useState<{
    showAdd: boolean;
    newName: string;
    newType: DemoTransport;
    newCmd: string;
    newArgs: string;
    newUrl: string;
  }>({
    showAdd: false,
    newName: '',
    newType: 'stdio',
    newCmd: '',
    newArgs: '',
    newUrl: '',
  });
  const showAdd = addFormState.showAdd;
  const newName = addFormState.newName;
  const newType = addFormState.newType;
  const newCmd = addFormState.newCmd;
  const newArgs = addFormState.newArgs;
  const newUrl = addFormState.newUrl;

  const setShowAdd = (val: React.SetStateAction<boolean>) =>
    setAddFormState((prev) => ({ ...prev, showAdd: typeof val === 'function' ? val(prev.showAdd) : val }));
  const setNewName = (val: React.SetStateAction<string>) =>
    setAddFormState((prev) => ({ ...prev, newName: typeof val === 'function' ? val(prev.newName) : val }));
  const setNewType = (val: React.SetStateAction<DemoTransport>) =>
    setAddFormState((prev) => ({ ...prev, newType: typeof val === 'function' ? val(prev.newType) : val }));
  const setNewCmd = (val: React.SetStateAction<string>) =>
    setAddFormState((prev) => ({ ...prev, newCmd: typeof val === 'function' ? val(prev.newCmd) : val }));
  const setNewArgs = (val: React.SetStateAction<string>) =>
    setAddFormState((prev) => ({ ...prev, newArgs: typeof val === 'function' ? val(prev.newArgs) : val }));
  const setNewUrl = (val: React.SetStateAction<string>) =>
    setAddFormState((prev) => ({ ...prev, newUrl: typeof val === 'function' ? val(prev.newUrl) : val }));

  const refreshLive = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await listMcpServers();
      const probe = await probeMcpControl(r);
      setServers(r.servers);
      setStatus(r.status);
      setCanStartStop(probe.canStartStop);
      setControlHint(probe.message);
      if (!r.ok && r.error) {
        setError(r.error);
      } else if (!probe.canList && probe.message) {
        setError(probe.message);
      }
      onAvailabilityChange?.(r.configured || r.servers.length > 0);
    } catch (e) {
      setError(errText(e) || '读取扩展服务失败');
      setCanStartStop(false);
      onAvailabilityChange?.(false);
    } finally {
      setLoading(false);
    }
  }, [onAvailabilityChange]);

  const refreshDemo = useCallback(async () => {
    setLoading(true);
    try {
      const list = await clientApi.getMcpServers();
      setDemoServers(list);
      setDemoEnabled((prev) => {
        const next = { ...prev };
        for (const s of list) {
          if (next[s.id] === undefined) next[s.id] = true;
        }
        return next;
      });
      onAvailabilityChange?.(list.length > 0);
    } catch (e) {
      onShowToast?.(`加载失败：${errText(e) || '未知错误'}`);
      onAvailabilityChange?.(false);
    } finally {
      setLoading(false);
    }
  }, [onAvailabilityChange, onShowToast]);

  useEffect(() => {
    if (!showAdd) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setShowAdd(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [showAdd]);

  useEffect(() => {
    if (demo) void refreshDemo();
    else void refreshLive();
  }, [demo, refreshDemo, refreshLive]);

  const handleCopy = useCallback(
    async (text: string) => {
      const ok = await copyText(text);
      if (!ok) onShowToast?.('复制失败');
    },
    [onShowToast]
  );

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    let list = servers;
    if (q) {
      list = servers.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.id.toLowerCase().includes(q) ||
          s.tools.some((t) => t.toLowerCase().includes(q)) ||
          (s.transport || '').toLowerCase().includes(q) ||
          (s.lastError || '').toLowerCase().includes(q)
      );
    }
    const sorted = [...list];
    if (sortMode === 'name') {
      sorted.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    } else {
      sorted.sort((a, b) => {
        const ka = STATE_SORT_RANK[mcpStateKind(a.state)] ?? 9;
        const kb = STATE_SORT_RANK[mcpStateKind(b.state)] ?? 9;
        if (ka !== kb) return ka - kb;
        return a.name.localeCompare(b.name, 'zh-CN');
      });
    }
    return sorted;
  }, [servers, filter, sortMode]);

  const filteredDemo = useMemo(() => {
    const q = filter.trim().toLowerCase();
    let list = demoServers;
    if (q) {
      list = demoServers.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.id.toLowerCase().includes(q) ||
          (s.command || '').toLowerCase().includes(q) ||
          (s.url || '').toLowerCase().includes(q) ||
          (s.type || '').toLowerCase().includes(q)
      );
    }
    const sorted = [...list];
    if (sortMode === 'name') {
      sorted.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    } else {
      sorted.sort((a, b) => {
        const onA = demoEnabled[a.id] !== false ? 0 : 1;
        const onB = demoEnabled[b.id] !== false ? 0 : 1;
        if (onA !== onB) return onA - onB;
        return a.name.localeCompare(b.name, 'zh-CN');
      });
    }
    return sorted;
  }, [demoServers, filter, sortMode, demoEnabled]);

  const setSort = useCallback((mode: SortMode) => {
    setSortMode((prev) => (prev === mode ? prev : mode));
  }, []);

  const clearFilter = useCallback(() => setFilter(''), []);

  const handleToggleServer = useCallback(
    async (id: string, action: 'start' | 'stop') => {
      if (!canStartStop) return;
      setBusyId(id);
      const fn = action === 'start' ? startMcpServer : stopMcpServer;
      const prefix = action === 'start' ? '启动' : '停止';
      try {
        const r = await fn(id);
        if (!r.ok) {
          if (r.errorCode === 'unsupported') {
            setCanStartStop(false);
            setControlHint(r.error || START_STOP_HINT);
          } else {
            onShowToast?.(r.error ? `${prefix}失败：${r.error}` : `${prefix}失败`);
          }
          await refreshLive();
          return;
        }
        await refreshLive();
      } catch (e) {
        onShowToast?.(`${prefix}失败：${errText(e) || '未知错误'}`);
      } finally {
        setBusyId(null);
      }
    },
    [canStartStop, onShowToast, refreshLive]
  );

  const handleAddDemo = async () => {
    if (!newName.trim()) return;
    try {
      const server: McpServer = {
        id: `mcp-${Date.now()}`,
        name: newName.trim(),
        type: newType,
        ...(newType === 'stdio' && newCmd.trim() ? { command: newCmd.trim() } : {}),
        ...(newType === 'stdio' && newArgs.trim()
          ? {
              args: newArgs
                .split(',')
                .map((a) => a.trim())
                .filter(Boolean),
            }
          : {}),
        ...(newType === 'sse' && newUrl.trim() ? { url: newUrl.trim() } : {}),
        status: 'disconnected',
        tools: [],
      };
      const list = await clientApi.saveMcpServer(server);
      setDemoServers(list);
      setDemoEnabled((p) => ({ ...p, [server.id]: true }));
      onAvailabilityChange?.(list.length > 0);
      setShowAdd(false);
      setNewName('');
      setNewCmd('');
      setNewArgs('');
      setNewUrl('');
    } catch (e) {
      onShowToast?.(`保存失败：${errText(e) || '未知错误'}`);
    }
  };

  const handleDeleteDemo = async (id: string) => {
    try {
      const list = await clientApi.deleteMcpServer(id);
      setDemoServers(list);
      setDemoEnabled((p) => {
        const next = { ...p };
        delete next[id];
        return next;
      });
      onAvailabilityChange?.(list.length > 0);
    } catch (e) {
      onShowToast?.(`删除失败：${errText(e) || '未知错误'}`);
    }
  };

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((p) => ({ ...p, [id]: !p[id] }));
  }, []);

  const toggleDemoEnabled = useCallback((id: string) => {
    setDemoEnabled((p) => ({ ...p, [id]: p[id] === false ? true : false }));
  }, []);

  const refresh = demo ? refreshDemo : refreshLive;

  return {
    demo,
    listLabelId,
    toolsPanelPrefix,
    loading,
    servers,
    status,
    error,
    expanded,
    busyId,
    filter,
    sortMode,
    canStartStop,
    controlHint,
    demoServers,
    demoEnabled,
    showAdd,
    newName,
    newType,
    newCmd,
    newArgs,
    newUrl,
    setFilter,
    setShowAdd,
    setNewName,
    setNewType,
    setNewCmd,
    setNewArgs,
    setNewUrl,
    refreshLive,
    refreshDemo,
    refresh,
    handleCopy,
    filtered,
    filteredDemo,
    setSort,
    clearFilter,
    handleToggleServer,
    handleAddDemo,
    handleDeleteDemo,
    toggleExpanded,
    toggleDemoEnabled,
  };
}
