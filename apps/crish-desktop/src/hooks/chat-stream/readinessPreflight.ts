import { domainUserMessage, type ErrorDomain } from '../../api/userFacingErrors';
import { routeModelPickerPreflight } from '../../api/modelPickerAvailability';

export interface ReadinessFailureCallbacks {
  setPickerInlineError: (message: string) => void;
  onOpenModelPicker?: () => void;
}

export function routeReadinessFailure(
  domain: ErrorDomain | null,
  callbacks: ReadinessFailureCallbacks,
): boolean {
  if (!domain) return false;
  if (routeModelPickerPreflight(domain, callbacks)) return true;
  callbacks.setPickerInlineError(domainUserMessage(domain));
  return true;
}
