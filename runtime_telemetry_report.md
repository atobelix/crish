# Runtime Telemetry & Verification Report

> Generated at: 2026-07-22T19:43:16.814Z

## 🎯 Autonomous Efficiency & Ratio Metric (目标: 无限接近 0)

- **Total User Prompts Sent (用户提示数):** 11
- **Total AI Tool Invocations (AI 工具调用总次数):** 703
- **Ratio (用户消息数 / AI 工具调用数):** `0.0156`  *(目标 ➔ 0)*
- **Total AI Autonomous Duration (AI 自主工作持续时长):** 1672449 ms (27.87 分钟)

## 📊 LLM Token Consumption Summary

- **Total Tokens Consumed:** 6900341
- **Prompt Tokens:** 6774961
- **Completion Tokens:** 125380

## ⏱ Performance & Action Bottlenecks

| Action Name | Invocation Count | Avg Duration (ms) | Max Duration (ms) | Tokens Used |
|---|---|---|---|---|
| `switch_session` | 1 | 12.00 | 12 | - |
| `send_message` | 1 | 45.00 | 45 | - |
| `tool_call_execution` | 1 | 120.00 | 120 | - |
| `virtual_scroll_render` | 1 | 8.00 | 8 | - |
| `llm_api_completion` | 4 | 5976.00 | 6843 | 1897 (P:497 / C:1400) |
| `llm_api_completion_max_thinking` | 4 | 11509.00 | 12454 | 3761 (P:561 / C:3200) |
| `real_agent_workload` | 9 | 2766.33 | 3143 | 15652 (P:14130 / C:1522) |
| `real_endless_agent_workload` | 93 | 5162.65 | 26166 | 180130 (P:134117 / C:46013) |
| `heavy_multi_agent_analysis` | 48 | 5657.02 | 29775 | 1280350 (P:1256331 / C:24019) |
| `long_horizon_single_session_turn` | 132 | 2717.70 | 10956 | 1028862 (P:1008947 / C:19915) |
| `deep_tool_chain_step` | 150 | 3113.51 | 8230 | 4389689 (P:4360378 / C:29311) |

## 🚨 Error Telemetry Summary

**Total Errors Captured:** 0

