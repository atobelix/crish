let isPrimaryPanelCheck: (panelId: string) => boolean = () => false;

export function setPrimaryPanelChecker(
  check: (panelId: string) => boolean
): void {
  isPrimaryPanelCheck = check;
}

export function isPrimaryPanel(panelId: string): boolean {
  return isPrimaryPanelCheck(panelId);
}
