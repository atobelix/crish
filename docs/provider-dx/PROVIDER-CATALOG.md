# Provider Catalog

Complete list of all built-in providers supported in Conex.

## Legend

| Column | Meaning |
|--------|---------|
| Engine | Protocol engine: `openai-compatible`, `anthropic-messages`, `ollama` |
| Auth | Authentication method and header |
| tool | Tool/function calling support |
| vision | Image input support |
| reasoning | Thinking/reasoning support |
| streaming | SSE streaming support |
| dyn | Dynamic model list (fetched from API) |

---

## OpenAI-Compatible Engine (33 providers)

### Tier 1 — Major Commercial

| # | Provider | Models | tool | vision | reasoning | Auth | Notes |
|---|----------|--------|:----:|:------:|:---------:|------|-------|
| 1 | **OpenAI** | `gpt-4o`, `gpt-4o-mini`, `o3-mini`, `gpt-4.1` | ✅ | ✅ | ✅ | Bearer Token | Endpoint auto-selects chat-completions/responses; `max_completion_tokens` field |
| 2 | **DeepSeek** | `deepseek-chat`, `deepseek-reasoner` | ✅ | ❌ | ✅ | Bearer Token | Uses `max_tokens` field; reasoning via `text-delta` |
| 3 | **Anthropic** (OC proxy) | `claude-sonnet-4`, `claude-4`, `claude-3.5-haiku` | ✅ | ✅ | ✅ | `x-api-key` | Native via anthropic-messages engine; also usable via OC gateway |
| 4 | **Google Gemini** | `gemini-2.5-flash`, `gemini-2.0-flash`, `gemini-1.5-flash` | ✅ | ✅ | ✅ | `x-goog-api-key` | Via OpenAI-compatible endpoint at `generativelanguage.googleapis.com` |
| 5 | **xAI** | `grok-4.3`, `grok-4.3-mini`, `grok-4.3-vision` | ✅ | ✅ | ✅ | Bearer Token | |
| 6 | **Mistral** | `mistral-large`, `mistral-small`, `codestral` | ✅ | ❌ | ✅ | Bearer Token | Largest context 256K (codestral) |

### Tier 2 — Hosted Platforms

| # | Provider | Models | tool | vision | reasoning | Auth | Notes |
|---|----------|--------|:----:|:------:|:---------:|------|-------|
| 7 | **Groq** | `llama-3.3-70b`, `mixtral-8x7b`, `gemma2-9b` | ✅ | ❌ | ✅ | Bearer Token | Very low latency |
| 8 | **Together AI** | `Llama-3.3-70B`, `DeepSeek-V3`, `Mixtral-8x22B` | ✅ | ❌ | ✅ | Bearer Token | Hosted open-source |
| 9 | **Fireworks AI** | `llama-v3p3-70b`, `deepseek-v3` | ✅ | ❌ | ✅ | Bearer Token | Fast inference platform |
| 10 | **Perplexity** | `sonar-pro`, `sonar`, `sonar-deep-research` | ✅ | ❌ | ✅ | Bearer Token | Web-search capable models |
| 11 | **OpenRouter** | Dynamic (proxy) | ✅ | ✅ | ✅ | Bearer Token | Proxies 200+ models; `dynamic_models: true` |
| 12 | **GitHub Models** | `gpt-4o`, `gpt-4o-mini`, `DeepSeek-V3`, `phi-4`, `mistral-large` | ✅ | ✅ | ✅ | Bearer Token | Free rate-limited; uses `GITHUB_TOKEN` |

### Tier 3 — Chinese Market

| # | Provider | Models | tool | vision | reasoning | Auth | Notes |
|---|----------|--------|:----:|:------:|:---------:|------|-------|
| 13 | **Qwen (Tongyi Qianwen)** | `qwen-max`, `qwen-plus`, `qwen-turbo`, `qwen-vl-max` | ✅ | ✅ | ✅ | Bearer Key | Alibaba Cloud; `dashscope.aliyuncs.com` |
| 14 | **Qwen Portal** | `qwen-max`, `qwen-plus`, `qwen-turbo` | ✅ | ✅ | ✅ | Bearer Key | qwen.ai portal endpoint |
| 15 | **Doubao (ByteDance)** | `doubao-pro`, `doubao-lite` | ✅ | ❌ | ✅ | Bearer Key | ark.cn-beijing.volces.com |
| 16 | **Baichuan** | `baichuan4`, `baichuan3-turbo` | ✅ | ❌ | ❌ | Bearer Key | baichuan-ai.com |
| 17 | **Yi (01.AI)** | `yi-lightning`, `yi-large` | ✅ | ❌ | ✅ | Bearer Key | api.lingyiwanwu.com |
| 18 | **Moonshot (Kimi)** | `moonshot-v1`, `moonshot-v1-8k`, `moonshot-v1-32k`, `moonshot-v1-128k` | ✅ | ❌ | ❌ | Bearer Key | api.moonshot.cn |
| 19 | **Zhipu AI (GLM)** | `glm-4-plus`, `glm-4`, `glm-4v` | ✅ | ✅ | ✅ | Bearer Key | open.bigmodel.cn |
| 20 | **Stepfun (Step)** | `step-2`, `step-1v` | ✅ | ✅ | ✅ | Bearer Key | api.stepfun.com |
| 21 | **MiniMax** | `abab6.5`, `abab5.5` | ✅ | ❌ | ❌ | Bearer Key | api.minimax.chat |
| 22 | **SenseTime (SenseNova)** | `SenseChat-5`, `SenseChat-1201` | ✅ | ✅ | ❌ | Bearer Key | api.sensenova.cn |
| 23 | **Netease (Youdao)** | `youdao-chat` | ✅ | ❌ | ❌ | Bearer Key | oai.nos-eastchina.com |
| 24 | **Tencent Hunyuan** | `hunyuan-large`, `hunyuan-standard` | ✅ | ✅ | ❌ | Bearer Key | api.hunyuan.cloud.tencent.com |
| 25 | **Baidu Qianfan** | `ERNIE-4.0`, `ERNIE-3.5`, `ERNIE-Speed` | ✅ | ✅ | ❌ | Bearer Key | qianfan.baidubce.com |

### Tier 4 — Niche / Specialized

| # | Provider | Models | tool | vision | reasoning | Auth | Notes |
|---|----------|--------|:----:|:------:|:---------:|------|-------|
| 26 | **Anyscale** | `meta-llama/Llama-3.3-70B` | ✅ | ❌ | ❌ | Bearer Token | |
| 27 | **Replicate** | `meta/meta-llama-3.1-405b` | ✅ | ✅ | ❌ | Bearer Token | |
| 28 | **Hugging Face** | `meta-llama/Llama-3.3-70B` | ✅ | ❌ | ❌ | Bearer Token | `huggingface.co` TGI endpoint |
| 29 | **Cohere** | `command-r-plus`, `command-r` | ✅ | ❌ | ❌ | Bearer Token | `api.cohere.ai` |
| 30 | **AI21 Labs** | `jamba-1.5-mini`, `jamba-1.5-large` | ✅ | ❌ | ❌ | Bearer Token | |
| 31 | **Writer** | `palmyra-x-004`, `palmyra-x-003` | ✅ | ❌ | ✅ | Bearer Token | |
| 32 | **Cerebras** | `cerebras-111b` | ❌ | ❌ | ❌ | Bearer Token | |
| 33 | **SambaNova** | `Meta-Llama-3.3-70B` | ✅ | ❌ | ❌ | Bearer Token | |

## Anthropic-Messages Engine (1 provider)

| # | Provider | Models | tool | vision | reasoning | Auth | Notes |
|---|----------|--------|:----:|:------:|:---------:|------|-------|
| 34 | **Anthropic** (native) | `claude-sonnet-4`, `claude-4`, `claude-3.5-haiku` | ✅ | ✅ | ✅ | `x-api-key` | Native Messages API; thinking support; prompt caching |

## Ollama Engine (local)

| # | Provider | Models | tool | vision | reasoning | Auth | Notes |
|---|----------|--------|:----:|:------:|:---------:|------|-------|
| 35 | **Ollama** (local) | `llama3`, `qwen2.5`, `mistral`, etc | ✅ | ✅ | ❌ | None | Local `localhost:11434`; no auth needed |

---

## Provider Capability Matrix

### Communication Capabilities

| Provider | tool | vision | reasoning | streaming | systemPrompt | jsonMode | parallelToolCalls |
|----------|:----:|:------:|:---------:|:---------:|:------------:|:--------:|:-----------------:|
| OpenAI | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Anthropic (native) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| DeepSeek | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Google Gemini | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| xAI (Grok) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Mistral | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Groq | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Together | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Fireworks | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Perplexity | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ❌ |
| OpenRouter | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| GitHub Models | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Ollama (local) | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ | ❌ |
| Qwen | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Zhipu (GLM) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

### Auth Methods

| Method | Header | Providers |
|--------|--------|-----------|
| Bearer Token | `Authorization: Bearer <key>` | OpenAI, DeepSeek, Groq, Together, Fireworks, Perplexity, OpenRouter, Mistral, xAI, Qwen, etc |
| x-api-key | `x-api-key: <key>` | Anthropic (native, OC proxy) |
| x-goog-api-key | `x-goog-api-key: <key>` | Google Gemini |
| GitHub Token | `Authorization: Bearer <token>` | GitHub Models |
| None | — | Ollama (local) |

### Engine Options Per Provider

| Provider | authHeader | maxTokensField | reasoningContent |
|----------|------------|----------------|------------------|
| OpenAI | `authorization` | `max_completion_tokens` | `thought-delta` |
| Anthropic | `x-api-key` | `max_tokens` | `text-delta` |
| DeepSeek | `authorization` | `max_tokens` | `text-delta` |
| Google Gemini | `x-goog-api-key` | `max_output_tokens` | `text-delta` |
| All OC others | `authorization` | `max_tokens` | `omit` |
| Ollama | — | — | — |

---

## Engine Distribution

| Engine | Provider Count | % |
|--------|:--------------:|:-:|
| `openai-compatible` | 33 | 94% |
| `anthropic-messages` | 1 | 3% |
| `ollama` | 1 | 3% |

---

## Quick Reference: Environment Variables

| Provider | Env Variable |
|----------|-------------|
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Google Gemini | `GOOGLE_GEMINI_API_KEY` |
| xAI | `XAI_API_KEY` |
| Mistral | `MISTRAL_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Together | `TOGETHER_API_KEY` |
| Fireworks | `FIREWORKS_API_KEY` |
| Perplexity | `PERPLEXITY_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| GitHub Models | `GITHUB_TOKEN` |
| Qwen | `QWEN_API_KEY` |
| Moonshot | `MOONSHOT_API_KEY` |
| Zhipu | `ZHIPU_API_KEY` |
| Baichuan | `BAICHUAN_API_KEY` |
| Yi | `YI_API_KEY` |
| Doubao | `DOUBAO_API_KEY` |
| Hunyuan | `HUNYUAN_API_KEY` |
| Baidu | `BAIDU_API_KEY` |
| Stepfun | `STEPFUN_API_KEY` |
| MiniMax | `MINIMAX_API_KEY` |
| SenseTime | `SENSETIME_API_KEY` |

> Custom env vars follow: `CONEX_SECRET_<UPPERCASE_PROVIDER_ID>_API_KEY`
