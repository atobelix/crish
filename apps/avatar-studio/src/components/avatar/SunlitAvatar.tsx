import React from 'react';
import type { PaletteDef } from '../../constants/palettes';
import type { ArchetypeId } from '../../constants/archetypes';

export interface SunlitAvatarProps {
  archetype: ArchetypeId;
  palette: PaletteDef;
  size?: number;
  frame?: 'circle' | 'rounded' | 'square';
  tiltX?: number; // -15 to 15 deg
  tiltY?: number; // -15 to 15 deg
  showShadow?: boolean;
  className?: string;
  onClick?: () => void;
}

export const SunlitAvatar: React.FC<SunlitAvatarProps> = ({
  archetype,
  palette,
  size = 120,
  frame = 'circle',
  tiltX = 0,
  tiltY = 0,
  showShadow = true,
  className = '',
  onClick,
}) => {
  const borderRadius =
    frame === 'circle' ? '50%' : frame === 'rounded' ? '22%' : '0%';

  const renderSubject = () => {
    switch (archetype) {
      case 'pure-cloud':
        return (
          <g transform="translate(20, 26)">
            {/* 柔和阴影 */}
            <path
              d="M32 58 C18 58 8 48 8 36 C8 26 16 18 26 16 C29 8 38 2 48 2 C60 2 70 10 73 20 C76 18 80 18 84 18 C94 18 102 26 102 36 C102 48 92 58 80 58 Z"
              fill={palette.shadow}
              transform="translate(0, 4)"
            />
            {/* 纯白主云朵 */}
            <path
              d="M32 56 C18 56 8 46 8 34 C8 24 16 16 26 14 C29 6 38 0 48 0 C60 0 70 8 73 18 C76 16 80 16 84 16 C94 16 102 24 102 34 C102 46 92 56 80 56 Z"
              fill={palette.primary}
            />
            {/* 底部柔和反光切面 */}
            <path
              d="M14 38 C14 47 22 54 32 54 L78 54 C88 54 96 47 96 38 C90 42 80 44 70 44 C50 44 40 38 24 38 C19 38 16 38 14 38 Z"
              fill={palette.secondary}
              opacity="0.6"
            />
            {/* 萌系黑豆眼与微腮红 */}
            <circle cx="45" cy="27" r="4.5" fill="#1C1F26" />
            <circle cx="65" cy="27" r="4.5" fill="#1C1F26" />
            <circle cx="46.5" cy="25.5" r="1.5" fill="#FFFFFF" />
            <circle cx="66.5" cy="25.5" r="1.5" fill="#FFFFFF" />
            <ellipse cx="37" cy="33" rx="4" ry="2.2" fill={palette.accent} opacity="0.65" />
            <ellipse cx="73" cy="33" rx="4" ry="2.2" fill={palette.accent} opacity="0.65" />
          </g>
        );

      case 'milk-biscuit':
        return (
          <g transform="translate(18, 14)">
            {/* 等角桌布阴影 */}
            <polygon
              points="55,94 106,64 55,34 4,64"
              fill={palette.shadow}
              transform="translate(0, 3)"
            />
            {/* 柔和等角桌布 */}
            <polygon
              points="55,92 104,63 55,34 6,63"
              fill={palette.primary}
            />
            {/* 格纹点缀 */}
            <path
              d="M26,51 L75,80 M42,42 L91,71 M38,73 L87,44 M22,63 L71,34"
              stroke={palette.accent}
              strokeWidth="2.5"
              strokeDasharray="4 4"
              opacity="0.75"
            />
            {/* 饼干盘子与曲奇 */}
            <ellipse cx="36" cy="62" rx="14" ry="8" fill={palette.secondary} />
            <ellipse cx="34" cy="61" rx="6.5" ry="4" fill="#D7A15C" />
            <circle cx="33" cy="60" r="1" fill="#794B1B" />
            <circle cx="36" cy="61.5" r="0.8" fill="#794B1B" />
            {/* 白瓷牛奶瓶 */}
            <g transform="translate(56, 26)">
              {/* 瓶身阴影 */}
              <ellipse cx="14" cy="40" rx="9" ry="4.5" fill={palette.shadow} />
              {/* 瓶身主体 */}
              <path
                d="M8,12 L8,36 C8,40 20,40 20,36 L20,12 C20,9 17,7 16,5 L16,2 L12,2 L12,5 C11,7 8,9 8,12 Z"
                fill="#FFFFFF"
                stroke={palette.secondary}
                strokeWidth="1"
              />
              {/* 牛奶高度与高光 */}
              <path
                d="M9,18 L9,35 C9,38 19,38 19,35 L19,18 C17,19 11,19 9,18 Z"
                fill="#F0F7FF"
              />
              <line x1="11" y1="14" x2="11" y2="34" stroke="#FFFFFF" strokeWidth="1.5" strokeLinecap="round" />
            </g>
          </g>
        );

      case 'sand-castle':
        return (
          <g transform="translate(14, 16)">
            {/* 浅金沙滩底座 */}
            <ellipse cx="56" cy="84" rx="46" ry="16" fill={palette.primary} />
            <ellipse cx="56" cy="84" rx="42" ry="14" fill="#FFE082" opacity="0.6" />
            {/* 城堡阴影 */}
            <path
              d="M26,80 L26,48 L36,48 L36,54 L44,54 L44,48 L68,48 L68,54 L76,54 L76,48 L86,48 L86,80 Z"
              fill={palette.shadow}
              transform="translate(0, 3)"
            />
            {/* 城堡主体 */}
            <path
              d="M26,78 L26,46 L34,46 L34,51 L42,51 L42,46 L70,46 L70,51 L78,51 L78,46 L86,46 L86,78 Z"
              fill={palette.primary}
            />
            {/* 拱门 */}
            <path
              d="M50,78 L50,62 C50,58 62,58 62,62 L62,78 Z"
              fill={palette.shadow}
            />
            {/* 尖顶与红旗 */}
            <polygon points="56,30 46,46 66,46" fill="#FFCA28" />
            <line x1="56" y1="30" x2="56" y2="20" stroke="#FFFFFF" strokeWidth="2" />
            <polygon points="56,20 68,24 56,28" fill={palette.accent} />
            {/* 柔和白浪花 */}
            <path
              d="M12,88 Q28,84 44,89 T76,87 T102,89"
              fill="none"
              stroke="#FFFFFF"
              strokeWidth="2.5"
              strokeLinecap="round"
              opacity="0.8"
            />
          </g>
        );

      case 'retro-walkman':
        return (
          <g transform="translate(18, 12)">
            {/* 随身听阴影 */}
            <rect x="26" y="32" width="56" height="66" rx="9" fill={palette.shadow} transform="translate(0, 4)" />
            {/* 随身听机身 */}
            <rect x="24" y="30" width="56" height="66" rx="8" fill={palette.primary} />
            {/* 磁带透明视窗 */}
            <rect x="32" y="40" width="40" height="26" rx="4" fill="#1E293B" />
            <circle cx="42" cy="53" r="5.5" fill="#FFFFFF" opacity="0.9" />
            <circle cx="62" cy="53" r="5.5" fill="#FFFFFF" opacity="0.9" />
            <circle cx="42" cy="53" r="2.5" fill="#1E293B" />
            <circle cx="62" cy="53" r="2.5" fill="#1E293B" />
            <line x1="42" y1="53" x2="62" y2="53" stroke={palette.accent} strokeWidth="1.5" />
            {/* 侧边按键 */}
            <rect x="78" y="44" width="4" height="10" rx="1" fill={palette.secondary} />
            <rect x="78" y="58" width="4" height="10" rx="1" fill={palette.secondary} />
            {/* 红色耳机环绕 */}
            <path
              d="M16,46 C16,18 88,18 88,46"
              fill="none"
              stroke={palette.secondary}
              strokeWidth="3.5"
              strokeLinecap="round"
            />
            <rect x="11" y="44" width="9" height="15" rx="4" fill={palette.secondary} />
            <rect x="84" y="44" width="9" height="15" rx="4" fill={palette.secondary} />
            <path
              d="M20,58 Q32,86 46,74"
              fill="none"
              stroke="#FFFFFF"
              strokeWidth="2"
              opacity="0.8"
            />
          </g>
        );

      case 'grand-piano':
        return (
          <g transform="translate(16, 14)">
            {/* 蔚蓝海岸浪花地面 */}
            <ellipse cx="54" cy="86" rx="44" ry="14" fill={palette.accent} opacity="0.45" />
            <ellipse cx="54" cy="85" rx="38" ry="11" fill="#FFE082" />
            {/* 钢琴投影 */}
            <polygon points="30,76 78,76 86,52 36,52" fill={palette.shadow} transform="translate(0, 3)" />
            {/* 纯白钢琴主体 */}
            <polygon points="28,74 76,74 84,48 36,48" fill={palette.primary} />
            {/* 钢琴支架/开盖 */}
            <polygon points="36,48 76,26 84,48" fill="#F8FAFC" />
            <line x1="56" y1="36" x2="64" y2="54" stroke="#64748B" strokeWidth="2" />
            {/* 黑白琴键 */}
            <rect x="32" y="70" width="40" height="5" fill="#FFFFFF" stroke="#0F172A" strokeWidth="0.8" />
            <line x1="38" y1="70" x2="38" y2="73" stroke="#0F172A" strokeWidth="1.2" />
            <line x1="44" y1="70" x2="44" y2="73" stroke="#0F172A" strokeWidth="1.2" />
            <line x1="52" y1="70" x2="52" y2="73" stroke="#0F172A" strokeWidth="1.2" />
            <line x1="58" y1="70" x2="58" y2="73" stroke="#0F172A" strokeWidth="1.2" />
            <line x1="64" y1="70" x2="64" y2="73" stroke="#0F172A" strokeWidth="1.2" />
            {/* 琴腿 */}
            <line x1="32" y1="74" x2="32" y2="82" stroke={palette.primary} strokeWidth="2.5" />
            <line x1="72" y1="74" x2="72" y2="82" stroke={palette.primary} strokeWidth="2.5" />
            <line x1="80" y1="50" x2="80" y2="60" stroke={palette.primary} strokeWidth="2.5" />
          </g>
        );

      case 'morning-peaks':
        return (
          <g transform="translate(16, 16)">
            {/* 晨曦温暖红日 */}
            <circle cx="74" cy="28" r="14" fill={palette.accent} />
            <circle cx="74" cy="28" r="17" fill={palette.accent} opacity="0.3" />
            {/* 远山 */}
            <polygon points="12,84 46,38 78,84" fill={palette.secondary} />
            <polygon points="46,38 58,54 46,58 38,50" fill="#FFFFFF" opacity="0.9" />
            {/* 近山与阴影 */}
            <polygon points="40,86 72,44 98,86" fill={palette.primary} />
            <polygon points="72,44 82,58 72,62 64,54" fill="#FFFFFF" />
            <polygon points="72,44 98,86 72,86" fill={palette.shadow} opacity="0.4" />
            {/* 山脚清溪波纹 */}
            <path
              d="M10,88 Q32,82 54,88 T96,86"
              fill="none"
              stroke="#FFFFFF"
              strokeWidth="2.5"
              strokeLinecap="round"
              opacity="0.8"
            />
          </g>
        );

      case 'cute-geo-bear':
        return (
          <g transform="translate(24, 22)">
            {/* 耳朵 */}
            <circle cx="16" cy="18" r="10" fill={palette.primary} />
            <circle cx="16" cy="18" r="5" fill={palette.secondary} />
            <circle cx="64" cy="18" r="10" fill={palette.primary} />
            <circle cx="64" cy="18" r="5" fill={palette.secondary} />
            {/* 头部阴影 */}
            <rect x="10" y="16" width="60" height="56" rx="26" fill={palette.shadow} transform="translate(0, 3)" />
            {/* 纯净浅奶/白熊头 */}
            <rect x="10" y="14" width="60" height="56" rx="26" fill={palette.primary} />
            {/* 浅吻部 */}
            <ellipse cx="40" cy="46" rx="14" ry="10" fill={palette.secondary} />
            {/* 鼻头与眼睛 */}
            <ellipse cx="40" cy="42" rx="4.5" ry="3" fill="#1C1F26" />
            <circle cx="28" cy="34" r="3.8" fill="#1C1F26" />
            <circle cx="52" cy="34" r="3.8" fill="#1C1F26" />
            <circle cx="29" cy="33" r="1.2" fill="#FFFFFF" />
            <circle cx="53" cy="33" r="1.2" fill="#FFFFFF" />
            {/* 治愈微腮红 */}
            <circle cx="21" cy="42" r="3" fill={palette.accent} opacity="0.6" />
            <circle cx="59" cy="42" r="3" fill={palette.accent} opacity="0.6" />
          </g>
        );

      case 'flamingo-lake':
        return (
          <g transform="translate(18, 16)">
            {/* 碧水浅滩波纹 */}
            <ellipse cx="50" cy="80" rx="38" ry="12" fill={palette.secondary} opacity="0.7" />
            <ellipse cx="50" cy="80" rx="46" ry="15" fill="none" stroke="#FFFFFF" strokeWidth="1.5" opacity="0.8" />
            {/* 火烈鸟细腿 */}
            <line x1="48" y1="58" x2="48" y2="82" stroke="#E91E63" strokeWidth="2.2" />
            <line x1="48" y1="68" x2="58" y2="76" stroke="#E91E63" strokeWidth="1.8" />
            {/* 身体 */}
            <ellipse cx="46" cy="54" rx="14" ry="9" fill={palette.accent} />
            <ellipse cx="44" cy="52" rx="8" ry="5" fill="#FFFFFF" opacity="0.3" />
            {/* S型优美细颈 */}
            <path
              d="M56,52 C64,44 64,30 56,24 C52,20 48,22 48,18"
              fill="none"
              stroke={palette.accent}
              strokeWidth="3.2"
              strokeLinecap="round"
            />
            {/* 头部与嘴喙 */}
            <circle cx="48" cy="18" r="3.5" fill={palette.accent} />
            <polygon points="46,18 38,20 44,22" fill="#1C1F26" />
            <polygon points="46,18 42,19 44,22" fill="#FFFFFF" />
          </g>
        );

      case 'pop-guitar':
        return (
          <g transform="translate(20, 16)">
            {/* 跳跃音符 */}
            <path d="M22,24 L22,14 L34,10 L34,20" fill="none" stroke={palette.accent} strokeWidth="2" strokeLinecap="round" />
            <circle cx="20" cy="24" r="3.5" fill={palette.accent} />
            <circle cx="32" cy="20" r="3.5" fill={palette.accent} />
            {/* 斜向吉他投影 */}
            <g transform="rotate(-32 50 54) translate(0, 3)">
              <ellipse cx="50" cy="62" rx="16" ry="20" fill={palette.shadow} />
            </g>
            {/* 斜向电吉他琴体 */}
            <g transform="rotate(-32 50 54)">
              <ellipse cx="50" cy="62" rx="16" ry="20" fill={palette.primary} />
              <ellipse cx="50" cy="46" rx="11" ry="12" fill={palette.primary} />
              <rect x="47" y="16" width="6" height="34" rx="2" fill={palette.secondary} />
              {/* 琴弦与高光 */}
              <ellipse cx="50" cy="54" rx="5" ry="5" fill="#1E293B" />
              <line x1="49" y1="18" x2="49" y2="68" stroke="#FFFFFF" strokeWidth="1" />
              <line x1="51" y1="18" x2="51" y2="68" stroke="#FFFFFF" strokeWidth="1" />
              {/* 琴头 */}
              <polygon points="46,16 54,16 56,8 44,8" fill={palette.accent} />
            </g>
          </g>
        );

      default:
        return null;
    }
  };

  const transformStyle =
    tiltX !== 0 || tiltY !== 0
      ? `perspective(400px) rotateX(${tiltY}deg) rotateY(${tiltX}deg)`
      : undefined;

  return (
    <div
      className={`sunlit-avatar-wrapper ${className}`}
      style={{
        width: size,
        height: size,
        borderRadius,
        overflow: 'hidden',
        boxShadow: showShadow
          ? `0 6px 16px -4px ${palette.shadow}, 0 2px 6px -2px ${palette.shadow}`
          : 'none',
        transform: transformStyle,
        transition: 'transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.25s ease',
        cursor: onClick ? 'pointer' : 'default',
        flexShrink: 0,
        userSelect: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: `linear-gradient(145deg, ${palette.bgGradient[0]}, ${palette.bgGradient[1]})`,
      }}
      onClick={onClick}
    >
      <svg
        viewBox="0 0 120 120"
        width="100%"
        height="100%"
        style={{ display: 'block' }}
      >
        <defs>
          <linearGradient id={`grad-${palette.id}`} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={palette.bgGradient[0]} />
            <stop offset="100%" stopColor={palette.bgGradient[1]} />
          </linearGradient>
        </defs>

        {/* 纯净主体内容 */}
        {renderSubject()}
      </svg>
    </div>
  );
};
