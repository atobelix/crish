const STORAGE_KEY_DONE = 'crish_first_run_done';

export function isFirstRunDone(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY_DONE) === '1';
  } catch {
    return false;
  }
}
