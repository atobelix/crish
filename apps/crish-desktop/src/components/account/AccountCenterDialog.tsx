/**
 * 登录弹窗（仅登录前流程）：760×480 左右分栏，左侧品牌栏固定，右栏随步骤交叉淡入。
 * 由设置「账户」分区的「登录」打开；登录成功后自动关闭，账号管理回到设置弹窗内。
 */
import { useEffect } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { AppIcon, Button, Dialog, Tooltip, cn } from '../ui';
import { useI18n } from '../../i18n';
import { useAuthField } from '../../store/storeAccess';
import { useAccountUiStore } from '../../store/accountUiStore';
import { AccountAuthStep } from './AccountAuthPanes';
import { useAccountAuthFlow } from './useAccountAuthFlow';
import controls from './accountControls.module.css';
import styles from './accountAuth.module.css';

/** 步骤交叉淡入：220ms，cubic-bezier(0.32, 0.72, 0, 1)（设计稿 step 动效） */
const STEP_EASE: [number, number, number, number] = [0.32, 0.72, 0, 1];
const STEP_TRANSITION = { duration: 0.22, ease: STEP_EASE };

/** 品牌标：深色方块 + 开口圆弧 + 品牌绿点 */
function AccountMark() {
  return (
    <span className={styles.mark} aria-hidden="true">
      <svg className={styles.markSvg} viewBox="0 0 24 24" fill="none">
        <path
          className={styles.markArc}
          d="M16.6 7.4A6.5 6.5 0 1 0 16.6 16.6"
          strokeWidth={2.4}
          strokeLinecap="round"
        />
        <circle className={styles.markDot} cx={18.5} cy={12} r={1.6} />
      </svg>
    </span>
  );
}

export function AccountCenterDialog() {
  const { t } = useI18n();
  const open = useAccountUiStore((state) => state.loginOpen);
  const closeLogin = useAccountUiStore((state) => state.closeLogin);
  const isLoggedIn = useAuthField((state) => state.isLoggedIn);
  const flow = useAccountAuthFlow(closeLogin);
  const { reset } = flow;

  // 关闭后重置流程，下次打开从邮箱步骤开始
  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  return (
    <Dialog
      open={open && !isLoggedIn}
      onClose={closeLogin}
      ariaLabel={t('settings.account.auth.dialogLabel')}
      showCloseButton={false}
      classNames={{
        panel: cn(controls.dialogPanel, styles.panel),
        overlay: controls.scrim,
        body: styles.body,
      }}
    >
      <div className={styles.split}>
        <div className={styles.brand}>
          <AccountMark />
          <span className={styles.brandName}>
            {t('settings.account.auth.brandName')}
          </span>
        </div>
        <div className={styles.main}>
          <AnimatePresence initial={false}>
            <m.div
              key={flow.step}
              className={styles.stage}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={STEP_TRANSITION}
            >
              <AccountAuthStep flow={flow} />
            </m.div>
          </AnimatePresence>
          <div className={cn(styles.corner, styles.cornerEnd)}>
            <Tooltip content={t('settings.account.close')}>
              <Button
                variant="unstyled"
                type="button"
                className={controls.iconButton}
                aria-label={t('settings.account.close')}
                onClick={closeLogin}
              >
                <AppIcon name="x" size={16} />
              </Button>
            </Tooltip>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
