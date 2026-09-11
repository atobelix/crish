/**
 * 协议模板（中立，不绑第三方 URL）：
 * 仅用于「添加服务商」时选择首要通信协议；Base URL / 名称由用户填写。
 * 产品不绑定任何官方或第三方预置域名。
 */
export type ProviderProtocolTemplateId =
  | 'openai/chat'
  | 'openai/responses'
  | 'anthropic/messages';

export interface ProtocolTemplate {
  id: string;
  /** 显示名（中立，不带厂商名） */
  name: string;
  protocol: ProviderProtocolTemplateId;
  /** 占位提示 */
  placeholder: string;
}

export const PROTOCOL_TEMPLATES: ProtocolTemplate[] = [
  {
    id: 'tpl-openai-chat',
    name: 'OpenAI Chat 协议',
    protocol: 'openai/chat',
    placeholder: 'https://api.example.com/v1',
  },
  {
    id: 'tpl-openai-responses',
    name: 'OpenAI Responses 协议',
    protocol: 'openai/responses',
    placeholder: 'https://api.example.com/v1',
  },
  {
    id: 'tpl-anthropic-messages',
    name: 'Anthropic Messages 协议',
    protocol: 'anthropic/messages',
    placeholder: 'https://api.example.com',
  },
];
