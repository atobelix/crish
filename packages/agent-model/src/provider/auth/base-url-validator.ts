import { URL } from 'node:url';

let allowTestLocalhost =
  typeof process !== 'undefined' &&
  (process.env['ALLOW_TEST_LOCALHOST'] === '1' ||
    process.env['ALLOW_TEST_LOCALHOST'] === 'true' ||
    process.env['VITEST'] === 'true' ||
    process.env['NODE_ENV'] === 'test');

export function setAllowTestLocalhost(val: boolean): void {
  allowTestLocalhost = val;
}

export function isTestLocalhostAllowed(): boolean {
  return allowTestLocalhost;
}

const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^169\.254\./,
];

const PRIVATE_IPV6_PATTERNS = [/^::1$/, /^fc00:/, /^fe80:/];

const FORBIDDEN_HOSTNAMES = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  'metadata.google.internal',
  '169.254.169.254',
];

const FORBIDDEN_IPV6_HOSTNAMES = ['::1'];

const ALLOWED_SCHEMES = ['https:', 'http:'];

function stripIPv6Brackets(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export function validateBaseUrl(urlString: string): ValidationResult {
  try {
    const parsed = new URL(urlString);

    if (!ALLOWED_SCHEMES.includes(parsed.protocol)) {
      return {
        valid: false,
        error: `Unsupported protocol: ${parsed.protocol}. Only http and https are allowed.`,
      };
    }

    const rawHostname = parsed.hostname;
    if (!rawHostname) {
      return { valid: false, error: 'URL must have a hostname' };
    }

    if (allowTestLocalhost) {
      return { valid: true };
    }

    const hostname = rawHostname.toLowerCase();

    if (FORBIDDEN_HOSTNAMES.includes(hostname)) {
      return { valid: false, error: `Forbidden hostname: ${hostname}` };
    }

    if (PRIVATE_IP_PATTERNS.some((p) => p.test(hostname))) {
      return {
        valid: false,
        error: `Private IP ranges are not allowed: ${hostname}`,
      };
    }

    const inner = stripIPv6Brackets(hostname);

    if (FORBIDDEN_IPV6_HOSTNAMES.includes(inner)) {
      return { valid: false, error: `Forbidden hostname: ${hostname}` };
    }

    if (PRIVATE_IPV6_PATTERNS.some((p) => p.test(inner))) {
      return {
        valid: false,
        error: `Private IP ranges are not allowed: ${hostname}`,
      };
    }

    return { valid: true };
  } catch (err) {
    return { valid: false, error: `Invalid URL: ${(err as Error).message}` };
  }
}
