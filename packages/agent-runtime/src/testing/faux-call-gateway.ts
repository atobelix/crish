import type { AgentProvider } from "../types";
import type {
  ProviderGateway,
  ProviderGatewayPlan,
  ProviderRouteRequest,
  ProviderFactoryPlan,
  ProviderRouteResult,
  ProviderRouteHealth,
  AgentProviderFactory,
} from "../provider-gateway/types";

export interface RoutingDecision {
  method: "planRoute" | "resolveProvider" | "recordRouteResult";
  args: unknown[];
  timestamp: number;
}

export interface FauxCallGatewayOptions {
  defaultPlan?: ProviderGatewayPlan;
  defaultProvider?: AgentProvider | AgentProviderFactory;
}

export class FauxProviderCallGateway implements ProviderGateway {
  private plans = new Map<string, ProviderGatewayPlan>();
  private providers = new Map<string, AgentProvider | AgentProviderFactory>();
  private defaultPlan: ProviderGatewayPlan | undefined;
  private defaultProvider: AgentProvider | AgentProviderFactory | undefined;
  private decisions: RoutingDecision[] = [];

  constructor(options: FauxCallGatewayOptions = {}) {
    this.defaultPlan = options.defaultPlan;
    this.defaultProvider = options.defaultProvider;
  }

  setPlan(model: string, plan: ProviderGatewayPlan): void {
    this.plans.set(model, plan);
  }

  setProvider(
    model: string,
    provider: AgentProvider | AgentProviderFactory
  ): void {
    this.providers.set(model, provider);
  }

  setDefaultPlan(plan: ProviderGatewayPlan): void {
    this.defaultPlan = plan;
  }

  setDefaultProvider(
    provider: AgentProvider | AgentProviderFactory
  ): void {
    this.defaultProvider = provider;
  }

  getDecisions(): readonly RoutingDecision[] {
    return this.decisions;
  }

  clearDecisions(): void {
    this.decisions = [];
  }

  reset(): void {
    this.plans.clear();
    this.providers.clear();
    this.defaultPlan = undefined;
    this.defaultProvider = undefined;
    this.decisions = [];
  }

  async planRoute(
    request: ProviderRouteRequest
  ): Promise<ProviderGatewayPlan> {
    this.record("planRoute", [request]);
    const plan = this.plans.get(request.model) ?? this.defaultPlan;
    if (!plan) {
      throw new ProviderGatewayPlanNotFoundError(request.model);
    }
    return plan;
  }

  async resolveProvider(
    request: ProviderRouteRequest
  ): Promise<AgentProvider | ProviderFactoryPlan> {
    this.record("resolveProvider", [request]);
    const provider = this.providers.get(request.model) ?? this.defaultProvider;
    if (!provider) {
      throw new ProviderGatewayProviderNotFoundError(request.model);
    }
    return typeof provider === "function"
      ? (provider as AgentProviderFactory)({
          kind: "provider-factory-plan",
          route: {
            routeId: "faux-route",
            providerId: "faux-provider",
            requestedModel: request.model,
            model: request.model,
            upstreamModel: request.model,
            priority: 0,
            routingWeight: 1,
            healthScore: 1,
            fallback: false,
            credentialSourceType: "api-key",
            credentialSource: {
              type: "api-key",
              providerId: "faux-provider",
            },
          },
          credential: {
            id: "faux-cred",
            source: "api-key",
            providerId: "faux-provider",
            apiKey: "sk-faux-key",
          },
        })
      : provider;
  }

  recordRouteResult(
    result: ProviderRouteResult
  ): ProviderRouteHealth | void {
    this.record("recordRouteResult", [result]);
  }

  private record(method: RoutingDecision["method"], args: unknown[]): void {
    this.decisions.push({ method, args, timestamp: Date.now() });
  }
}

export class ProviderGatewayPlanNotFoundError extends Error {
  readonly model: string;
  constructor(model: string) {
    super(`No plan found for model: ${model}`);
    this.name = "ProviderGatewayPlanNotFoundError";
    this.model = model;
  }
}

export class ProviderGatewayProviderNotFoundError extends Error {
  readonly model: string;
  constructor(model: string) {
    super(`No provider found for model: ${model}`);
    this.name = "ProviderGatewayProviderNotFoundError";
    this.model = model;
  }
}
