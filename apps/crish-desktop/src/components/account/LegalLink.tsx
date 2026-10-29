/**
 * 用户协议 / 隐私政策链接：地址缺失时退化为纯文本，绝不出现可点的空链接。
 */
import { invokeResult } from '../../api/tauriInvoke';
import { logInternalError } from '../../api/userFacingErrors';
import { LEGAL_LINKS } from '../../config/legalLinks';
import { useI18n } from '../../i18n';
import { Button } from '../ui';
import styles from './accountAuth.module.css';

interface LegalLinkProps {
  kind: keyof typeof LEGAL_LINKS;
}

export function LegalLink({ kind }: LegalLinkProps) {
  const { t } = useI18n();
  const url = LEGAL_LINKS[kind];
  const label = t(
    kind === 'terms'
      ? 'settings.account.auth.termsUser'
      : 'settings.account.auth.termsPrivacy'
  );

  if (!url) return <span className={styles.termsLink}>{label}</span>;

  const open = () => {
    void invokeResult('workbench_open_external_url', { url })
      .then((result) => {
        if (result.status !== 'ok') {
          logInternalError(
            'legalLink',
            result.status === 'missing'
              ? 'workbench_open_external_url missing'
              : result.message
          );
        }
      })
      .catch((error: unknown) => {
        logInternalError(
          'legalLink',
          error instanceof Error ? error.message : String(error)
        );
      });
  };

  return (
    <Button
      variant="unstyled"
      type="button"
      className={styles.termsButton}
      onClick={open}
    >
      {label}
    </Button>
  );
}
