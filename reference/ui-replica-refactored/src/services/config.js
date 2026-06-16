/**
 * AppConfig — application configuration.
 */
export const AppConfig = {
  mode: 'demo',
  apiBaseUrl: '/api/v1',
  endpoints: {
    messages:  '/sessions/{id}/messages',
    tokens:    '/sessions/{id}/tokens',
    metrics:   '/sessions/{id}/metrics',
    plans:     '/sessions/{id}/plans',
    diffs:     '/sessions/{id}/diffs',
    usage:     '/usage/stats'
  }
};
