import { ErrorClassifier, ErrorDomain, type ErrorClassifierOptions } from "./error-classifier";

export interface ErrorClassificationInput {
  message: string;
  status?: number;
  code?: string;
  headers?: Record<string, string>;
}

export interface ErrorClassificationOutput {
  kind: "rate_limit" | "auth_error" | "timeout" | "server_error" | "invalid_request" | "unknown";
  retryable: boolean;
}

export interface ClassificationStrategy {
  classify(input: ErrorClassificationInput): ErrorClassificationOutput | null;
}

type Kind = ErrorClassificationOutput["kind"];

const DEFAULT_RETRYABLE: Record<Kind, boolean> = {
  rate_limit: true,
  auth_error: false,
  timeout: true,
  server_error: true,
  invalid_request: false,
  unknown: false,
};

export class ProviderErrorClassifier {
  private strategies: ClassificationStrategy[] = [];

  constructor() {
    this.strategies.push(new DefaultClassificationStrategy());
  }

  classify(input: ErrorClassificationInput): ErrorClassificationOutput {
    for (const strategy of this.strategies) {
      const result = strategy.classify(input);
      if (result !== null) return result;
    }
    return { kind: "unknown", retryable: false };
  }

  registerStrategy(strategy: ClassificationStrategy): void {
    this.strategies.unshift(strategy);
  }
}

class DefaultClassificationStrategy implements ClassificationStrategy {
  classify(input: ErrorClassificationInput): ErrorClassificationOutput | null {
    const err = new Error(input.message);
    const opts: Record<string, unknown> = {};
    if (input.status !== undefined) opts.status = input.status;
    if (input.headers) opts.headers = toHeaders(input.headers);
    const classified = ErrorClassifier.classify(err, opts as ErrorClassifierOptions);

    const kind = domainToKind(classified.domain, input.message);
    return {
      kind,
      retryable: classified.domain === ErrorDomain.CLIENT_INVALID_INPUT && "context_length_exceeded" === classified.subType
        ? true
        : DEFAULT_RETRYABLE[kind] ?? false,
    };
  }
}

function domainToKind(domain: ErrorDomain, message: string): Kind {
  const lower = message.toLowerCase();
  switch (domain) {
    case ErrorDomain.RATE_LIMIT:
      return "rate_limit";
    case ErrorDomain.CLIENT_AUTH:
      return "auth_error";
    case ErrorDomain.TRANSIENT_NETWORK:
      return /timeout|timed out/i.test(lower) ? "timeout" : "unknown";
    case ErrorDomain.TRANSIENT_SERVER:
      return "server_error";
    case ErrorDomain.CLIENT_INVALID_INPUT:
    case ErrorDomain.QUOTA_EXHAUSTED:
    case ErrorDomain.ENDPOINT_UNAVAILABLE:
    case ErrorDomain.GATEWAY_CHALLENGE:
      return "invalid_request";
    case ErrorDomain.USER_ABORT:
      return "unknown";
    case ErrorDomain.STREAM_INTERRUPT:
      return "unknown";
    default:
      return "unknown";
  }
}

function toHeaders(record: Record<string, string>): Headers {
  const h = new Headers();
  for (const [key, value] of Object.entries(record)) {
    h.set(key, value);
  }
  return h;
}
