import type { AvatarDefinition, AvatarEntityPreset } from '@oneworks/avatar';
import {
  createAvatarEntityParts,
  getAvatarEntityPresetFaceStyle,
  getAvatarEntityPresetScene,
  type AvatarEntityPart,
} from '../avatar-engine/avatarEntityPresets';
import { DEFAULT_AVATAR_COLOR_GRADE } from '../avatar-engine/avatarColorGrade';
import { DEFAULT_AVATAR_FACE_STYLE } from '../avatar-engine/avatarGeometry';
import {
  type CustomCreationId,
  createCustomCreationParts,
  isCustomCreation,
} from './creationModels';

export type AvatarEntityOrCreationPreset =
  AvatarEntityPreset | CustomCreationId;

export interface AnimalPresetInfo {
  id: AvatarEntityOrCreationPreset;
  name: string;
  emoji: string;
  category: 'creations' | 'pets' | 'wild' | 'pasture' | 'birds' | 'nature';
  badge: string;
  description: string;
}

export const ALL_3D_ANIMALS: AnimalPresetInfo[] = [
  // ================= 圈红专属奇物 (用户圈红实拍专属 3D 几何建模) =================
  {
    id: 'grand-piano',
    name: '大三角钢琴',
    emoji: '🎹',
    category: 'creations',
    badge: '3D 升盖/黑白键/支架',
    description:
      '严格按照图2圈红纯白三角钢琴1:1建模，开启升起琴盖、黄铜支架、黑白琴键与三支立式琴腿',
  },
  {
    id: 'retro-walkman',
    name: '复古随身听',
    emoji: '📻',
    category: 'creations',
    badge: '3D 视窗/双滚轮/耳罩',
    description:
      '严格按照图2圈红金色磁带随身听1:1建模，双转动带轮、透明视窗、机械按键与钢带红海绵立体耳机',
  },
  {
    id: 'milk-bottle',
    name: '牛奶瓶与曲奇',
    emoji: '🥛',
    category: 'creations',
    badge: '3D 皇冠盖/曲奇饼/托盘',
    description:
      '严格按照图3圈红纯白牛奶瓶与巧克力曲奇1:1建模，复古玻璃牛奶瓶、压花瓶标、牛奶杯与木纹底托',
  },
  {
    id: 'kitchen-mixer',
    name: '复古厨师机',
    emoji: '🥣',
    category: 'creations',
    badge: '3D 悬臂/搅打头/奶油盆',
    description:
      '严格按照图3圈红宝蓝+红黄复古厨师机1:1建模，流线型机头、电镀旋钮、搅拌盆与雪白打发奶油',
  },
  {
    id: 'sandcastle',
    name: '海滨沙堡',
    emoji: '🏰',
    category: 'creations',
    badge: '3D 城堡尖顶/拱门/红旗',
    description:
      '严格按照图1圈红海边沙堡1:1建模，双侧圆柱塔楼、锥形堡顶、垛口拱形城门与飘扬的小旗帜',
  },
  {
    id: 'acoustic-guitar',
    name: '原声木吉他',
    emoji: '🎸',
    category: 'creations',
    badge: '3D 葫芦箱体/音孔/旋钮',
    description:
      '严格按照图2圈红原声吉他1:1建模，双弧度共鸣箱体、深邃黑音孔、修长乌木琴颈与金属弦钮',
  },
  {
    id: 'blue-mosque',
    name: '日落清真寺',
    emoji: '🕌',
    category: 'creations',
    badge: '3D 蓝穹顶/四宣礼塔/拱门',
    description:
      '严格按照图3圈红伊斯坦布尔蓝色清真寺1:1建模，经典中央蔚蓝大穹顶、金色新月、四座对称修长宣礼尖塔与拱门阶梯',
  },
  {
    id: 'tropical-flower',
    name: '热带扶桑花',
    emoji: '🌺',
    category: 'creations',
    badge: '3D 五瓣扶桑/金蕊/热带阔叶',
    description:
      '严格按照图3圈红热带洋红扶桑花1:1建模，五瓣交叠娇艳洋红花瓣、深绯红喉部、突出金色雄蕊花丝管与墨绿阔叶',
  },
  {
    id: 'flamingo',
    name: '海滩火烈鸟',
    emoji: '🦩',
    category: 'creations',
    badge: '3D 优雅S弯颈/下弯黑喙/立足',
    description:
      '严格按照图1圈红海滩火烈鸟1:1建模，优雅S形弯颈、标志性向下弯折黑尖粉喙、饱满粉色羽翼与单腿微曲涉水造型',
  },
  {
    id: 'jazz-clarinet',
    name: '爵士单簧管',
    emoji: '🎷',
    category: 'creations',
    badge: '3D 乌木管体/金键/喇叭口',
    description:
      '严格按照图2圈红斜置爵士单簧管1:1建模，深邃靛蓝管身、微翘喇叭口、金边号圈、金光闪烁音孔机械键位与飘动音符',
  },
  {
    id: 'rock-drums',
    name: '摇滚架子鼓',
    emoji: '🥁',
    category: 'creations',
    badge: '3D 纯白大底鼓/红军鼓/吊镲',
    description:
      '严格按照图2圈红摇滚架子鼓1:1建模，电镀圈纯白大底鼓、底鼓踏板、珊瑚红小军鼓、天蓝通通鼓、金属支架与金铜吊镲',
  },
  {
    id: 'emerald-crab',
    name: '热带小青蟹',
    emoji: '🦀',
    category: 'creations',
    badge: '3D 翠绿蟹甲/大螯/金海星',
    description:
      '严格按照图3圈红碧水礁石青蟹1:1建模，饱满翠绿蟹壳、威武大螯臂、珊瑚礁石底座、黑曜石眼珠与伴生金色小海星',
  },

  // 萌趣伴侣
  {
    id: 'cat',
    name: '英短猫咪',
    emoji: '🐱',
    category: 'pets',
    badge: '3D 尖锥立耳',
    description: '灵动猫耳与圆润面颊，自带傲娇萌感',
  },
  {
    id: 'dog',
    name: '阳光小狗',
    emoji: '🐕',
    category: 'pets',
    badge: '3D 微折耳朵与吻部',
    description: '垂耳或立耳柴犬犬系造型，元气满满',
  },
  {
    id: 'rabbit',
    name: '垂耳白兔',
    emoji: '🐰',
    category: 'pets',
    badge: '3D 立体长耳与粉鼻',
    description: '修长梯形 3D 兔耳，温顺乖巧',
  },
  {
    id: 'hamster',
    name: '金丝仓鼠',
    emoji: '🐹',
    category: 'pets',
    badge: '3D 双侧饱满鼓腮',
    description: '鼓囊囊的仓鼠脸蛋与灵动小圆耳',
  },
  {
    id: 'guinea-pig',
    name: '荷兰猪',
    emoji: '🐹',
    category: 'pets',
    badge: '3D 憨厚头身',
    description: '圆滚滚无尾豚鼠造型，呆萌治愈',
  },
  {
    id: 'chinchilla',
    name: '龙猫',
    emoji: '🐭',
    category: 'pets',
    badge: '3D 招风大圆耳',
    description: '毛茸茸的龙猫大耳朵与软萌身躯',
  },
  {
    id: 'ferret',
    name: '雪原白貂',
    emoji: '🦡',
    category: 'pets',
    badge: '3D 灵动面具',
    description: '流线型小巧面庞与标志性面具斑纹',
  },

  // 旷野森林
  {
    id: 'fox',
    name: '雪原灵狐',
    emoji: '🦊',
    category: 'wild',
    badge: '3D 挺拔大锥耳',
    description: '修长尖吻与英气尖耳，仙气十足',
  },
  {
    id: 'bear',
    name: '北极白熊',
    emoji: '🐻',
    category: 'wild',
    badge: '3D 球形熊耳与突吻',
    description: '圆润厚实的熊耳与标志性大鼻吻',
  },
  {
    id: 'capybara',
    name: '卡皮巴拉',
    emoji: '🛁',
    category: 'wild',
    badge: '3D 标志方块大脸',
    description: '情绪极其稳定的水豚，佛系淡定',
  },
  {
    id: 'deer',
    name: '梅花鹿',
    emoji: '🦌',
    category: 'wild',
    badge: '3D 枝桠鹿角与白斑',
    description: '三维分叉鹿角与曲面投影梅花斑点',
  },
  {
    id: 'otter',
    name: '俏皮水獭',
    emoji: '🦦',
    category: 'wild',
    badge: '3D 流线耳部',
    description: '水生灵动小耳与呆萌扁平吻部',
  },
  {
    id: 'squirrel',
    name: '蓬蓬松鼠',
    emoji: '🐿️',
    category: 'wild',
    badge: '3D 尖尖立耳与腮',
    description: '贪吃小松鼠，机敏活泼',
  },
  {
    id: 'tiger',
    name: '威风小虎',
    emoji: '🐯',
    category: 'wild',
    badge: '3D 虎耳与额纹',
    description: '王者额纹与圆虎耳，奶凶可爱',
  },
  {
    id: 'lion',
    name: '草原小狮',
    emoji: '🦁',
    category: 'wild',
    badge: '3D 蓬松鬃毛体积',
    description: '一圈三维环抱鬃毛，威风凛凛',
  },
  {
    id: 'hedgehog',
    name: '小刺猬',
    emoji: '🦔',
    category: 'wild',
    badge: '3D 细密背刺体元',
    description: '立体背刺几何簇与翘起小尖嘴',
  },
  {
    id: 'beaver',
    name: '工匠海狸',
    emoji: '🦫',
    category: 'wild',
    badge: '3D 立体海狸门牙',
    description: '敦厚海狸面部与标志性门齿',
  },
  {
    id: 'monkey',
    name: '机灵小猴',
    emoji: '🐒',
    category: 'wild',
    badge: '3D 大招风圆耳',
    description: '双侧突出大耳朵与调皮面纹',
  },

  // 田园牧场
  {
    id: 'alpaca',
    name: '软萌羊驼',
    emoji: '🦙',
    category: 'pasture',
    badge: '3D 绒毛额发与长耳',
    description: '蓬松额头刘海与微斜羊驼长耳',
  },
  {
    id: 'sheep',
    name: '卷毛绵羊',
    emoji: '🐑',
    category: 'pasture',
    badge: '3D 盘旋羊角/软毛',
    description: '螺旋盘羊角或软绵绵毛球包裹',
  },
  {
    id: 'cow',
    name: '荷斯坦奶牛',
    emoji: '🐮',
    category: 'pasture',
    badge: '3D 双角与宽鼻垫',
    description: '立体牛角与外凸粉色大鼻吻',
  },
  {
    id: 'pig',
    name: '粉嫩小猪',
    emoji: '🐷',
    category: 'pasture',
    badge: '3D 双孔圆筒猪鼻',
    description: '标志性突出的双孔小猪鼻子与大耷耳',
  },

  // 飞羽天空
  {
    id: 'penguin',
    name: '冰川企鹅',
    emoji: '🐧',
    category: 'birds',
    badge: '3D 锥形硬喙',
    description: '立体黄色小鸟喙与黑白面具分界',
  },
  {
    id: 'duck',
    name: '夏日小黄鸭',
    emoji: '🦆',
    category: 'birds',
    badge: '3D 宽扁鸭嘴',
    description: '经典扁平黄色鸭嘴巴，呆呆惹人爱',
  },
  {
    id: 'chick',
    name: '元气小鸡',
    emoji: '🐤',
    category: 'birds',
    badge: '3D 红色小鸡冠',
    description: '头顶红色立体鸡冠与嫩黄小尖嘴',
  },
  {
    id: 'owl',
    name: '智慧猫头鹰',
    emoji: '🦉',
    category: 'birds',
    badge: '3D 双侧羽耳簇',
    description: '神秘双耳羽毛簇与锐利勾喙',
  },
  {
    id: 'parrot',
    name: '热带鹦鹉',
    emoji: '🦜',
    category: 'birds',
    badge: '3D 弧形弯大喙',
    description: '色彩斑斓的热带大弯喙与颊纹',
  },
  {
    id: 'goose',
    name: '优雅白鹅',
    emoji: '🪿',
    category: 'birds',
    badge: '3D 鹅颈与宽喙',
    description: '昂首挺立的鹅嘴与洁白头部',
  },

  // 自然与趣味
  {
    id: 'seal',
    name: '浅滩小海豹',
    emoji: '🦭',
    category: 'nature',
    badge: '3D 双侧胡须球垫',
    description: '嘴吻两侧立体胡须球囊，憨态可掬',
  },
  {
    id: 'cloud',
    name: '晴空白云',
    emoji: '☁️',
    category: 'nature',
    badge: '3D 多重膨胀云团',
    description: '四瓣纯白膨胀球体，纯净空灵',
  },
  {
    id: 'sun',
    name: '明媚暖阳',
    emoji: '☀️',
    category: 'nature',
    badge: '3D 放射状太阳光辉',
    description: '太阳金黄多角光晕，温暖灿烂',
  },
  {
    id: 'bun',
    name: '白胖包子',
    emoji: '🥟',
    category: 'nature',
    badge: '3D 顶部捏褶',
    description: '白白胖胖的美味包子团子造型',
  },
];

export const CATEGORIES = [
  { id: 'all', label: '全部 3D 模型 (44款)' },
  { id: 'creations', label: '圈红专属奇物 🎹📻' },
  { id: 'pets', label: '萌趣伴侣 🐱🐶' },
  { id: 'wild', label: '旷野森林 🦊🐻' },
  { id: 'pasture', label: '田园牧场 🦙🐑' },
  { id: 'birds', label: '飞羽天空 🐧🦆' },
  { id: 'nature', label: '海洋自然 🦭☁️' },
] as const;

/**
 * 严格按照用户提供的 3 张截图圈红位置提取的 10 款大师级阳光感调色板
 * 核心设计法则：
 * 1. 彻底告别“沉重黑土灰”——动物主体保持纯净珍珠白/暖奶油/阳光陶土，绝对不渲染成黑土泥块！
 * 2. 空间舞台感——背景圆圈采用高饱和清透纯色（天蓝、夕阳粉、珊瑚、青柠绿、宝蓝等）形成强烈明快反差。
 * 3. 细节灵动——内耳、腮红、小爪垫注入少女草莓粉、海泡薄荷或金黄点缀。
 */
export interface SunlitPaletteConfig {
  readonly id: string;
  readonly name: string;
  readonly inspiration: string;
  readonly color: string; // 调色板指示色
  readonly baseAvatarPaletteId: string; // 关联的基础 Avatar Palette
  readonly cameraBackground: string; // 背景圆圈色
  readonly bodyBase: string; // 动物主体主色
  readonly bodyHighlight: string; // 3D 高光
  readonly bodyShadow: string; // 3D 柔光漫反射彩色阴影（告别死灰）
  readonly accent: string; // 腮红/内耳/花纹点缀
  readonly muzzle: string; // 吻部/小嘴
  readonly beakHorn: string; // 鸟喙/角/小嘴
  readonly eyeOutline: string; // 五官眼睛轮廓色
}

export const CURATED_SUNLIT_PALETTES: readonly SunlitPaletteConfig[] = [
  {
    id: 'sky-white',
    name: '晴空雪白',
    inspiration: '用户最爱蓝白神级配色 · 图1瀑布/图2钢琴/图3牛奶',
    color: '#38B6FF',
    baseAvatarPaletteId: 'sky',
    cameraBackground: '#38B6FF',
    bodyBase: '#FFFFFF',
    bodyHighlight: '#F0F9FF',
    bodyShadow: '#BAE6FD',
    accent: '#FFB3BA', // 草莓牛奶粉内耳与腮红
    muzzle: '#FFFFFF',
    beakHorn: '#FBBF24', // 暖金喙/角
    eyeOutline: '#0F172A',
  },
  {
    id: 'sunset-blush',
    name: '日落粉穹',
    inspiration: '图3圈红粉霞清真寺 · 图1圈红夕阳海崖',
    color: '#FFAAA7',
    baseAvatarPaletteId: 'coral',
    cameraBackground: '#FFAAA7',
    bodyBase: '#FFFDF9',
    bodyHighlight: '#FFFFFF',
    bodyShadow: '#FFCCD5',
    accent: '#FF758F', // 珊瑚粉
    muzzle: '#FFF0F3',
    beakHorn: '#38B6FF', // 对齐清真寺前景海蓝
    eyeOutline: '#3F1D2C',
  },
  {
    id: 'miami-mint',
    name: '迈阿密薄荷珊瑚',
    inspiration: '图2圈红架子鼓与海泡绿吉他 · 图3圈红扶桑花',
    color: '#FF4B72',
    baseAvatarPaletteId: 'coral',
    cameraBackground: '#FF4B72',
    bodyBase: '#F0FDF4', // 空气薄荷白
    bodyHighlight: '#FFFFFF',
    bodyShadow: '#FDA4AF',
    accent: '#4ADE80', // 清爽海泡薄荷绿
    muzzle: '#FFFFFF',
    beakHorn: '#FACC15', // 荧光柠檬金
    eyeOutline: '#1F2937',
  },
  {
    id: 'canary-cobalt',
    name: '阳光灿烂',
    inspiration: '图2圈红单簧管明黄 · 图3圈红复古厨房红蓝搅拌机',
    color: '#FCD34D',
    baseAvatarPaletteId: 'gold',
    cameraBackground: '#FCD34D',
    bodyBase: '#FFFFFF',
    bodyHighlight: '#FFFBEB',
    bodyShadow: '#FDE68A',
    accent: '#F472B6', // 泡泡糖粉
    muzzle: '#FFFFFF',
    beakHorn: '#38B6FF', // 电光宝蓝
    eyeOutline: '#1E3A8A',
  },
  {
    id: 'alpine-emerald',
    name: '绿野仙踪',
    inspiration: '图1圈红翡翠山谷与亮橙皮划艇 · 图2圈红竹林短笛',
    color: '#22C55E',
    baseAvatarPaletteId: 'mint',
    cameraBackground: '#22C55E',
    bodyBase: '#F8FAFC',
    bodyHighlight: '#FFFFFF',
    bodyShadow: '#BBF7D0',
    accent: '#FB923C', // 标志性亮橙皮划艇点缀
    muzzle: '#FFFFFF',
    beakHorn: '#F59E0B',
    eyeOutline: '#14532D',
  },
  {
    id: 'turquoise-lagoon',
    name: '浅滩泻湖',
    inspiration: '图3圈红阳光沙滩城堡 · 海星浅海 · 图2圈红口琴绿松石',
    color: '#06B6D4',
    baseAvatarPaletteId: 'lagoon',
    cameraBackground: '#06B6D4',
    bodyBase: '#FFFBEB', // 阳光细沙白
    bodyHighlight: '#FFFFFF',
    bodyShadow: '#A5F3FC',
    accent: '#F87171', // 珊瑚礁红
    muzzle: '#FEF3C7',
    beakHorn: '#F97316',
    eyeOutline: '#083344',
  },
  {
    id: 'sedona-terracotta',
    name: '大峡谷暖赭',
    inspiration: '图1圈红红石巨柱大峡谷 · 海滨砂岩拱门',
    color: '#E76F51',
    baseAvatarPaletteId: 'signal',
    cameraBackground: '#E0F2FE', // 高原浅空蓝背景衬托暖色动物
    bodyBase: '#E76F51', // 暖赭陶土
    bodyHighlight: '#F4A261',
    bodyShadow: '#C85A32',
    accent: '#FFF3E0', // 沙漠牛奶白
    muzzle: '#FFE8D6',
    beakHorn: '#2A9D8F', // 石松冷翠
    eyeOutline: '#264653',
  },
  {
    id: 'santorini-blue',
    name: '爱琴海白琴',
    inspiration: '图2圈红地中海大三角钢琴 · 乐谱本深蓝 · 图1瀑布',
    color: '#1D4ED8',
    baseAvatarPaletteId: 'ocean',
    cameraBackground: '#1D4ED8',
    bodyBase: '#FFFFFF', // 圣托里尼纯白白瓷
    bodyHighlight: '#EFF6FF',
    bodyShadow: '#93C5FD',
    accent: '#60A5FA', // 浅蓝内耳
    muzzle: '#FFFFFF',
    beakHorn: '#FBBF24',
    eyeOutline: '#0A192F',
  },
  {
    id: 'picnic-milk',
    name: '野餐牛奶',
    inspiration: '图3圈红早晨纯牛奶瓶 · 樱桃红格布 · 烘焙饼干',
    color: '#3B82F6',
    baseAvatarPaletteId: 'sky',
    cameraBackground: '#3B82F6',
    bodyBase: '#FFFFFF',
    bodyHighlight: '#FFFFFF',
    bodyShadow: '#BFDBFE',
    accent: '#EF4444', // 野餐红格布樱桃红
    muzzle: '#FEF2F2',
    beakHorn: '#D97706', // 饼干金黄
    eyeOutline: '#1E293B',
  },
  {
    id: 'tropical-hibiscus',
    name: '热带扶桑',
    inspiration: '图3圈红深绿雨林热带洋红扶桑花',
    color: '#E11D48',
    baseAvatarPaletteId: 'coral',
    cameraBackground: '#14532D', // 深绿雨林背景
    bodyBase: '#FF4081', // 娇艳洋红花瓣
    bodyHighlight: '#FF80AB',
    bodyShadow: '#9F1239',
    accent: '#FFFFFF', // 纯白点缀
    muzzle: '#FFF0F3',
    beakHorn: '#FACC15', // 花粉明金
    eyeOutline: '#0F172A',
  },
];

export function getCuratedPalette(id: string): SunlitPaletteConfig {
  return (
    CURATED_SUNLIT_PALETTES.find((p) => p.id === id) ||
    CURATED_SUNLIT_PALETTES[0]
  );
}

/**
 * 智能解剖学着色：告别原库“一桶油漆通染”的灰暗恶梦
 * 精准将高质感阳光色彩赋能到 3D 部件上
 */
export function applyCuratedPaletteToParts(
  parts: readonly AvatarEntityPart[],
  palette: SunlitPaletteConfig
): AvatarEntityPart[] {
  return parts.map((part) => {
    const id = part.id.toLowerCase();

    // 1. 腮红、内耳、面颊可爱点缀、鸡冠、羽簇
    if (
      id.includes('inner') ||
      id.includes('cheek') ||
      id.includes('blush') ||
      id.includes('pad') ||
      id.includes('crest') ||
      id.includes('comb') ||
      id.includes('tuft')
    ) {
      return {
        ...part,
        baseColor: palette.accent,
        highlightColor: palette.bodyHighlight,
        shadowColor: palette.bodyShadow,
        foregroundColor: palette.eyeOutline,
      };
    }

    // 2. 鸟喙、鸭嘴、牛角、鹿角
    if (
      id.includes('beak') ||
      id.includes('bill') ||
      id.includes('horn') ||
      id.includes('antler')
    ) {
      return {
        ...part,
        baseColor: palette.beakHorn,
        highlightColor: '#FFFBEB',
        shadowColor: palette.bodyShadow,
        foregroundColor: palette.eyeOutline,
      };
    }

    // 3. 吻部、小鼻子、嘴吻突出体
    if (
      id === 'muzzle' ||
      id === 'snout' ||
      id.includes('mouth') ||
      id.includes('nose')
    ) {
      return {
        ...part,
        baseColor: palette.muzzle,
        highlightColor: palette.bodyHighlight,
        shadowColor: palette.bodyShadow,
        foregroundColor: palette.eyeOutline,
      };
    }

    // 4. 狮子鬃毛、刺猬背刺
    if (id.includes('mane') || id.includes('spine')) {
      return {
        ...part,
        baseColor:
          palette.id === 'tropical-hibiscus' ? '#14532D' : palette.bodyShadow,
        highlightColor: palette.bodyHighlight,
        shadowColor: palette.bodyShadow,
        foregroundColor: palette.eyeOutline,
      };
    }

    // 5. 动物主头部、耳朵外壳与身躯体元
    return {
      ...part,
      baseColor: palette.bodyBase,
      highlightColor: palette.bodyHighlight,
      shadowColor: palette.bodyShadow,
      foregroundColor: palette.eyeOutline,
    };
  });
}

/**
 * 3D 丰富解剖学增强：给小动物注入立体内耳、鼓腮脸颊、立体吻部与鼻头，彻底告别单调“小圆人”
 */
export function enrichAnimalParts(
  preset: string,
  rawParts: readonly AvatarEntityPart[],
  palette: SunlitPaletteConfig
): AvatarEntityPart[] {
  const parts = [...rawParts];

  switch (preset) {
    case 'cat': {
      parts.push(
        // 左粉嫩内耳锥
        {
          id: 'cat-ear-inner-left',
          label: 'Left Inner Ear',
          face: false,
          shape: 'cone',
          scaleX: 0.13,
          scaleY: 0.2,
          scaleZ: 0.1,
          rotationX: -7,
          rotationY: -13,
          rotationZ: -9,
          roundness: 50,
          x: -54,
          y: -76,
          z: 2,
          baseColor: palette.accent,
          highlightColor: '#FFF1F2',
          shadowColor: palette.bodyShadow,
          foregroundColor: palette.eyeOutline,
        },
        // 右粉嫩内耳锥
        {
          id: 'cat-ear-inner-right',
          label: 'Right Inner Ear',
          face: false,
          shape: 'cone',
          scaleX: 0.13,
          scaleY: 0.2,
          scaleZ: 0.1,
          rotationX: -6,
          rotationY: 13,
          rotationZ: 9,
          roundness: 50,
          x: 54,
          y: -76,
          z: 2,
          baseColor: palette.accent,
          highlightColor: '#FFF1F2',
          shadowColor: palette.bodyShadow,
          foregroundColor: palette.eyeOutline,
        },
        // 饱满可爱左脸颊
        {
          id: 'cat-cheek-left',
          label: 'Left Cheek',
          face: false,
          shape: 'sphere',
          scaleX: 0.22,
          scaleY: 0.2,
          scaleZ: 0.18,
          x: -34,
          y: 26,
          z: 14,
          baseColor: palette.bodyBase,
          highlightColor: palette.bodyHighlight,
          shadowColor: palette.bodyShadow,
          foregroundColor: palette.eyeOutline,
        },
        // 饱满可爱右脸颊
        {
          id: 'cat-cheek-right',
          label: 'Right Cheek',
          face: false,
          shape: 'sphere',
          scaleX: 0.22,
          scaleY: 0.2,
          scaleZ: 0.18,
          x: 34,
          y: 26,
          z: 14,
          baseColor: palette.bodyBase,
          highlightColor: palette.bodyHighlight,
          shadowColor: palette.bodyShadow,
          foregroundColor: palette.eyeOutline,
        },
        // 立体突出小嘴吻部
        {
          id: 'cat-snout',
          label: 'Muzzle Snout',
          face: false,
          shape: 'ellipse',
          scaleX: 0.26,
          scaleY: 0.18,
          scaleZ: 0.22,
          x: 0,
          y: 24,
          z: 18,
          roundness: 90,
          baseColor: palette.muzzle,
          highlightColor: palette.bodyHighlight,
          shadowColor: palette.bodyShadow,
          foregroundColor: palette.eyeOutline,
        },
        // 可爱粉红立体鼻头
        {
          id: 'cat-nose-3d',
          label: '3D Pink Nose',
          face: false,
          shape: 'sphere',
          scaleX: 0.09,
          scaleY: 0.08,
          scaleZ: 0.1,
          x: 0,
          y: 18,
          z: 28,
          baseColor: palette.accent,
          highlightColor: '#FFF1F2',
          shadowColor: '#FDA4AF',
          foregroundColor: palette.eyeOutline,
        }
      );
      break;
    }

    case 'dog': {
      parts.push(
        // 左内耳柔粉层
        {
          id: 'dog-ear-inner-left',
          label: 'Left Inner Ear',
          face: false,
          shape: 'teardrop',
          scaleX: 0.12,
          scaleY: 0.26,
          scaleZ: 0.12,
          rotationX: -4,
          rotationY: -10,
          rotationZ: 22,
          roundness: 80,
          x: -70,
          y: -50,
          z: 4,
          baseColor: palette.accent,
          highlightColor: '#FFF1F2',
          shadowColor: palette.bodyShadow,
          foregroundColor: palette.eyeOutline,
        },
        // 右内耳柔粉层
        {
          id: 'dog-ear-inner-right',
          label: 'Right Inner Ear',
          face: false,
          shape: 'teardrop',
          scaleX: 0.12,
          scaleY: 0.26,
          scaleZ: 0.12,
          rotationX: -4,
          rotationY: 10,
          rotationZ: -22,
          roundness: 80,
          x: 70,
          y: -50,
          z: 4,
          baseColor: palette.accent,
          highlightColor: '#FFF1F2',
          shadowColor: palette.bodyShadow,
          foregroundColor: palette.eyeOutline,
        },
        // 憨厚小狗立体长吻部
        {
          id: 'dog-snout',
          label: 'Dog Muzzle',
          face: false,
          shape: 'capsule',
          scaleX: 0.32,
          scaleY: 0.24,
          scaleZ: 0.32,
          x: 0,
          y: 28,
          z: 22,
          roundness: 95,
          baseColor: palette.muzzle,
          highlightColor: palette.bodyHighlight,
          shadowColor: palette.bodyShadow,
          foregroundColor: palette.eyeOutline,
        },
        // 纯黑纽扣小狗大鼻头
        {
          id: 'dog-nose-3d',
          label: 'Puppy Button Nose',
          face: false,
          shape: 'sphere',
          scaleX: 0.12,
          scaleY: 0.09,
          scaleZ: 0.12,
          x: 0,
          y: 20,
          z: 36,
          baseColor: palette.eyeOutline,
          highlightColor: '#334155',
          shadowColor: '#020617',
          foregroundColor: palette.eyeOutline,
        },
        // 饱满左脸颊
        {
          id: 'dog-cheek-left',
          label: 'Dog Cheek Left',
          face: false,
          shape: 'sphere',
          scaleX: 0.22,
          scaleY: 0.2,
          scaleZ: 0.18,
          x: -36,
          y: 30,
          z: 16,
          baseColor: palette.bodyBase,
          highlightColor: palette.bodyHighlight,
          shadowColor: palette.bodyShadow,
          foregroundColor: palette.eyeOutline,
        },
        // 饱满右脸颊
        {
          id: 'dog-cheek-right',
          label: 'Dog Cheek Right',
          face: false,
          shape: 'sphere',
          scaleX: 0.22,
          scaleY: 0.2,
          scaleZ: 0.18,
          x: 36,
          y: 30,
          z: 16,
          baseColor: palette.bodyBase,
          highlightColor: palette.bodyHighlight,
          shadowColor: palette.bodyShadow,
          foregroundColor: palette.eyeOutline,
        }
      );
      break;
    }

    case 'rabbit': {
      parts.push(
        // 左兔耳长内耳粉瓣
        {
          id: 'rabbit-ear-inner-left',
          label: 'Left Bunny Inner Ear',
          face: false,
          shape: 'trapezoid',
          scaleX: 0.11,
          scaleY: 0.5,
          scaleZ: 0.08,
          rotationX: -3,
          rotationY: -5,
          rotationZ: -8,
          roundness: 90,
          topScale: 0.85,
          x: -50,
          y: -74,
          z: -16,
          baseColor: palette.accent,
          highlightColor: '#FFF1F2',
          shadowColor: palette.bodyShadow,
          foregroundColor: palette.eyeOutline,
        },
        // 右兔耳长内耳粉瓣
        {
          id: 'rabbit-ear-inner-right',
          label: 'Right Bunny Inner Ear',
          face: false,
          shape: 'trapezoid',
          scaleX: 0.11,
          scaleY: 0.52,
          scaleZ: 0.08,
          rotationX: -4,
          rotationY: 7,
          rotationZ: 11,
          roundness: 90,
          topScale: 0.85,
          x: 48,
          y: -77,
          z: -18,
          baseColor: palette.accent,
          highlightColor: '#FFF1F2',
          shadowColor: palette.bodyShadow,
          foregroundColor: palette.eyeOutline,
        },
        // 软萌小兔立体嘴吻
        {
          id: 'rabbit-snout',
          label: 'Bunny Twitch Muzzle',
          face: false,
          shape: 'ellipse',
          scaleX: 0.26,
          scaleY: 0.18,
          scaleZ: 0.2,
          x: 0,
          y: 28,
          z: 18,
          roundness: 90,
          baseColor: palette.muzzle,
          highlightColor: palette.bodyHighlight,
          shadowColor: palette.bodyShadow,
          foregroundColor: palette.eyeOutline,
        },
        // 粉嫩小兔鼻尖
        {
          id: 'rabbit-nose-3d',
          label: '3D Bunny Nose',
          face: false,
          shape: 'sphere',
          scaleX: 0.09,
          scaleY: 0.08,
          scaleZ: 0.1,
          x: 0,
          y: 22,
          z: 28,
          baseColor: palette.accent,
          highlightColor: '#FFF1F2',
          shadowColor: '#FDA4AF',
          foregroundColor: palette.eyeOutline,
        },
        // 圆滚滚左脸蛋
        {
          id: 'rabbit-cheek-left',
          label: 'Bunny Cheek Left',
          face: false,
          shape: 'sphere',
          scaleX: 0.22,
          scaleY: 0.2,
          scaleZ: 0.18,
          x: -32,
          y: 28,
          z: 14,
          baseColor: palette.bodyBase,
          highlightColor: palette.bodyHighlight,
          shadowColor: palette.bodyShadow,
          foregroundColor: palette.eyeOutline,
        },
        // 圆滚滚右脸蛋
        {
          id: 'rabbit-cheek-right',
          label: 'Bunny Cheek Right',
          face: false,
          shape: 'sphere',
          scaleX: 0.22,
          scaleY: 0.2,
          scaleZ: 0.18,
          x: 32,
          y: 28,
          z: 14,
          baseColor: palette.bodyBase,
          highlightColor: palette.bodyHighlight,
          shadowColor: palette.bodyShadow,
          foregroundColor: palette.eyeOutline,
        }
      );
      break;
    }

    case 'bear': {
      parts.push(
        // 左熊耳粉圆内耳
        {
          id: 'bear-ear-inner-left',
          label: 'Bear Inner Ear Left',
          face: false,
          shape: 'ellipse',
          scaleX: 0.12,
          scaleY: 0.2,
          scaleZ: 0.08,
          rotationX: -4,
          rotationY: -7,
          rotationZ: 8,
          roundness: 90,
          x: -58,
          y: -70,
          z: -12,
          baseColor: palette.accent,
          highlightColor: '#FFF1F2',
          shadowColor: palette.bodyShadow,
          foregroundColor: palette.eyeOutline,
        },
        // 右熊耳粉圆内耳
        {
          id: 'bear-ear-inner-right',
          label: 'Bear Inner Ear Right',
          face: false,
          shape: 'ellipse',
          scaleX: 0.12,
          scaleY: 0.2,
          scaleZ: 0.08,
          rotationX: -3,
          rotationY: 8,
          rotationZ: -7,
          roundness: 90,
          x: 58,
          y: -68,
          z: -14,
          baseColor: palette.accent,
          highlightColor: '#FFF1F2',
          shadowColor: palette.bodyShadow,
          foregroundColor: palette.eyeOutline,
        },
        // 敦厚大熊吻部
        {
          id: 'bear-snout',
          label: 'Bear Snout Muzzle',
          face: false,
          shape: 'capsule',
          scaleX: 0.38,
          scaleY: 0.3,
          scaleZ: 0.32,
          x: 0,
          y: 30,
          z: 20,
          roundness: 95,
          baseColor: palette.muzzle,
          highlightColor: palette.bodyHighlight,
          shadowColor: palette.bodyShadow,
          foregroundColor: palette.eyeOutline,
        },
        // 大黑熊鼻钮
        {
          id: 'bear-nose-3d',
          label: 'Bear Button Nose',
          face: false,
          shape: 'sphere',
          scaleX: 0.14,
          scaleY: 0.1,
          scaleZ: 0.12,
          x: 0,
          y: 22,
          z: 34,
          baseColor: palette.eyeOutline,
          highlightColor: '#334155',
          shadowColor: '#020617',
          foregroundColor: palette.eyeOutline,
        }
      );
      break;
    }

    case 'fox': {
      parts.push(
        // 左狐耳洁白绒毛内耳
        {
          id: 'fox-ear-inner-left',
          label: 'Fox Inner Ear Left',
          face: false,
          shape: 'cone',
          scaleX: 0.2,
          scaleY: 0.34,
          scaleZ: 0.16,
          rotationX: -5,
          rotationY: -11,
          rotationZ: -13,
          roundness: 30,
          x: -68,
          y: -79,
          z: -10,
          baseColor: palette.muzzle,
          highlightColor: '#FFFFFF',
          shadowColor: palette.bodyShadow,
          foregroundColor: palette.eyeOutline,
        },
        // 右狐耳洁白绒毛内耳
        {
          id: 'fox-ear-inner-right',
          label: 'Fox Inner Ear Right',
          face: false,
          shape: 'cone',
          scaleX: 0.2,
          scaleY: 0.34,
          scaleZ: 0.16,
          rotationX: -5,
          rotationY: 11,
          rotationZ: 13,
          roundness: 30,
          x: 68,
          y: -79,
          z: -10,
          baseColor: palette.muzzle,
          highlightColor: '#FFFFFF',
          shadowColor: palette.bodyShadow,
          foregroundColor: palette.eyeOutline,
        },
        // 尖尖灵动狐狸吻部
        {
          id: 'fox-snout',
          label: 'Fox Tapered Snout',
          face: false,
          shape: 'cone',
          scaleX: 0.28,
          scaleY: 0.22,
          scaleZ: 0.36,
          rotationX: 85,
          roundness: 70,
          x: 0,
          y: 28,
          z: 26,
          baseColor: palette.muzzle,
          highlightColor: '#FFFFFF',
          shadowColor: palette.bodyShadow,
          foregroundColor: palette.eyeOutline,
        },
        // 灵狐精巧黑鼻尖
        {
          id: 'fox-nose-3d',
          label: 'Fox Nose Tip',
          face: false,
          shape: 'sphere',
          scaleX: 0.09,
          scaleY: 0.08,
          scaleZ: 0.1,
          x: 0,
          y: 24,
          z: 42,
          baseColor: palette.eyeOutline,
          highlightColor: '#334155',
          shadowColor: '#020617',
          foregroundColor: palette.eyeOutline,
        }
      );
      break;
    }

    case 'hamster': {
      parts.push(
        // 左仓鼠粉嫩内耳
        {
          id: 'hamster-ear-inner-l',
          label: 'Hamster Inner Ear Left',
          face: false,
          shape: 'ellipse',
          scaleX: 0.12,
          scaleY: 0.14,
          scaleZ: 0.09,
          roundness: 100,
          x: -67,
          y: -72,
          z: -12,
          baseColor: palette.accent,
          highlightColor: '#FFF1F2',
          shadowColor: palette.bodyShadow,
          foregroundColor: palette.eyeOutline,
        },
        // 右仓鼠粉嫩内耳
        {
          id: 'hamster-ear-inner-r',
          label: 'Hamster Inner Ear Right',
          face: false,
          shape: 'ellipse',
          scaleX: 0.12,
          scaleY: 0.14,
          scaleZ: 0.09,
          roundness: 100,
          x: 67,
          y: -72,
          z: -12,
          baseColor: palette.accent,
          highlightColor: '#FFF1F2',
          shadowColor: palette.bodyShadow,
          foregroundColor: palette.eyeOutline,
        },
        // 萌萌小仓鼠立体吻
        {
          id: 'hamster-snout',
          label: 'Hamster Snout',
          face: false,
          shape: 'ellipse',
          scaleX: 0.24,
          scaleY: 0.18,
          scaleZ: 0.2,
          x: 0,
          y: 26,
          z: 24,
          roundness: 90,
          baseColor: palette.muzzle,
          highlightColor: palette.bodyHighlight,
          shadowColor: palette.bodyShadow,
          foregroundColor: palette.eyeOutline,
        },
        // 仓鼠粉鼻点
        {
          id: 'hamster-nose-3d',
          label: 'Hamster Nose Button',
          face: false,
          shape: 'sphere',
          scaleX: 0.08,
          scaleY: 0.08,
          scaleZ: 0.08,
          x: 0,
          y: 22,
          z: 34,
          baseColor: palette.accent,
          highlightColor: '#FFF1F2',
          shadowColor: '#FDA4AF',
          foregroundColor: palette.eyeOutline,
        }
      );
      break;
    }
  }

  return parts;
}

/**
 * 完整装载来自原库官方的真实 3D 小动物模型以及专属 3D 几何建模
 * 1. 包含全部原装 3D 体元部件或专属器物几何部件
 * 2. 包含原装曲面投影贴花 (Decals：眼圈、斑纹、面具、胡须垫)
 * 3. 包含精心微调的面部五官参数 (FaceStyle)
 * 4. 包含精心调校的 3D 摄像机与视场角 (ViewState)
 * 5. 智能注入阳光高空气感配色，彻底告别沉重土灰
 */
export function buildComplete3DAnimalDefinition(
  preset: AvatarEntityOrCreationPreset,
  paletteId: string = 'sky-white',
  frame: 'circle' | 'rounded' | 'square' = 'circle'
): AvatarDefinition {
  const paletteConfig = getCuratedPalette(paletteId);

  // 1. 如果是用户圈红专属 3D 几何造物 (钢琴、随身听、牛奶瓶、厨师机、沙堡、吉他、清真寺、扶桑花、火烈鸟、单簧管、架子鼓、小青蟹)
  if (isCustomCreation(preset)) {
    const parts = createCustomCreationParts(preset, paletteConfig);

    const viewAngles: Record<
      CustomCreationId,
      { pitch: number; yaw: number; scale: number; positionY: number }
    > = {
      'grand-piano': { pitch: -0.2, yaw: 0.35, scale: 1.15, positionY: -2 },
      'retro-walkman': { pitch: -0.12, yaw: 0.28, scale: 1.15, positionY: 0 },
      'milk-bottle': { pitch: -0.1, yaw: 0.3, scale: 1.18, positionY: 0 },
      'kitchen-mixer': { pitch: -0.18, yaw: 0.38, scale: 1.12, positionY: 0 },
      sandcastle: { pitch: -0.22, yaw: 0.32, scale: 1.16, positionY: 6 },
      'acoustic-guitar': { pitch: -0.12, yaw: 0.3, scale: 1.12, positionY: 0 },
      'blue-mosque': { pitch: -0.18, yaw: 0.32, scale: 1.12, positionY: 2 },
      'tropical-flower': { pitch: -0.14, yaw: 0.22, scale: 1.16, positionY: 0 },
      flamingo: { pitch: -0.1, yaw: 0.25, scale: 1.12, positionY: 4 },
      'jazz-clarinet': { pitch: -0.12, yaw: 0.28, scale: 1.14, positionY: 0 },
      'rock-drums': { pitch: -0.18, yaw: 0.32, scale: 1.12, positionY: 2 },
      'emerald-crab': { pitch: -0.2, yaw: 0.26, scale: 1.15, positionY: 4 },
    };
    const va = viewAngles[preset] || {
      pitch: -0.15,
      yaw: 0.25,
      scale: 1.15,
      positionY: 0,
    };

    return {
      schema: 'oneworks.avatar' as const,
      version: 1,
      metadata: {
        id: preset,
        name: preset,
        createdAt: '2026-09-06T00:00:00.000Z',
        updatedAt: '2026-09-06T00:00:00.000Z',
      },
      scene: {
        appearance: {
          backgroundStyle: 'solid',
          bodyShape: 'sphere',
          paletteId: paletteConfig.baseAvatarPaletteId,
          bottomTaper: 0,
        },
        camera: {
          background: paletteConfig.cameraBackground,
          frame,
          frameShadow: {
            direction: 90,
            distance: 12,
            opacity: 20,
            softness: 24,
          },
          showFrameShadow: true,
          size: 512,
        },
        decals: [],
        effects: {
          avatarShadow: {
            color: paletteConfig.bodyShadow,
            direction: 90,
            distance: 10,
            opacity: 28,
            softness: 20,
          },
          colorGrade: DEFAULT_AVATAR_COLOR_GRADE,
          faceShadow: {
            direction: 50,
            distance: 4,
            opacity: 18,
            softness: 6,
          },
          outline: {
            color: paletteConfig.eyeOutline,
            opacity: 18,
            width: 2,
          },
          showAvatarShadow: true,
          showFaceShadow: false,
          showOutline: true,
        },
        entity: {
          preset: 'custom' as any,
          parts,
        },
        face: {
          eyeHighlight: {
            color: '#ffffff',
            enabled: false,
            offsetX: -18,
            offsetY: -20,
            opacity: 92,
            size: 24,
          },
          eyeRoundness: 100,
          eyeShape: 'rounded',
          gap: 100,
          height: 1,
          leftEyeRotation: 0,
          mouthCurve: 45,
          mouthEnabled: false,
          mouthHeight: 12,
          mouthRotation: 0,
          mouthShape: 'curve',
          mouthWidth: 52,
          mouthY: 52,
          noseEnabled: false,
          noseHeight: 18,
          noseRotation: 0,
          noseShape: 'inverted-triangle',
          noseWidth: 10,
          noseY: 22,
          rotation: 0,
          rightEyeRotation: 0,
          width: 1,
        } as any,
        interactionMode: 'rotate',
        lighting: {
          azimuth: -35,
          distance: 0,
          elevation: 40,
          enabled: true,
          gridDensity: 28,
        },
        view: {
          pitch: va.pitch,
          positionX: 0,
          positionY: va.positionY,
          roll: 0,
          scale: va.scale,
          yaw: va.yaw,
        },
      },
    };
  }

  // 2. 否则是 32 款内置小动物
  const scene = getAvatarEntityPresetScene(preset as AvatarEntityPreset);
  const baseFaceStyle = getAvatarEntityPresetFaceStyle(
    preset as AvatarEntityPreset
  );
  const rawParts = createAvatarEntityParts(preset as AvatarEntityPreset);

  // 3D 丰富解剖学增强：注入立体内耳、鼓腮脸颊、立体吻部与鼻头，彻底告别单调“小圆人”
  const enrichedParts = enrichAnimalParts(preset, rawParts, paletteConfig);

  // 智能 3D 部件解剖学着色
  const coloredParts = applyCuratedPaletteToParts(enrichedParts, paletteConfig);

  // 贴花色彩适配：斑点、腮红、胡须等告别黑土
  const adjustedDecals = (scene?.surfaceDecals || []).map((decal) => {
    const id = decal.id.toLowerCase();
    if (id.includes('cheek') || id.includes('blush')) {
      return { ...decal, color: paletteConfig.accent };
    }
    if (
      id.includes('whisker') ||
      id.includes('outline') ||
      id.includes('seam') ||
      id.includes('nostril')
    ) {
      return { ...decal, color: paletteConfig.eyeOutline };
    }
    if (
      id.includes('spot') ||
      id.includes('patch') ||
      id.includes('stripe') ||
      id.includes('mask')
    ) {
      return { ...decal, color: paletteConfig.accent };
    }
    return decal;
  });

  // 五官精致着色：注入高光水灵眼眸与可爱微笑，严格遵照 OneWorks Avatar 架构契约
  const rawFace = baseFaceStyle || DEFAULT_AVATAR_FACE_STYLE;
  const faceStyle: Record<string, any> = {
    ...rawFace,
    eyeHighlight: {
      enabled: true,
      color: '#FFFFFF',
      opacity: 95,
      size: 24,
      offsetX: -16,
      offsetY: -18,
    },
    mouthEnabled: true,
    mouthShape: 'curve',
    mouthCurve: 55,
    mouthWidth: Math.max(16, (rawFace as any)?.mouthWidth || 28),
    mouthHeight: Math.max(10, (rawFace as any)?.mouthHeight || 12),
    mouthY: (rawFace as any)?.mouthY || 46,
  };

  return {
    schema: 'oneworks.avatar' as const,
    version: 1,
    metadata: {
      id: preset,
      name: preset,
      createdAt: '2026-09-06T00:00:00.000Z',
      updatedAt: '2026-09-06T00:00:00.000Z',
    },
    scene: {
      appearance: {
        backgroundStyle: 'solid',
        bodyShape: 'sphere',
        paletteId: paletteConfig.baseAvatarPaletteId,
        bottomTaper: 0,
      },
      camera: {
        background: paletteConfig.cameraBackground,
        frame,
        frameShadow: scene?.frameShadowStyle || {
          direction: 90,
          distance: 12,
          opacity: 18,
          softness: 24,
        },
        showFrameShadow: scene?.showFrameShadow ?? true,
        size: 512,
      },
      decals: adjustedDecals,
      effects: {
        avatarShadow: {
          color: paletteConfig.bodyShadow,
          direction: 90,
          distance: 10,
          opacity: 28,
          softness: 20,
        },
        colorGrade: DEFAULT_AVATAR_COLOR_GRADE,
        faceShadow: {
          direction: 90,
          distance: 4,
          opacity: 15,
          softness: 6,
        },
        outline: {
          color: paletteConfig.eyeOutline,
          opacity: 18,
          width: 2,
        },
        showAvatarShadow: true,
        showFaceShadow: true,
        showOutline: true,
      },
      entity: {
        preset: preset as any,
        parts: coloredParts,
      },
      face: faceStyle as any,
      interactionMode: scene?.interactionMode ?? 'rotate',
      lighting: {
        azimuth: scene?.lightAzimuth ?? -35,
        distance: scene?.lightDistance ?? 0,
        elevation: scene?.lightElevation ?? 40,
        enabled: true,
        gridDensity: 28,
      },
      view: scene?.viewState
        ? {
            pitch: scene.viewState.pitch,
            positionX: scene.viewState.positionX,
            positionY: scene.viewState.positionY,
            roll: scene.viewState.roll,
            scale: scene.viewState.scale,
            yaw: scene.viewState.yaw,
          }
        : {
            pitch: -0.06,
            positionX: 0,
            positionY: 0,
            roll: 0,
            scale: 1.15,
            yaw: 0.08,
          },
    },
  };
}
