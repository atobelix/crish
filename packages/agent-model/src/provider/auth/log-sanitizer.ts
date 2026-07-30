const SENSITIVE_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/g,
  /sk-ant-[a-zA-Z0-9]{20,}/g,
  /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g,
  /Bearer\s+[a-zA-Z0-9_-]{20,}/gi,
  /x-api-key:\s*[a-zA-Z0-9]{20,}/gi,
  /api-key:\s*[a-zA-Z0-9]{20,}/gi,
];

export function sanitizeForLog(input: string): string {
  let sanitized = input;
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, (match) => {
      if (match.length <= 8) return '***';
      return match.slice(0, 4) + '***' + match.slice(-4);
    });
  }
  return sanitized;
}

export function sanitizeHeaders(
  headers: Record<string, string>
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (
      lower === 'authorization' ||
      lower === 'x-api-key' ||
      lower === 'api-key' ||
      value.startsWith('sk-')
    ) {
      sanitized[key] = sanitizeForLog(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}
