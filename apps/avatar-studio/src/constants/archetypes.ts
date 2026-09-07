export type ArchetypeId =
  | 'pure-cloud'
  | 'milk-biscuit'
  | 'sand-castle'
  | 'retro-walkman'
  | 'grand-piano'
  | 'morning-peaks'
  | 'cute-geo-bear'
  | 'flamingo-lake'
  | 'pop-guitar';

export interface ArchetypeDef {
  id: ArchetypeId;
  name: string;
  category: 'pure' | 'micro' | 'nature' | 'pop';
  tagline: string;
  defaultPaletteId: string;
}

export const ARCHETYPES: ArchetypeDef[] = [
  {
    id: 'pure-cloud',
    name: '晴空纯白云',
    category: 'pure',
    tagline: '极度纯净的蓝白高光，零杂质',
    defaultPaletteId: 'pure-azure',
  },
  {
    id: 'milk-biscuit',
    name: '等角微缩牛奶桌',
    category: 'micro',
    tagline: '白瓷牛奶瓶、曲奇与格纹野餐垫',
    defaultPaletteId: 'nordic-table',
  },
  {
    id: 'sand-castle',
    name: '阳光沙滩城堡',
    category: 'micro',
    tagline: '暖金细沙城堡、旗帜与海天一色',
    defaultPaletteId: 'sunlit-beach',
  },
  {
    id: 'retro-walkman',
    name: '复古磁带随身听',
    category: 'pop',
    tagline: '纯蓝底明黄机身，红头戴耳机',
    defaultPaletteId: 'retro-walkman',
  },
  {
    id: 'grand-piano',
    name: '海滨白钢琴',
    category: 'micro',
    tagline: '地中海海岸上的纯白三角钢琴',
    defaultPaletteId: 'sunlit-beach',
  },
  {
    id: 'morning-peaks',
    name: '初晨朝阳山川',
    category: 'nature',
    tagline: '晨曦暖阳下的青绿山峦与溪流',
    defaultPaletteId: 'morning-valley',
  },
  {
    id: 'cute-geo-bear',
    name: '极简奶白小熊',
    category: 'pure',
    tagline: '告别暗黑泥土色，软糯纯净几何',
    defaultPaletteId: 'pure-azure',
  },
  {
    id: 'flamingo-lake',
    name: '碧湖火烈鸟',
    category: 'nature',
    tagline: '清澈微凉水波与粉红优雅身姿',
    defaultPaletteId: 'mint-oasis',
  },
  {
    id: 'pop-guitar',
    name: '夏日活力吉他',
    category: 'pop',
    tagline: '亮粉配薄荷绿，音符跳跃',
    defaultPaletteId: 'candy-drum',
  },
];
