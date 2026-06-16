import { AppConfig } from './config.js';

/**
 * DataProvider — abstract data layer.
 * Supports 'demo' (mock) and 'api' (real fetch) modes.
 */
export const DataProvider = (() => {
  const isDemo = AppConfig.mode === 'demo';

  function demoFetch(url, opts) {
    return Promise.resolve({ ok: true, json: () => Promise.resolve(opts._mock || {}) });
  }

  function apiFetch(url, opts) {
    return fetch(AppConfig.apiBaseUrl + url, opts);
  }

  function buildUrl(template, params) {
    let url = template;
    for (const k in params) url = url.replace(`{${k}}`, params[k]);
    return url;
  }

  return {
    fetchMessages(sessionId) {
      const url = buildUrl(AppConfig.endpoints.messages, { id: sessionId });
      if (isDemo) return demoFetch(url, { _mock: [] }).then(r => r.json());
      return apiFetch(url).then(r => r.json());
    },
    fetchTokenMetrics(sessionId, opts) {
      const url = buildUrl(AppConfig.endpoints.metrics, { id: sessionId })
        + `?range=${opts?.range || '7d'}&granularity=${opts?.granularity || 'auto'}`;
      if (isDemo) return demoFetch(url, { _mock: MockData.tokenMetrics }).then(r => r.json());
      return apiFetch(url).then(r => r.json());
    },
    fetchUsageStats(opts) {
      const url = AppConfig.endpoints.usage
        + `?scope=${opts?.scope || 'global'}&range=${opts?.range || '30d'}`;
      if (isDemo) return demoFetch(url, { _mock: MockData.usageStats }).then(r => r.json());
      return apiFetch(url).then(r => r.json());
    }
  };
})();
