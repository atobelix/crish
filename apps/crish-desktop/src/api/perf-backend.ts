/**
 * Performance backend bridge.
 * Auto-selects Rust (Tauri) or JS fallback for compute-intensive operations.
 */

// Properly typed invoke: matches @tauri-apps/api/core's generic invoke<T>
type InvokeFn = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

let _invokeFn: InvokeFn | null = null;

async function getInvoke(): Promise<InvokeFn | null> {
  if (_invokeFn !== null) return _invokeFn;
  try {
    const mod = await import('@tauri-apps/api/core');
    _invokeFn = (mod?.invoke as InvokeFn) || null;
  } catch {
    _invokeFn = null;
  }
  return _invokeFn;
}

/** Compute SHA-256 hash, returns hex string. Falls back to Web Crypto API. */
export async function sha256(data: Uint8Array): Promise<string> {
  const invoke = await getInvoke();
  if (invoke) {
    try {
      return await invoke<string>('perf_hash_compute', {
        data: Array.from(data),
        algorithm: 'sha256',
      });
    } catch {
      // fall through to JS fallback
    }
  }
  // JS fallback using Web Crypto API
  const hash = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Base64 encode bytes. Falls back to btoa. */
export async function base64Encode(
  data: Uint8Array,
  config: 'standard' | 'url_safe' = 'standard',
): Promise<string> {
  const invoke = await getInvoke();
  if (invoke) {
    try {
      return await invoke<string>('perf_base64_encode', {
        data: Array.from(data),
        config,
      });
    } catch {
      // fall through
    }
  }
  // JS fallback
  const binStr = Array.from(data).map(b => String.fromCodePoint(b)).join('');
  if (config === 'url_safe') {
    return btoa(binStr).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  return btoa(binStr);
}

/** Base64 decode string to bytes. Falls back to atob. */
export async function base64Decode(
  encoded: string,
  config: 'standard' | 'url_safe' = 'standard',
): Promise<Uint8Array> {
  const invoke = await getInvoke();
  if (invoke) {
    try {
      const result = await invoke<number[]>('perf_base64_decode', {
        encoded,
        config,
      });
      return new Uint8Array(result);
    } catch {
      // fall through
    }
  }
  // JS fallback
  let normalized = encoded;
  if (config === 'url_safe') {
    normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
    while (normalized.length % 4 !== 0) normalized += '=';
  }
  const binStr = atob(normalized);
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) {
    bytes[i] = binStr.charCodeAt(i);
  }
  return bytes;
}

/** Detect encoding of byte data. Falls back to UTF-8 guess. */
export async function detectEncoding(
  data: Uint8Array,
): Promise<{ encoding: string; confidence: number }> {
  const invoke = await getInvoke();
  if (invoke) {
    try {
      const result = await invoke<{
        encoding: string;
        confidence: number;
        hasBom: boolean;
      }>('perf_encoding_detect', {
        data: Array.from(data),
      });
      return { encoding: result.encoding, confidence: result.confidence };
    } catch {
      // fall through
    }
  }
  // JS fallback: try TextDecoder, fall back to UTF-8 guess
  try {
    const decoder = new TextDecoder('utf-8', { fatal: false });
    decoder.decode(data);
    return { encoding: 'utf-8', confidence: 0.5 };
  } catch {
    return { encoding: 'utf-8', confidence: 0.5 };
  }
}

/** Decode bytes to string using optional encoding. Auto-detects if not specified. */
export async function decodeEncoding(
  data: Uint8Array,
  encoding?: string,
): Promise<string> {
  const invoke = await getInvoke();
  if (invoke) {
    try {
      return await invoke<string>('perf_encoding_decode', {
        data: Array.from(data),
        encoding: encoding ?? null,
      });
    } catch {
      // fall through
    }
  }
  // JS fallback
  const decoder = new TextDecoder(encoding || 'utf-8', { fatal: false });
  return decoder.decode(data);
}
