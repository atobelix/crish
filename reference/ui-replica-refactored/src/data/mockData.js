/**
 * MockData — centralized demo data for all feature modules.
 */
export const MockData = {
  tokenMetrics: {
    totalUsed: 4253109,
    limit: 10000000,
    cachedInput: 2500000,
    input: 1250000,
    cachedOutput: 300000,
    output: 203109,
    modelCalls: [
      { name: 'GPT-4', calls: 3847, color: '#3b82f6' },
      { name: 'Gemini', calls: 5120, color: '#10b981' },
      { name: 'Claude', calls: 1820, color: '#8b5cf6' },
      { name: 'GPT-3.5', calls: 2060, color: '#f97316' }
    ],
    hourlyTokens: Array.from({ length: 12 }, (_, i) => ({
      hour: i, input: 30 + Math.floor(Math.random() * 25),
      output: Math.floor(Math.random() * 12), cached: i % 3 === 0 ? 8 : 0
    })),
    ratePoints: [
      { x: 0, y: 55 }, { x: 1, y: 42 }, { x: 2, y: 35 },
      { x: 3, y: 28 }, { x: 4, y: 22 }, { x: 5, y: 18 },
      { x: 6, y: 25 }, { x: 7, y: 15 }, { x: 8, y: 20 }
    ],
    costPoints: [
      { x: 0, y: 52 }, { x: 1, y: 50 }, { x: 2, y: 45 },
      { x: 3, y: 42 }, { x: 4, y: 48 }, { x: 5, y: 44 },
      { x: 6, y: 38 }, { x: 7, y: 40 }, { x: 8, y: 35 }
    ]
  },

  usageStats: {
    totalCalls: 12847,
    totalTokens: 4250000,
    estimatedCost: 2.13,
    activeModels: 4,
    modelBreakdown: [
      { name: 'GPT-4', value: 40, color: '#3b82f6' },
      { name: 'Gemini', value: 55, color: '#10b981' },
      { name: 'Claude', value: 35, color: '#8b5cf6' },
      { name: 'GPT-3.5', value: 30, color: '#f97316' },
      { name: 'Other', value: 45, color: '#fb923c' }
    ],
    projectCosts: [
      { name: 'mycodex-demo / build todo list', tokens: '1.2M' },
      { name: 'mycodex-demo / refactor auth', tokens: '892K' },
      { name: 'conex / setup chat', tokens: '2.1M' }
    ]
  }
};
