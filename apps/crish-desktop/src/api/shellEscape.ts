export function escapeShellArg(arg: string): string {
  if (arg === '') return '""';
  let s = String(arg).replace(/[\r\n]+/g, ' ');
  s = s.replace(/[<>|&;()$`%!^]/g, '');
  s = s.replace(/"/g, '""');
  return `"${s}"`;
}
