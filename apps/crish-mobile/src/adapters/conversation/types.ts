// 统一对话屏引擎适配接口（移动界面统一方案 §2.1）：
// ConversationScreen 只按能力面渲染，不按设备/模式写 if；引擎差异
// （远端会话 / 本地线程）全部收进实现本接口的适配器。
// 盘面事实补项（与方案接口的两处微差，U1 交接登记）：
// - composer.voice：语音输入接线（端侧能力，两引擎一致，方案 §6 已定性，
//   接口清单漏列）——Composer 的 voice prop 数据面，不传 = 无语音；
// - renderComposerLead：Composer 上方、键盘贴合区内的引擎专属行槽位
//   （远端 = 未送达行 + 排队行 + 离线出口 + 已选附件条；本地 = 排队行），
//   方案接口未设此槽，但这些行的呈现位置在 Composer 宿主区内、
//   无法归入 renderSheets（排队行/未送达行为批 C ②/03-4 补项）。
import type { ReactNode } from 'react';
import type { TimelineBlock } from '@/presentation/timeline/buildTimeline';
import type {
  ComposerContextBar,
  ComposerModelControl,
} from '@/presentation/ui/Composer';
import type { DropdownMenuEntry } from '@/presentation/ui/DropdownMenu';
import type { VoiceInputApi } from '@/adapters/asr/useVoiceInput';
import type { ComposerAttachment } from '@/domain/pure/attachments';

export interface ConversationEngine {
  kind: 'remote' | 'local';
  /** 会话/线程 id（路由与 store 键） */
  id: string;
  /** 顶栏标题（已截断/修剪的呈现值；null = 宿主回落缺省标题） */
  title: string | null;
  /** 统一块流（TimelineView 的输入） */
  blocks: readonly TimelineBlock[];
  /** 生成/发送忙态 */
  busy: boolean;
  /** 引擎可用性（远端 = 连接态派生；本地恒 true——离线可用是其本质） */
  available: boolean;
  /**
   * 顶部错误面（远端 = composer feedback error；本地 = 线程 error 槽）。
   * detail / onDismiss 为本地错误槽的预留面，U1 宿主只呈现 message。
   */
  error: { message: string; detail?: string; onDismiss?: () => void } | null;
  /** 停止生成（引擎声明有无；缺失则不渲染——不造假钮） */
  stop?: () => void;
  composer: {
    prompt: string;
    setPrompt: (t: string) => void;
    submit: () => void;
    submitText: (t: string) => void | Promise<boolean>;
    /** 带附件提交（远端专有；本地不提供） */
    submitWithAttachments?: (
      rawText: string,
      attachments: readonly ComposerAttachment[],
      visionSupported: boolean
    ) => Promise<boolean>;
    canSubmit: boolean;
    editable: boolean;
    /** 审批锁定（远端专有语义；本地恒 false） */
    locked: boolean;
    placeholder: string;
    /** 选择行：远端注入真实工作区/权限；本地不注入（undefined = 不渲染，Composer 既有契约） */
    contextBar?: ComposerContextBar;
    /** 模型钮：两引擎都必备，落点不同（远端 = 全局 ModelSheet；本地 = LocalModelSheet） */
    modelControl: ComposerModelControl;
    /** 附件钮：远端 = 附件 Sheet；本地 = 诚实提示（U2 接线） */
    onAttachPress: () => void;
    hasAttachments: boolean;
    /** 语音输入接线（盘面事实补项，见文件头注） */
    voice?: VoiceInputApi;
  };
  /** more 菜单条目（引擎组装） */
  menuEntries: DropdownMenuEntry[];
  /** 空态（title 透传 TimelineView 空态标题；其余字段供 U2 本地未配置引导消费） */
  emptyState: {
    title: string;
    hint?: string;
    actionLabel?: string;
    onAction?: () => void;
  };
  /** 引擎专属浮层宿主（远端 = 工作区/权限/模型/附件/技能 Sheet 群 + 会话操作层） */
  renderSheets: () => ReactNode;
  /** Composer 上方引擎专属行（盘面事实补项，见文件头注）；缺省 = 无 */
  renderComposerLead?: () => ReactNode;
}
