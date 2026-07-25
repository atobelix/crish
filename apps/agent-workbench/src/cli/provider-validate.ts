import { readFile } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import type { ProviderDefinition, ValidationResult } from "./provider-types";

const VALID_ENGINES = ["openai-compatible", "anthropic", "gemini"];
const VALID_AUTH_METHODS = ["bearer", "api-key", "basic", "aws-sig-v4", "azure-api-key", "oauth2", "custom", "chain", "none"];
const VALID_ENDPOINTS = ["auto", "chat-completions", "responses"];
const VALID_TRANSPORTS = ["fetch", "rust-reqwest", "auto"];

function isUrl(str: string): boolean {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

function isValidModelId(id: string): boolean {
  return /^[a-z0-9][a-z0-9._/-]+[a-z0-9]$/i.test(id);
}

export async function validateProviderCommand(filePath: string, options: {
  strict?: boolean;
  network?: boolean;
}): Promise<ValidationResult> {
  const resolvedPath = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
  const result: ValidationResult = {
    file: resolvedPath,
    passed: true,
    checks: [],
    networkChecks: [],
  };

  console.log(`\n╭─ 验证 Provider 配置: ${filePath} ─────────────────────╮\n`);

  // 1. 文件存在性
  if (!existsSync(resolvedPath)) {
    result.checks.push({ name: "文件存在性", passed: false, message: `文件不存在: ${resolvedPath}` });
    result.passed = false;
    printCheck(false, "文件存在", `文件不存在: ${resolvedPath}`);
    return result;
  }
  printCheck(true, "文件存在", resolvedPath);

  // 2. JSON 语法
  let raw: string;
  let parsed: ProviderDefinition;
  try {
    raw = await readFile(resolvedPath, "utf8");
    parsed = JSON.parse(raw) as ProviderDefinition;
    printCheck(true, "JSON 语法", "合法");
  } catch (error) {
    result.checks.push({ name: "JSON 语法", passed: false, message: `JSON 解析失败: ${error}` });
    result.passed = false;
    printCheck(false, "JSON 语法", `解析失败: ${error}`);
    return result;
  }

  // Schema 版本
  if (!parsed.version || parsed.version !== "1.0") {
    result.checks.push({ name: "Schema 版本", passed: false, message: `版本不匹配: ${parsed.version ?? "无"}` });
    result.passed = false;
    printCheck(false, "Schema 版本", `当前版本: ${parsed.version ?? "无"}, 期望: 1.0`);
  } else {
    printCheck(true, "Schema 版本", parsed.version);
  }

  // 3. 必填字段
  const requiredFields: [string, unknown, string?][] = [
    ["id", parsed.id, "必填, 全小写字母+连字符"],
    ["name", parsed.name, "必填, 显示名称"],
    ["engine", parsed.engine, `必填, 合法值: ${VALID_ENGINES.join(", ")}`],
    ["baseUrl", parsed.baseUrl, "必填, 有效 URL"],
    ["auth", parsed.auth, "必填, 认证配置"],
    ["defaultModel", parsed.defaultModel, "必填, 默认模型 ID"],
  ];

  for (const [field, value, hint] of requiredFields) {
    if (!value) {
      result.checks.push({ name: `必填字段 ${field}`, passed: false, message: hint ?? "缺失" });
      result.passed = false;
      printCheck(false, `${field}`, `${hint ?? "缺失"}`);
    } else {
      printCheck(true, `${field}`, `${String(value).slice(0, 60)}`);
    }
  }

  // 4. engine 合法性
  if (parsed.engine && !VALID_ENGINES.includes(parsed.engine)) {
    result.checks.push({ name: "engine", passed: false, message: `非法引擎: ${parsed.engine}` });
    result.passed = false;
    printCheck(false, "engine", `非法值: ${parsed.engine}, 合法: ${VALID_ENGINES.join(", ")}`);
  }

  // 5. baseUrl 格式
  if (parsed.baseUrl && !isUrl(parsed.baseUrl)) {
    result.checks.push({ name: "baseUrl 格式", passed: false, message: `非有效 URL: ${parsed.baseUrl}` });
    result.passed = false;
    printCheck(false, "baseUrl 格式", `非有效 URL`);
  }

  // 6. auth.method 合法性
  if (parsed.auth?.method && !VALID_AUTH_METHODS.includes(parsed.auth.method)) {
    result.checks.push({ name: "auth.method", passed: false, message: `非法认证方式: ${parsed.auth.method}` });
    result.passed = false;
    printCheck(false, "auth.method", `非法值: ${parsed.auth.method}`);
  }

  // 7. 认证配置完整性
  const auth = parsed.auth ?? {} as ProviderDefinition["auth"];
  if (auth.method && auth.method !== "none") {
    const hasKey = !!(auth.apiKey ?? (auth.apiKeyEnv ? process.env[auth.apiKeyEnv] : undefined) ?? auth.apiKeyFile);
    if (!hasKey && auth.method !== "oauth2" && auth.method !== "custom") {
      result.checks.push({ name: "auth 密钥", passed: false, message: "未配置 API Key (apiKey/apiKeyEnv/apiKeyFile)" });
      result.passed = false;
      printCheck(false, "auth 密钥可用", "未找到有效密钥来源");
    } else {
      printCheck(true, "auth 密钥可用", auth.apiKeyEnv ? `环境变量 ${auth.apiKeyEnv}` : "直接配置");
    }
  } else {
    printCheck(true, "auth 密钥", "无需认证");
  }

  // 8. defaultModel 格式
  if (parsed.defaultModel && !isValidModelId(parsed.defaultModel)) {
    result.checks.push({ name: "defaultModel 格式", passed: false, message: `模型 ID 格式可能非法: ${parsed.defaultModel}` });
    result.passed = false;
    printCheck(false, "defaultModel 格式", `"${parsed.defaultModel}" 格式异常`);
  }

  // 9. endpoint 合法性
  if (parsed.endpoint && !VALID_ENDPOINTS.includes(parsed.endpoint)) {
    result.checks.push({ name: "endpoint", passed: false, message: `非法 endpoint: ${parsed.endpoint}` });
    result.passed = false;
    printCheck(false, "endpoint", `非法值: ${parsed.endpoint}`);
  } else if (parsed.endpoint && parsed.engine !== "openai-compatible") {
    result.checks.push({ name: "endpoint 兼容性", passed: false, message: `engine=${parsed.engine} 不应设置 endpoint` });
    result.passed = false;
    printCheck(false, "endpoint 兼容", `engine=${parsed.engine} 不需要 endpoint 字段`);
  }

  // 10. transport 合法性
  if (parsed.transport && !VALID_TRANSPORTS.includes(parsed.transport)) {
    result.checks.push({ name: "transport", passed: false, message: `非法 transport: ${parsed.transport}` });
    result.passed = false;
    printCheck(false, "transport", `非法值: ${parsed.transport}`);
  }

  // 11. 字段值语义检查
  if (parsed.timeout !== undefined && (parsed.timeout < 1000 || parsed.timeout > 600000)) {
    result.checks.push({ name: "timeout 范围", passed: false, message: `timeout 超出合理范围: ${parsed.timeout}` });
    result.passed = false;
    printCheck(false, "timeout 范围", `${parsed.timeout}ms (建议 1000-600000)`);
  }

  // 12. tags 格式
  if (parsed.tags && !Array.isArray(parsed.tags)) {
    result.checks.push({ name: "tags 格式", passed: false, message: "tags 应为字符串数组" });
    result.passed = false;
    printCheck(false, "tags 格式", "应为字符串数组");
  }

  // 13. 引擎特有检查
  if (parsed.engine === "anthropic" && !parsed.anthropicVersion) {
    result.checks.push({ name: "anthropicVersion", passed: false, message: "Anthropic 引擎建议设置 anthropicVersion" });
    printCheck(false, "anthropicVersion", "建议设置 (如 2023-06-01)");
  }

  if (parsed.engine === "gemini" && parsed.authViaQuery === undefined) {
    result.checks.push({ name: "authViaQuery", passed: false, message: "Gemini 引擎建议显式设置 authViaQuery" });
    printCheck(false, "authViaQuery", "建议显式设置 (true/false)");
  }

  // 网络检查
  if (options.network !== false) {
    console.log("\n  ── 网络检查 ──\n");
    await runNetworkChecks(parsed, result);
  }

  console.log(`\n  ${result.passed ? "✔ 验证通过!" : "✗ 验证未通过"}`);
  if (result.passed) {
    console.log("\n  提示: 运行 crish provider test <id> 进行深度测试");
  }

  return result;
}

async function runNetworkChecks(config: ProviderDefinition, result: ValidationResult): Promise<void> {
  const baseUrl = `${config.baseUrl}${config.pathPrefix ?? "/v1"}`;

  // 检查 baseUrl 可达性
  try {
    const authHeader = buildValidateAuthHeader(config.auth);
    const start = Date.now();
    const response = await fetch(`${baseUrl}/models`, {
      headers: { accept: "application/json", ...authHeader },
      signal: AbortSignal.timeout(10000),
    });
    const latency = Date.now() - start;
    result.networkChecks!.push({ name: "baseUrl 可达", passed: true, message: `HTTP ${response.status} (${latency}ms)` });
    printCheck(true, "baseUrl 可达", `HTTP ${response.status} (${latency}ms)`);

    if (response.ok) {
      result.networkChecks!.push({ name: "认证有效", passed: true, message: "成功" });
      printCheck(true, "认证有效", "成功");

      const body = await response.json() as { data?: unknown[] };
      if (Array.isArray(body.data)) {
        result.networkChecks!.push({ name: "模型列表", passed: true, message: `${body.data.length} 个模型` });
        printCheck(true, "模型列表", `${body.data.length} 个模型`);
      }
    } else if (response.status === 401 || response.status === 403) {
      result.networkChecks!.push({ name: "认证有效", passed: false, message: `HTTP ${response.status}` });
      result.passed = false;
      printCheck(false, "认证有效", `HTTP ${response.status} - 认证失败`);
    }
  } catch (error) {
    result.networkChecks!.push({
      name: "baseUrl 可达",
      passed: false,
      message: `连接失败: ${error instanceof Error ? error.message : String(error)}`,
    });
    result.passed = false;
    printCheck(false, "baseUrl 可达", `连接失败`);
  }
}

function buildValidateAuthHeader(auth: ProviderDefinition["auth"]): Record<string, string> {
  if (!auth || auth.method === "none") return {};
  let key = auth.apiKey;
  if (auth.apiKeyEnv && !key) {
    key = process.env[auth.apiKeyEnv];
  }

  switch (auth.method) {
    case "bearer":
      return { authorization: `Bearer ${key ?? ""}` };
    case "api-key":
      return { [auth.keyHeader ?? "x-api-key"]: key ?? "" };
    case "azure-api-key":
      return { [auth.azureHeader ?? "api-key"]: key ?? "" };
    case "basic":
      return { authorization: `Basic ${Buffer.from(`${auth.username ?? ""}:${key ?? ""}`).toString("base64")}` };
    default:
      return {};
  }
}

function printCheck(passed: boolean, name: string, message: string): void {
  const icon = passed ? "✓" : "✗";
  console.log(`  ${icon} ${name}: ${message}`);
}
