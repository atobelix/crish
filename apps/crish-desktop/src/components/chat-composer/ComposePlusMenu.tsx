import React, { useEffect, useMemo, useState } from 'react';

import styles from './ComposePlusMenu.module.css';
import { openSettings } from '../../api/storeAccess';
import { navigateToSurface } from '../../store/storeAccess';
import { useI18n } from '../../i18n';
import { SmartExpandablePanel, type MenuItem } from '@/components/ui';
import { AppIcon } from '@/components/ui/icons';

export interface ComposePlusMenuProps {
  open: boolean;
  onClose: () => void;
  onAddFiles: () => void;
  /** 插入技能斜杠提示到输入框 */
  onInsertSkillSlash?: () => void;
  /** 点击具体技能时直接插入该技能命令 */
  onSelectSkillCommand?: (cmd: string) => void;
  id?: string;
  restoreFocusRef?: React.RefObject<HTMLElement | null>;
}

export const ComposePlusMenu: React.FC<ComposePlusMenuProps> = ({
  open,
  onClose,
  onAddFiles,
  onInsertSkillSlash,
  onSelectSkillCommand,
  restoreFocusRef,
}) => {
  const { t } = useI18n();
  const [skills, setSkills] = useState<
    Array<{ id: string; name: string; cmd?: string }>
  >([]);

  useEffect(() => {
    let active = true;

    const loadSkills = async (force = false) => {
      try {
        const { getSkillSlashCommandsCached } =
          await import('../../api/skillsApi');
        const res = await getSkillSlashCommandsCached(force);
        if (!active) return;
        const list = (res.commands || []).map((c) => ({
          id: c.skillId || c.cmd,
          name: c.skillName || c.cmd.replace(/^\/skill:/, ''),
          cmd: c.cmd,
        }));
        setSkills(list);
      } catch {
        if (active) setSkills([]);
      }
    };

    void loadSkills(open);

    const onSkillsChanged = () => {
      void loadSkills(true);
    };

    window.addEventListener('crish-skills-changed', onSkillsChanged);
    return () => {
      active = false;
      window.removeEventListener('crish-skills-changed', onSkillsChanged);
    };
  }, [open]);

  const menuItems = useMemo<MenuItem[]>(() => {
    const handleSkillItemClick = (cmd?: string) => {
      if (cmd && onSelectSkillCommand) {
        onSelectSkillCommand(cmd);
      } else {
        onInsertSkillSlash?.();
      }
      queueMicrotask(() => restoreFocusRef?.current?.focus?.());
    };

    const skillChildren: MenuItem[] = [
      ...(skills.length > 0
        ? skills.map((s) => ({
            id: `skill:${s.id}`,
            label: s.name,
            icon: <AppIcon name="sparkles" size={14} />,
            onSelect: () => handleSkillItemClick(s.cmd),
          }))
        : [
            {
              id: 'no-skills',
              label: t('chat.plusMenu.noSkills', '暂无已启用的技能'),
              disabled: true,
            },
          ]),
      {
        id: 'sep-skill-more',
        type: 'divider',
      },
      {
        id: 'action:manage-skills',
        label: t('chat.plusMenu.manageSkills', '管理技能...'),
        icon: <AppIcon name="settings" size={13} />,
        onSelect: () => {
          openSettings('skills');
          navigateToSurface('extensions');
        },
      },
    ];

    return [
      {
        id: 'file',
        label: t('chat.plusMenu.addFiles', '添加文件或附件'),
        icon: <AppIcon name="paperclip" size={14} />,
        onSelect: () => {
          onAddFiles();
        },
      },
      {
        id: 'skill',
        type: 'submenu',
        closeOnSelect: true,
        label: t('chat.plusMenu.useSkill'),
        icon: <AppIcon name="sparkles" size={14} />,
        children: skillChildren,
        onSelect: () => {
          onInsertSkillSlash?.();
          queueMicrotask(() => restoreFocusRef?.current?.focus?.());
        },
      },
    ];
  }, [
    t,
    skills,
    onAddFiles,
    onInsertSkillSlash,
    onSelectSkillCommand,
    restoreFocusRef,
  ]);

  if (!open) return null;

  return (
    <SmartExpandablePanel
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      anchor={restoreFocusRef}
      items={menuItems}
      enableSearch={false}
      position={{ align: 'start', side: 'top', sideOffset: 6 }}
      className={`${styles.plusMenu} no-drag`}
    />
  );
};
