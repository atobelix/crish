import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Dialog, Button } from '../ui';
import { AppIcon } from '../ui/icons/index';
import { clientApi, type McpServer, type Settings } from '../../api/clientApi';
import { useSettingsStore } from '../../store/settingsStore';
import { useToast } from '../../services/toast/ToastContext';
import {
  detectExternalMcpServers,
  type DetectedExternalMcpServer,
} from './detectExternalMcpServers';
import {
  type ConnectTab,
  type PresetItem,
  DEFAULT_SYNTAX_DEMO,
  parseArgs,
  parseEnv,
} from './mcpConnectTypes';
import { McpManualTab } from './McpManualTab';
import { McpSyntaxTab } from './McpSyntaxTab';
import { McpQuickTab } from './McpQuickTab';
import { KNOWN_MCP_TOOL_MAP, resolveMcpTools } from './knownMcpTools';
import styles from './McpConnectModal.module.css';

export { detectExternalMcpServers, type DetectedExternalMcpServer };

export { KNOWN_MCP_TOOL_MAP, resolveMcpTools };

export interface McpConnectModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: (server: McpServer) => void;
}

export const McpConnectModal: React.FC<McpConnectModalProps> = ({
  open,
  onClose,
  onSuccess,
}) => {
  const { showToast } = useToast();
  const [activeTab, setActiveTab] = useState<ConnectTab>('manual');

  // Manual Tab Form State
  const [manualName, setManualName] = useState('');
  const [manualType, setManualType] = useState<'stdio' | 'sse'>('stdio');
  const [manualCmd, setManualCmd] = useState('');
  const [manualArgs, setManualArgs] = useState('');
  const [manualEnv, setManualEnv] = useState('');
  const [manualUrl, setManualUrl] = useState('');

  // Syntax Tab State
  const [syntaxJson, setSyntaxJson] = useState(DEFAULT_SYNTAX_DEMO);
  const [syntaxError, setSyntaxError] = useState<string | null>(null);
  const [syntaxInfo, setSyntaxInfo] = useState<string | null>(null);

  // Quick Tab State
  const [scanning, setScanning] = useState(false);
  const [detectedList, setDetectedList] = useState<DetectedExternalMcpServer[]>(
    []
  );
  const [scannedOnce, setScannedOnce] = useState(false);

  const existingServers = useSettingsStore((s) => s.mcpServers || []);
  const existingNames = useMemo(
    () => new Set(existingServers.map((s) => s.name)),
    [existingServers]
  );

  const saveServer = useCallback(
    (server: McpServer) => {
      const current = useSettingsStore.getState().mcpServers || [];
      const list = [
        ...current.filter((s) => s.id !== server.id && s.name !== server.name),
        server,
      ];
      useSettingsStore.getState().setMcpServers(list);
      void clientApi.saveSettingsEx('__global__', 'global', {
        mcpServers: list,
      } as unknown as Partial<Settings>);
      onSuccess(server);
      showToast(`成功接入 MCP 服务「${server.name}」`);
      onClose();
    },
    [onSuccess, showToast, onClose]
  );

  const handleApplyPreset = (preset: PresetItem) => {
    setManualName(preset.name);
    setManualType(preset.type);
    setManualCmd(preset.command);
    setManualArgs(preset.args);
    if (preset.url) setManualUrl(preset.url);
    showToast(`已应用「${preset.name}」预设配置`);
  };

  const handleManualSave = () => {
    const name = manualName.trim();
    if (!name) {
      showToast('请输入 MCP 服务名称');
      return;
    }
    if (manualType === 'stdio' && !manualCmd.trim()) {
      showToast('stdio 传输模式必须指定启动命令');
      return;
    }
    if (manualType === 'sse' && !manualUrl.trim()) {
      showToast('sse 传输模式必须指定端点 URL');
      return;
    }

    const server: McpServer = {
      id: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      type: manualType,
      ...(manualType === 'stdio'
        ? { command: manualCmd.trim(), args: parseArgs(manualArgs) }
        : {}),
      ...(manualType === 'sse' ? { url: manualUrl.trim() } : {}),
      ...(manualEnv.trim() ? { env: parseEnv(manualEnv) } : {}),
      status: 'connected',
      tools: resolveMcpTools(name, manualCmd, parseArgs(manualArgs)),
    };

    saveServer(server);
  };

  // 词法 JSON 校验
  useEffect(() => {
    if (!syntaxJson.trim()) {
      setSyntaxError(null);
      setSyntaxInfo(null);
      return;
    }
    try {
      const parsed = JSON.parse(syntaxJson);
      setSyntaxError(null);
      if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
        const keys = Object.keys(parsed.mcpServers);
        setSyntaxInfo(
          `✓ JSON 语法校验通过：检测到标准 mcpServers 配置 (${keys.join(', ') || '空列表'})`
        );
      } else if (parsed.command || parsed.url) {
        setSyntaxInfo(
          `✓ JSON 语法校验通过：单服务配置「${parsed.name || '自定义'}」(${parsed.url ? 'sse' : 'stdio'})`
        );
      } else {
        setSyntaxInfo(
          '⚠️ JSON 格式正确，但需包含 command/url 或 mcpServers 结构'
        );
      }
    } catch (e: any) {
      setSyntaxError(e?.message || 'JSON 语法错误');
      setSyntaxInfo(null);
    }
  }, [syntaxJson]);

  const handleSyntaxSave = () => {
    if (!syntaxJson.trim()) {
      showToast('请输入有效的 JSON 配置');
      return;
    }
    try {
      const parsed = JSON.parse(syntaxJson);
      let srvName = 'mcp-service';
      let srvType: 'stdio' | 'sse' = 'stdio';
      let srvCmd: string | undefined;
      let srvArgs: string[] | undefined;
      let srvUrl: string | undefined;
      let srvEnv: Record<string, string> | undefined;

      if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
        const entries = Object.entries(parsed.mcpServers);
        if (entries.length === 0) {
          showToast('mcpServers 配置列表为空');
          return;
        }
        const [k, v] = entries[0] as [string, any];
        srvName = k;
        srvType = v.url ? 'sse' : 'stdio';
        srvCmd = typeof v.command === 'string' ? v.command : undefined;
        srvArgs = Array.isArray(v.args) ? v.args.map(String) : undefined;
        srvUrl = typeof v.url === 'string' ? v.url : undefined;
        srvEnv = v.env && typeof v.env === 'object' ? v.env : undefined;
      } else if (parsed.command || parsed.url) {
        srvName = parsed.name || 'custom-mcp';
        srvType = parsed.url ? 'sse' : 'stdio';
        srvCmd =
          typeof parsed.command === 'string' ? parsed.command : undefined;
        srvArgs = Array.isArray(parsed.args)
          ? parsed.args.map(String)
          : undefined;
        srvUrl = typeof parsed.url === 'string' ? parsed.url : undefined;
        srvEnv =
          parsed.env && typeof parsed.env === 'object' ? parsed.env : undefined;
      } else {
        showToast('未能解析出有效的 MCP 配置字段');
        return;
      }

      const parsedTools = Array.isArray(parsed.tools)
        ? parsed.tools.map(String)
        : undefined;
      const server: McpServer = {
        id: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: srvName,
        type: srvType,
        ...(srvCmd ? { command: srvCmd } : {}),
        ...(srvArgs ? { args: srvArgs } : {}),
        ...(srvUrl ? { url: srvUrl } : {}),
        ...(srvEnv ? { env: srvEnv } : {}),
        status: 'connected',
        tools: resolveMcpTools(srvName, srvCmd, srvArgs, parsedTools),
      };

      saveServer(server);
    } catch (e: any) {
      showToast(`保存失败：${e?.message || 'JSON 格式错误'}`);
    }
  };

  // 扫描外部 MCP 服务
  const handleScanExternal = useCallback(async () => {
    setScanning(true);
    try {
      const list = await detectExternalMcpServers();
      setDetectedList(list);
    } catch {
      setDetectedList([]);
    } finally {
      setScanning(false);
      setScannedOnce(true);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'quick' && !scannedOnce && !scanning) {
      void handleScanExternal();
    }
  }, [activeTab, scannedOnce, scanning, handleScanExternal]);

  const handleConnectDetected = (item: DetectedExternalMcpServer) => {
    const server: McpServer = {
      id: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: item.name,
      type: item.type,
      ...(item.command ? { command: item.command } : {}),
      ...(item.args ? { args: item.args } : {}),
      ...(item.url ? { url: item.url } : {}),
      ...(item.env ? { env: item.env } : {}),
      status: 'connected',
      tools: resolveMcpTools(item.name, item.command, item.args),
    };
    saveServer(server);
  };

  return (
    <Dialog size="xl" open={open} onClose={onClose} title="接入 MCP 服务">
      <div className={styles.modalContainer}>
        {/* 顶部 Tab 切换 */}
        <div className={styles.tabNav} role="tablist">
          <Button
            bare
            type="button"
            className={`${styles.tabBtn} ${activeTab === 'manual' ? styles.tabBtnActive : ''}`}
            onClick={() => setActiveTab('manual')}
            role="tab"
            aria-selected={activeTab === 'manual'}
          >
            <AppIcon name="edit" size={13} />
            <span>手动表单配置</span>
          </Button>
          <Button
            bare
            type="button"
            className={`${styles.tabBtn} ${activeTab === 'syntax' ? styles.tabBtnActive : ''}`}
            onClick={() => setActiveTab('syntax')}
            role="tab"
            aria-selected={activeTab === 'syntax'}
          >
            <AppIcon name="code" size={13} />
            <span>词法 JSON 编写</span>
          </Button>
          <Button
            bare
            type="button"
            className={`${styles.tabBtn} ${activeTab === 'quick' ? styles.tabBtnActive : ''}`}
            onClick={() => setActiveTab('quick')}
            role="tab"
            aria-selected={activeTab === 'quick'}
          >
            <AppIcon name="zap" size={13} />
            <span>本机快速接入</span>
          </Button>
        </div>

        {/* 内容区 */}
        <div className={styles.tabContent}>
          {activeTab === 'manual' && (
            <McpManualTab
              name={manualName}
              setName={setManualName}
              type={manualType}
              setType={setManualType}
              command={manualCmd}
              setCommand={setManualCmd}
              args={manualArgs}
              setArgs={setManualArgs}
              env={manualEnv}
              setEnv={setManualEnv}
              url={manualUrl}
              setUrl={setManualUrl}
              onApplyPreset={handleApplyPreset}
            />
          )}

          {activeTab === 'syntax' && (
            <McpSyntaxTab
              json={syntaxJson}
              setJson={setSyntaxJson}
              error={syntaxError}
              info={syntaxInfo}
              onResetDemo={() => setSyntaxJson(DEFAULT_SYNTAX_DEMO)}
            />
          )}

          {activeTab === 'quick' && (
            <McpQuickTab
              scanning={scanning}
              detectedList={detectedList}
              existingNames={existingNames}
              onScan={handleScanExternal}
              onConnect={handleConnectDetected}
            />
          )}
        </div>

        {/* 底部按钮栏 */}
        <div className={styles.modalFooter}>
          <Button
            variant="ghost"
            size="sm"
            className={styles.actionBtn}
            onClick={onClose}
          >
            取消
          </Button>
          {activeTab === 'manual' && (
            <Button
              variant="primary"
              size="sm"
              className={styles.actionBtn}
              onClick={handleManualSave}
            >
              保存并接入
            </Button>
          )}
          {activeTab === 'syntax' && (
            <Button
              variant="primary"
              size="sm"
              disabled={Boolean(syntaxError) || !syntaxJson.trim()}
              className={styles.actionBtn}
              onClick={handleSyntaxSave}
            >
              解析并接入
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
};
