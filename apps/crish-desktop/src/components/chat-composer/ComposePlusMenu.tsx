import React, { useEffect, useMemo, useState } from 'react';

import styles from './ComposePlusMenu.module.css';
import { openSettings } from '../../api/storeAccess';
import { emitUiEvent } from '../../api/uiEvents';
import {
  SmartExpandablePanel,
  type MenuItem,
} from '../ui/SmartExpandablePanel';
import { listPluginCardStates } from '../settings-extensions/pluginRegistryAdapter';
import { AppIcon } from '../ui/icons/index';

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
  const [skills, setSkills] = useState<
    Array<{ id: string; name: string; desc?: string; cmd?: string }>
  >([
    {
      id: 'goal',
      name: '多轮推进 (/goal)',
      desc: '多轮推进直至完成',
      cmd: '/goal',
    },
    {
      id: 'learn',
      name: '规则学习 (/learn)',
      desc: '记住一条规则',
      cmd: '/learn',
    },
    {
      id: 'schedule',
      name: '定时任务 (/schedule)',
      desc: '定时自动化任务',
      cmd: '/schedule',
    },
    {
      id: 'browser',
      name: '浏览器预览 (/browser)',
      desc: '预览浏览器与调试',
      cmd: '/browser',
    },
    {
      id: 'teamwork',
      name: '团队协作 (/teamwork)',
      desc: '智能体协作看板',
      cmd: '/teamwork',
    },
  ]);

  const [plugins, setPlugins] = useState<
    Array<{ id: string; name: string; version?: string; desc?: string }>
  >([]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const { getSkillSlashCommandsCached } =
          await import('../../api/skillsApi');
        const res = await getSkillSlashCommandsCached();
        if (!active) return;
        if (res.skills && res.skills.length > 0) {
          setSkills(
            res.skills.map((s) => ({
              id: s.id || s.name,
              name: s.name,
              desc: s.description,
              cmd: `/skill:${s.name}`,
            }))
          );
        } else if (res.commands && res.commands.length > 0) {
          setSkills(
            res.commands.map((c) => ({
              id: c.cmd,
              name: c.cmd,
              desc: c.desc,
              cmd: c.cmd,
            }))
          );
        }
      } catch {
        /* fallback to default skills */
      }
    })();

    try {
      const pluginCards = listPluginCardStates();
      const enabledPlugins = pluginCards.filter((p) => p.enabled);
      if (active) {
        setPlugins(
          enabledPlugins.map((p) => ({
            id: p.id,
            name: p.name,
            version: p.version,
            desc: p.description,
          }))
        );
      }
    } catch {
      /* ignore */
    }

    return () => {
      active = false;
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
      ...skills.map((s) => ({
        id: `skill:${s.id}`,
        label: s.name,
        sublabel: s.desc,
        icon: <AppIcon name="sparkles" size={14} />,
        onSelect: () => handleSkillItemClick(s.cmd),
      })),
      {
        id: 'sep-skill-more',
        type: 'divider',
      },
      {
        id: 'action:manage-skills',
        label: '管理技能...',
        icon: <AppIcon name="settings" size={13} />,
        onSelect: () => {
          openSettings('skills');
        },
      },
    ];

    const pluginChildren: MenuItem[] = [
      ...(plugins.length > 0
        ? plugins.map((p) => ({
            id: `plugin:${p.id}`,
            label: p.name,
            sublabel: p.version ? `v${p.version}` : p.desc,
            icon: <AppIcon name="puzzle" size={14} />,
            onSelect: () => {
              openSettings('plugins');
            },
          }))
        : [
            {
              id: 'no-active-plugins',
              label: '暂无已启用插件',
              disabled: true,
              icon: <AppIcon name="info" size={14} />,
            },
          ]),
      {
        id: 'sep-plugin-more',
        type: 'divider',
      },
      {
        id: 'action:manage-plugins',
        label: '插件中心与配置...',
        icon: <AppIcon name="settings" size={13} />,
        onSelect: () => {
          openSettings('plugins');
        },
      },
    ];

    return [
      {
        id: 'file',
        label: '添加文件',
        sublabel: '图片、代码或文档',
        icon: <AppIcon name="paperclip" size={14} />,
        onSelect: () => {
          onAddFiles();
        },
      },
      {
        id: 'skill',
        type: 'submenu',
        closeOnSelect: true,
        label: '使用技能',
        sublabel: '键入 / 快速唤起技能',
        icon: <AppIcon name="sparkles" size={14} />,
        children: skillChildren,
        onSelect: () => {
          onInsertSkillSlash?.();
          queueMicrotask(() => restoreFocusRef?.current?.focus?.());
        },
      },
      {
        id: 'plugin',
        type: 'submenu',
        closeOnSelect: true,
        label: '插件',
        sublabel: '管理已安装插件',
        icon: <AppIcon name="puzzle" size={14} />,
        children: pluginChildren,
        onSelect: () => {
          openSettings('plugins');
        },
      },
      {
        id: 'mcp',
        label: 'MCP 工具',
        sublabel: '服务与协议连接',
        icon: <AppIcon name="cable" size={14} />,
        onSelect: () => {
          openSettings('plugins');
        },
      },
      {
        id: 'extensions',
        label: '扩展中心',
        sublabel: '发现与安装新工具',
        icon: <AppIcon name="blocks" size={14} />,
        onSelect: () => {
          openSettings('plugins');
        },
      },
      {
        id: 'schedule',
        label: '定时任务',
        sublabel: '计划执行与循环任务',
        icon: <AppIcon name="clock" size={14} />,
        onSelect: () => {
          emitUiEvent('open-scheduled');
        },
      },
    ];
  }, [
    skills,
    plugins,
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
