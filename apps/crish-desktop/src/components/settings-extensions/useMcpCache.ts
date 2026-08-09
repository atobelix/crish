import { useCallback, useState } from 'react';
import type { McpServerInfo } from '../../api/mcpApi';

const MCP_SERVERS_CACHE_KEY = 'crish_mcp_servers_cache_v1';

function loadMcpServersCache(): McpServerInfo[] {
  try {
    const raw = localStorage.getItem(MCP_SERVERS_CACHE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveMcpServersCache(list: McpServerInfo[]) {
  try {
    localStorage.setItem(MCP_SERVERS_CACHE_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

/** MCP 缓存读写 hook（03-detail T10 拆分：useMcpCache） */
export function useMcpCache() {
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>(() =>
    loadMcpServersCache()
  );

  const saveMcpServers = useCallback((list: McpServerInfo[]) => {
    setMcpServers(list);
    saveMcpServersCache(list);
  }, []);

  return { mcpServers, setMcpServers, saveMcpServers };
}
