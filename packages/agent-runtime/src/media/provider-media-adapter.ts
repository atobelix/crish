import type { AgentMessageBlock, JsonObject } from '@crish/shared-types';
import type {
  NormalizedMedia,
  ProviderFamily,
  ToolResultMediaOutput,
} from './media-types';

interface MediaBlockExtension {
  type: string;
  source?: { type: string; data?: string; url?: string; fileId?: string };
  mimeType?: string;
  file_data?: { mime_type: string; file_uri: string };
}

function isMediaBlock(block: AgentMessageBlock): boolean {
  const t = (block as MediaBlockExtension).type;
  return t === 'image' || t === 'media';
}

function asMediaBlock(block: AgentMessageBlock): AgentMessageBlock & MediaBlockExtension {
  return block as AgentMessageBlock & MediaBlockExtension;
}

export class ProviderMediaAdapter {
  adaptForProvider(media: NormalizedMedia, family: ProviderFamily): JsonObject {
    switch (family) {
      case 'anthropic':
        return this.toAnthropic(media);
      case 'openai-chat':
        return this.toOpenAIChat(media);
      case 'openai-responses':
        return this.toOpenAIResponses(media);
      case 'gemini':
        return this.toGemini(media);
      case 'bedrock':
        return this.toBedrock(media);
      default:
        throw new Error(`Unsupported provider family: ${family}`);
    }
  }

  processToolResultMedia(
    blocks: AgentMessageBlock[],
    family: ProviderFamily,
    _toolUseId: string,
  ): ToolResultMediaOutput {
    const hasMedia = blocks.some(isMediaBlock);
    if (!hasMedia) {
      return { type: 'inline', blocks };
    }

    switch (family) {
      case 'anthropic':
        return { type: 'inline', blocks };

      case 'openai-chat': {
        const textBlocks = blocks.filter((b) => !isMediaBlock(b));
        const mediaBlocks = blocks.filter(isMediaBlock);
        return {
          type: 'split',
          blocks: textBlocks,
          mediaMessages: mediaBlocks.map((block) => ({
            role: 'user' as const,
            content: [this.adaptBlock(block, 'openai-chat')],
          })),
        };
      }

      case 'openai-responses':
        return { type: 'inline', blocks };

      case 'gemini': {
        const fileDataBlocks: AgentMessageBlock[] = [];
        const restBlocks: AgentMessageBlock[] = [];
        for (const block of blocks) {
          if (isMediaBlock(block)) {
            const ext = asMediaBlock(block);
            fileDataBlocks.push({
              type: 'file_data',
              file_data: {
                mime_type: ext.mimeType ?? 'image/jpeg',
                file_uri: ext.source?.url ?? '',
              },
            } as unknown as AgentMessageBlock);
          } else {
            restBlocks.push(block);
          }
        }
        return {
          type: 'inline',
          blocks: [...restBlocks, ...fileDataBlocks],
        };
      }

      default:
        return { type: 'inline', blocks };
    }
  }

  private toAnthropic(media: NormalizedMedia): JsonObject {
    if (media.type === 'image') {
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: media.mimeType,
          data: media.data,
        },
      };
    }
    throw new Error(`Anthropic does not support media type: ${media.type}`);
  }

  private toOpenAIChat(media: NormalizedMedia): JsonObject {
    if (media.type === 'image') {
      return {
        type: 'image_url',
        image_url: {
          url: media.source === 'base64'
            ? `data:${media.mimeType};base64,${media.data}`
            : media.data,
        },
      };
    }
    throw new Error(`OpenAI Chat does not support media type: ${media.type}`);
  }

  private toOpenAIResponses(media: NormalizedMedia): JsonObject {
    if (media.type === 'image') {
      return {
        type: 'input_image',
        image_url: media.source === 'base64'
          ? `data:${media.mimeType};base64,${media.data}`
          : media.data,
      };
    }
    throw new Error(`OpenAI Responses does not support media type: ${media.type}`);
  }

  private toGemini(media: NormalizedMedia): JsonObject {
    if (media.type === 'image') {
      if (media.source === 'url') {
        return {
          type: 'file_data',
          file_data: {
            mime_type: media.mimeType,
            file_uri: media.data,
          },
        };
      }
      return {
        type: 'inline_data',
        inline_data: {
          mime_type: media.mimeType,
          data: media.data,
        },
      };
    }
    throw new Error(`Gemini does not support media type: ${media.type}`);
  }

  private toBedrock(media: NormalizedMedia): JsonObject {
    if (media.type === 'image') {
      return {
        type: 'image',
        source: { bytes: media.data },
        format: media.mimeType.split('/')[1] ?? 'jpeg',
      };
    }
    throw new Error(`Bedrock does not support media type: ${media.type}`);
  }

  private adaptBlock(block: AgentMessageBlock, family: ProviderFamily): AgentMessageBlock {
    const ext = asMediaBlock(block);

    if (family === 'openai-chat') {
      return {
        type: 'text',
        text: '',
        content: [
          { type: 'text', text: '' },
          {
            type: 'image_url',
            image_url: {
              url: ext.source?.data
                ? `data:${ext.mimeType ?? 'image/jpeg'};base64,${ext.source.data}`
                : ext.source?.url ?? '',
            },
          },
        ],
      } as unknown as AgentMessageBlock;
    }

    return block;
  }
}
