import { useCallback, useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { appState } from '../core/app-state';
import { tauriBridge } from '../core/tauri-bridge';
import type {
  WorkbenchAccountCenterConfigured,
  WorkbenchApiKeySource,
  WorkbenchProviderConfigSnapshot,
  WorkbenchProviderMode,
} from '../shared/workbench-contract';
import { IconCheck, IconChevronDown, IconKey, IconRefresh, IconShield, IconSpinner, IconUser } from './icons';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const PROVIDER_MODE_STORAGE_KEY = 'codex.workbench.providerMode';

export default function ProviderSettingsPanel() {
  const [providerConfig, setProviderConfig] = useState(appState.getState().providerConfig);
  const [providerMode, setProviderMode] = useState<WorkbenchProviderMode>(providerConfig.credentialMode);
  const [baseUrl, setBaseUrl] = useState(providerConfig.baseUrl);
  const [model, setModel] = useState(providerConfig.model || appState.getState().model);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);

  const isLoggedIn = providerConfig.accountCenterConfigured === true;

  useEffect(() => appState.subscribe('providerConfig', setProviderConfig), []);

  useEffect(() => {
    let cancelled = false;
    tauriBridge.getApiConfig().then((config) => {
      if (cancelled) return;
      const mode = readProviderModePreference() ?? (config.hasApiKey ? 'direct' : 'account-center');
      const nextConfig = withProviderMode(config, mode);
      setProviderMode(mode);
      setBaseUrl(nextConfig.baseUrl);
      setModel(nextConfig.model || appState.getState().model);
      appState.setState('providerConfig', nextConfig);
      if (nextConfig.model) appState.setState('model', nextConfig.model);
      // 自动获取模型列表
      if (nextConfig.baseUrl) {
        fetchModelList(nextConfig.baseUrl, mode === 'direct' ? (config.hasApiKey ? undefined : undefined) : undefined);
      }
    }).catch(() => {
      setProviderConfig(withProviderMode(appState.getState().providerConfig, providerMode));
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (saveStatus !== 'saved') return;
    const timer = setTimeout(() => setSaveStatus('idle'), 1800);
    return () => clearTimeout(timer);
  }, [saveStatus]);

  async function fetchModelList(url: string, key?: string) {
    if (!url.trim()) return;
    setFetchingModels(true);
    try {
      const models = await tauriBridge.fetchModels(url, key);
      setAvailableModels(models);
    } catch { /* ignore */ }
    setFetchingModels(false);
  }

  const handleModeChange = useCallback((mode: WorkbenchProviderMode) => {
    setProviderMode(mode);
    writeProviderModePreference(mode);
    const nextConfig = withProviderMode(providerConfig, mode);
    setProviderConfig(nextConfig);
    appState.setState('providerConfig', nextConfig);
    // 切换模式后自动刷新模型列表
    if (baseUrl.trim()) {
      fetchModelList(baseUrl.trim(), mode === 'direct' ? apiKeyInput.trim() || undefined : undefined);
    }
  }, [providerConfig, baseUrl, apiKeyInput]);

  const handleSave = useCallback(async () => {
    const nextBaseUrl = baseUrl.trim();
    const nextModel = model.trim();
    setSaveStatus('saving');
    try {
      const update =
        providerMode === 'account-center'
          ? { apiKey: '', baseUrl: nextBaseUrl, model: nextModel, credentialMode: providerMode }
          : {
              apiKey: apiKeyInput.trim(),
              baseUrl: nextBaseUrl,
              model: nextModel,
              credentialMode: providerMode,
            };
      const result = withProviderMode(await tauriBridge.updateDaemonConfig(update), providerMode);
      writeProviderModePreference(providerMode);
      setProviderConfig(result);
      setApiKeyInput('');
      appState.setState('providerConfig', result);
      appState.setState('model', result.model);
      if (providerMode === 'direct' && apiKeyInput.trim()) {
        appState.setState('apiKey', apiKeyInput.trim());
      }
      if (providerMode === 'account-center') {
        appState.setState('apiKey', '');
      }
      setSaveStatus('saved');
      // 保存后刷新模型列表
      fetchModelList(nextBaseUrl, providerMode === 'direct' ? apiKeyInput.trim() || undefined : undefined);
    } catch {
      setSaveStatus('error');
    }
  }, [apiKeyInput, baseUrl, model, providerMode]);

  const handleRefreshModels = useCallback(() => {
    fetchModelList(baseUrl.trim(), providerMode === 'direct' ? apiKeyInput.trim() || undefined : undefined);
  }, [baseUrl, apiKeyInput, providerMode]);

  // 关闭下拉菜单的点击外部监听
  useEffect(() => {
    if (!modelDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.repl-rs-model-dropdown')) {
        setModelDropdownOpen(false);
      }
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [modelDropdownOpen]);

  return (
    <div class="repl-rs-settings-list">
      {/* 连接方式选择 - 账户中心为主 */}
      <div class="repl-rs-settings-section">
        <div class="repl-rs-settings-section-title">连接方式</div>
        <div class="repl-provider-mode-selector">
          <button
            class={`repl-provider-mode-btn ${providerMode === 'account-center' ? 'active' : ''}`}
            onClick={() => handleModeChange('account-center')}
          >
            <IconShield /> 账户中心
          </button>
          <button
            class={`repl-provider-mode-btn ${providerMode === 'direct' ? 'active' : ''}`}
            onClick={() => handleModeChange('direct')}
          >
            <IconKey /> API 密钥
          </button>
        </div>
      </div>

      {/* 账户中心模式 - 简化显示 */}
      {providerMode === 'account-center' && (
        <div class="repl-rs-settings-section">
          <div class="repl-rs-settings-section-title">模型</div>
          {isLoggedIn ? (
            <>
              <div class="repl-rs-setting-row">
                <div class="repl-rs-setting-row-label">当前模型</div>
                <div class="repl-rs-setting-row-control repl-rs-model-dropdown">
                  <button
                    class="repl-rs-setting-option"
                    onClick={(e) => { e.stopPropagation(); setModelDropdownOpen(!modelDropdownOpen); }}
                  >
                    {model || '请选择模型'} <IconChevronDown />
                  </button>
                  {modelDropdownOpen && (
                    <div class="repl-rs-setting-dropdown" onClick={(e) => e.stopPropagation()}>
                      {availableModels.length > 0 ? (
                        <>
                          <div class="repl-rs-setting-dropdown-group">可用模型</div>
                          {availableModels.map((m) => (
                            <div
                              key={m}
                              class={`repl-rs-setting-dropdown-item ${m === model ? 'active' : ''}`}
                              onClick={() => { setModel(m); setModelDropdownOpen(false); }}
                            >
                              <span>{m}</span>
                              {m === model && <IconCheck />}
                            </div>
                          ))}
                        </>
                      ) : (
                        <div class="repl-rs-setting-dropdown-item disabled">
                          {fetchingModels ? '正在获取模型列表...' : '暂无可用模型'}
                        </div>
                      )}
                    </div>
                  )}
                  <button class="repl-rs-btn-icon" onClick={handleRefreshModels} title="刷新模型列表" disabled={fetchingModels}>
                    {fetchingModels ? <IconSpinner /> : <IconRefresh />}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div class="repl-rs-setting-row">
              <div class="repl-rs-setting-row-control repl-rs-col-control">
                <span class="repl-rs-setting-value">请先登录账户中心以获取可用模型</span>
                <button class="repl-rs-setting-option">
                  <IconUser /> 前往登录
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* API 密钥模式 - 完整配置 */}
      {providerMode === 'direct' && (
        <>
          <div class="repl-rs-settings-section">
            <div class="repl-rs-settings-section-title">自定义 Provider</div>
            <div class="repl-rs-setting-row">
              <div class="repl-rs-setting-row-label">Base URL</div>
              <div class="repl-rs-setting-row-control">
                <input
                  value={baseUrl}
                  placeholder="https://api.flowbit.me"
                  onInput={(event: any) => setBaseUrl(event.currentTarget.value)}
                  class="repl-rs-search-input repl-rs-input-w240"
                />
              </div>
            </div>
            <div class="repl-rs-setting-row">
              <div class="repl-rs-setting-row-label">API 密钥</div>
              <div class="repl-rs-setting-row-control">
                <input
                  type="password"
                  value={apiKeyInput}
                  placeholder={providerConfig.hasApiKey ? '已保存密钥，留空保持不变' : '粘贴 API 密钥'}
                  onInput={(event: any) => setApiKeyInput(event.currentTarget.value)}
                  class="repl-rs-search-input repl-rs-input-w240"
                />
              </div>
            </div>
            <div class="repl-rs-setting-row">
              <div class="repl-rs-setting-row-label">模型</div>
              <div class="repl-rs-setting-row-control repl-rs-model-dropdown">
                <button
                  class="repl-rs-setting-option"
                  onClick={(e) => { e.stopPropagation(); setModelDropdownOpen(!modelDropdownOpen); }}
                >
                  {model || '请选择模型'} <IconChevronDown />
                </button>
                {modelDropdownOpen && (
                  <div class="repl-rs-setting-dropdown" onClick={(e) => e.stopPropagation()}>
                    {availableModels.length > 0 ? (
                      <>
                        <div class="repl-rs-setting-dropdown-group">可用模型</div>
                        {availableModels.map((m) => (
                          <div
                            key={m}
                            class={`repl-rs-setting-dropdown-item ${m === model ? 'active' : ''}`}
                            onClick={() => { setModel(m); setModelDropdownOpen(false); }}
                          >
                            <span>{m}</span>
                            {m === model && <IconCheck />}
                          </div>
                        ))}
                      </>
                    ) : (
                      <div class="repl-rs-setting-dropdown-item disabled">
                        {fetchingModels ? '正在获取模型列表...' : '暂无可用模型，请检查配置'}
                      </div>
                    )}
                  </div>
                )}
                <button class="repl-rs-btn-icon" onClick={handleRefreshModels} title="刷新模型列表" disabled={fetchingModels}>
                  {fetchingModels ? <IconSpinner /> : <IconRefresh />}
                </button>
              </div>
            </div>
            <div class="repl-rs-setting-row">
              <div class="repl-rs-setting-row-label">手动输入</div>
              <div class="repl-rs-setting-row-control">
                <input
                  value={model}
                  onInput={(event: any) => setModel(event.currentTarget.value)}
                  class="repl-rs-search-input repl-rs-input-w200"
                  placeholder="输入模型名称"
                />
              </div>
            </div>
          </div>
        </>
      )}

      {/* 保存按钮 */}
      <div class="repl-rs-settings-section">
        <div class="repl-rs-setting-row">
          <div class="repl-rs-setting-row-control repl-rs-gap-sm">
            <button class="repl-rs-setting-option primary" onClick={handleSave} disabled={saveStatus === 'saving'}>
              {saveStatus === 'saving' && <IconSpinner />}
              {saveStatus === 'saving' ? '保存中' : '保存配置'}
            </button>
            {saveStatus === 'saved' && <span class="repl-rs-setting-value good"><IconCheck /> 已保存</span>}
            {saveStatus === 'error' && <span class="repl-rs-setting-value warn">保存失败</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function withProviderMode(
  config: WorkbenchProviderConfigSnapshot,
  mode: WorkbenchProviderMode
): WorkbenchProviderConfigSnapshot {
  const credentialStatus = resolveCredentialStatus(mode, config.hasApiKey, config.accountCenterConfigured);
  return {
    ...config,
    credentialMode: mode,
    credentialStatus,
    statusText: statusText(credentialStatus, config.apiKeySource),
    updatedAt: new Date().toISOString(),
  };
}

function resolveCredentialStatus(
  mode: WorkbenchProviderMode,
  hasApiKey: boolean,
  accountCenterConfigured: WorkbenchAccountCenterConfigured
): import('../shared/workbench-contract').WorkbenchProviderCredentialStatus {
  if (mode === 'direct') return hasApiKey ? 'ready' : 'missing';
  if (accountCenterConfigured === true) return 'account-center-pending';
  if (accountCenterConfigured === false) return 'missing';
  return 'unknown';
}

function statusText(status: import('../shared/workbench-contract').WorkbenchProviderCredentialStatus, apiKeySource: WorkbenchApiKeySource): string {
  if (status === 'ready') return apiKeySource === 'env' ? '环境变量密钥可用' : 'API 密钥可用';
  if (status === 'account-center-pending') return '运行时将使用账户余额';
  if (status === 'unknown') return '账户中心状态未上报';
  return '需要配置 Provider 凭据';
}

function readProviderModePreference(): WorkbenchProviderMode | null {
  try {
    const value = localStorage.getItem(PROVIDER_MODE_STORAGE_KEY);
    return value === 'direct' || value === 'account-center' ? value : null;
  } catch {
    return null;
  }
}

function writeProviderModePreference(mode: WorkbenchProviderMode): void {
  try {
    localStorage.setItem(PROVIDER_MODE_STORAGE_KEY, mode);
  } catch { /* ignore */ }
}
