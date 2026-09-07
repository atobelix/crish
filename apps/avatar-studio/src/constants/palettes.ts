export interface PaletteDef {
  id: string;
  name: string;
  category: 'azure' | 'sunlight' | 'nature' | 'pop' | 'pastel';
  bgGradient: [string, string];
  primary: string;
  secondary: string;
  accent: string;
  highlight: string;
  shadow: string;
  description: string;
}

/**
 * 严格告别泥褐与暗浊色。
 * 提炼自高明度、高空气感的现代矢量/微缩风格（Google Material You 优质配色系）
 */
export const SUNLIT_PALETTES: PaletteDef[] = [
  {
    id: 'pure-azure',
    name: '晴空蓝白 (Pure Azure)',
    category: 'azure',
    bgGradient: ['#38B6FF', '#1E88E5'],
    primary: '#FFFFFF',
    secondary: '#E3F2FD',
    accent: '#FFD166',
    highlight: '#FFFFFF',
    shadow: 'rgba(13, 71, 161, 0.18)',
    description: '通透的晴空与纯白，无任何泥土杂质，清爽至极。',
  },
  {
    id: 'morning-valley',
    name: '初晨山谷 (Morning Valley)',
    category: 'nature',
    bgGradient: ['#FFF9C4', '#E8F5E9'],
    primary: '#4CAF50',
    secondary: '#81C784',
    accent: '#FFB300',
    highlight: '#FFFFFF',
    shadow: 'rgba(46, 125, 50, 0.16)',
    description: '柠檬暖阳照射下的嫩绿山林与溪流，充满晨露感。',
  },
  {
    id: 'sunlit-beach',
    name: '蔚蓝海岸 (Sunlit Coast)',
    category: 'azure',
    bgGradient: ['#4FC3F7', '#29B6F6'],
    primary: '#FFE082',
    secondary: '#FFF8E1',
    accent: '#FF7043',
    highlight: '#FFFFFF',
    shadow: 'rgba(2, 119, 189, 0.18)',
    description: '碧蓝海面、纯白浪花与暖金细沙，明媚的度假氛围。',
  },
  {
    id: 'retro-walkman',
    name: '夏日波普 (Pop 80s)',
    category: 'pop',
    bgGradient: ['#29B6F6', '#0288D1'],
    primary: '#FFD54F',
    secondary: '#FF5252',
    accent: '#FFFFFF',
    highlight: '#FFFFFF',
    shadow: 'rgba(1, 87, 155, 0.22)',
    description: '经典纯蓝底色撞击明黄随身听与红耳机，活力满分。',
  },
  {
    id: 'nordic-table',
    name: '等角微缩餐桌 (Nordic Table)',
    category: 'pastel',
    bgGradient: ['#4A90E2', '#357ABD'],
    primary: '#FFFFFF',
    secondary: '#F5F5F5',
    accent: '#FF8A80',
    highlight: '#FFFFFF',
    shadow: 'rgba(26, 35, 126, 0.2)',
    description: '纯蓝空间中微缩的白瓷牛奶瓶、原木桌与红白格纹布。',
  },
  {
    id: 'canyon-glow',
    name: '暖红砂岩 (Canyon Glow)',
    category: 'nature',
    bgGradient: ['#80D8FF', '#40C4FF'],
    primary: '#FF7043',
    secondary: '#FFAB91',
    accent: '#FFCA28',
    highlight: '#FFF9C4',
    shadow: 'rgba(216, 67, 21, 0.2)',
    description: '烈日下的红砂岩峡谷与深蓝穹顶，光影反差极富质感。',
  },
  {
    id: 'mint-oasis',
    name: '薄荷清泉 (Mint Oasis)',
    category: 'nature',
    bgGradient: ['#A7FFEB', '#64FFDA'],
    primary: '#00BFA5',
    secondary: '#E0F2F1',
    accent: '#FF4081',
    highlight: '#FFFFFF',
    shadow: 'rgba(0, 77, 64, 0.16)',
    description: '清澈微凉的薄荷水色与浅石，点缀一抹火烈鸟珊瑚红。',
  },
  {
    id: 'candy-drum',
    name: '马卡龙节拍 (Candy Beat)',
    category: 'pop',
    bgGradient: ['#FF80AB', '#F50057'],
    primary: '#FFFFFF',
    secondary: '#B2EBF2',
    accent: '#FFD740',
    highlight: '#FFFFFF',
    shadow: 'rgba(136, 14, 79, 0.22)',
    description: '草莓粉红底色与薄荷绿吉他、白鼓面，纯粹的甜酷活力。',
  },
];
