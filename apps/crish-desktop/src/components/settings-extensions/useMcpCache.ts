import { useCallback, useState } from 'react';
import type { McpServerInfo } from '../../api/mcpApi';

import {
  readMcpServersCache,
  writeMcpServersCache,
} from '../../api/cache/runtimeCache';

/** MCP 缓存读写 hook（03-detail T10 拆分：useMcpCache） */
export function useMcpCache() {
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>(() =>
    readMcpServersCache()
  );

  const saveMcpServers = useCallback((list: McpServerInfo[]) => {
    setMcpServers(list);
    writeMcpServersCache(list);
  }, []);

  return { mcpServers, setMcpServers, saveMcpServers };
}
