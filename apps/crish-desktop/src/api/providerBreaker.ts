import { CircuitBreaker } from "@crish/shared-utils/browser";
import type { CircuitBreakerState } from "@crish/shared-utils/browser";

const STORAGE_KEY = "crish_provider_breaker_states_v1";
const breakers = new Map<string, CircuitBreaker>();

export function getBreaker(route: string): CircuitBreaker {
  if (!breakers.has(route)) {
    breakers.set(route, new CircuitBreaker(5, 30000));
  }
  return breakers.get(route)!;
}

export function persistBreakerStates(): void {
  const states: Record<string, CircuitBreakerState> = {};
  for (const [route, breaker] of breakers) {
    states[route] = breaker.toJSON();
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(states));
  } catch {
    // localStorage may be full or unavailable
  }
}

export function loadBreakerStates(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const states: Record<string, CircuitBreakerState> = JSON.parse(raw);
    for (const [route, state] of Object.entries(states)) {
      breakers.set(route, CircuitBreaker.fromJSON(state));
    }
  } catch {
    // corrupted data or unavailable storage
  }
}

export function resetBreaker(route: string): void {
  breakers.delete(route);
}
