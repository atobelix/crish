export const action: Record<string, string> = {
  'common.report_bug': 'Please try again or report the issue.',
  'provider.check_network':
    'Service is temporarily unavailable. Please try again later.',
  'provider.check_key': 'Please check the API key in Settings.',
  'provider.retry': 'Please retry.',
  'tool.aborted_before_dispatch':
    'The request was aborted by the user or control bus; no retry is needed.',
  'tool.cancelled':
    'A sibling tool failed or the batch was cancelled; execution was skipped.',
  'tool.outcome_unknown':
    'Recovery synthesized the unfinished call after restart; continue the session.',
};

export default action;
