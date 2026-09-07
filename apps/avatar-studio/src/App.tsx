import { useState, useMemo } from 'react';
import { Avatar } from '@oneworks/avatar-react';
import '@oneworks/avatar-react/style.css';
import type { AvatarDefinition } from '@oneworks/avatar';
import { FullAvatarEditor } from './components/FullAvatarEditor';

import {
  Sparkles,
  LayoutGrid,
  Code2,
  Dices,
  Copy,
  Check,
  Sun,
  CheckCircle2,
} from 'lucide-react';
import styles from './App.module.css';

import {
  ALL_3D_ANIMALS,
  CATEGORIES,
  CURATED_SUNLIT_PALETTES,
  buildComplete3DAnimalDefinition,
  type AnimalPresetInfo,
} from './engine/animalFactory';

export function App() {
  const [activeTab, setActiveTab] = useState<'editor' | 'gallery' | 'embed'>('editor');

  // 分类与当前选中的真实 3D 动物形象
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [selectedAnimal, setSelectedAnimal] = useState<AnimalPresetInfo>(ALL_3D_ANIMALS[0]);
  const [selectedPaletteId, setSelectedPaletteId] = useState('sky-white');
  const [frame] = useState<'circle' | 'rounded' | 'square'>('circle');

  const filteredAnimals = useMemo(() => {
    if (selectedCategory === 'all') return ALL_3D_ANIMALS;
    return ALL_3D_ANIMALS.filter(a => a.category === selectedCategory);
  }, [selectedCategory]);

  // 统一的响应式 3D Definition (供双向同步)
  const [liveDefinition, setLiveDefinition] = useState<AvatarDefinition>(() =>
    buildComplete3DAnimalDefinition(ALL_3D_ANIMALS[0].id, 'sky-white', 'circle')
  );

  // 提示状态
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    window.setTimeout(() => setToastMsg(null), 2000);
  };

  const handleSelectAnimal = (animal: AnimalPresetInfo) => {
    setSelectedAnimal(animal);
    const fresh = buildComplete3DAnimalDefinition(animal.id, selectedPaletteId, frame);
    setLiveDefinition({
      ...fresh,
      scene: {
        ...fresh.scene,
        view: { ...liveDefinition.scene.view },
      },
    });
  };

  // 随机摇骰子
  const handleShuffle = () => {
    const randomAnimal = ALL_3D_ANIMALS[Math.floor(Math.random() * ALL_3D_ANIMALS.length)];
    const randomPalette = CURATED_SUNLIT_PALETTES[Math.floor(Math.random() * CURATED_SUNLIT_PALETTES.length)];

    setSelectedAnimal(randomAnimal);
    setSelectedPaletteId(randomPalette.id);
    const fresh = buildComplete3DAnimalDefinition(randomAnimal.id, randomPalette.id, frame);
    setLiveDefinition({
      ...fresh,
      scene: {
        ...fresh.scene,
        view: { ...liveDefinition.scene.view },
      },
    });
    showToast(`${randomAnimal.emoji} ${randomAnimal.name}`);
  };

  // 复制 Conex 移植代码
  const copyCode = async () => {
    const snippet = `// Conex 3D 用户头像组件
import { Avatar } from '@oneworks/avatar-react';
import '@oneworks/avatar-react/style.css';
import { buildComplete3DAnimalDefinition } from './engine/animalFactory';

export function User3DAvatar({ animal = '${selectedAnimal.id}', palette = '${selectedPaletteId}', size = 32 }) {
  const definition = buildComplete3DAnimalDefinition(animal, palette, '${frame}');

  return (
    <div style={{ width: size, height: size, borderRadius: '50%', overflow: 'hidden' }}>
      <Avatar definition={definition} interactive theme="light" />
    </div>
  );
}`;

    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      showToast('代码已复制');
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      showToast('复制失败');
    }
  };

  return (
    <div className={styles.container}>
      {/* 顶部导航 */}
      <header className={styles.header}>
        <div className={styles.brand}>
          <div className={styles.brandLogo}>
            <Sun size={18} strokeWidth={2.4} />
          </div>
          <span className={styles.brandTitle}>3D Avatar</span>
        </div>

        {/* 核心视图切换 */}
        <div className={styles.navTabs}>
          <button
            className={`${styles.tabBtn}${activeTab === 'editor' ? ` ${styles.tabBtnActive}` : ''}`}
            onClick={() => setActiveTab('editor')}
            title="3D 捏脸器"
          >
            <Sparkles size={15} />
            <span>捏脸器</span>
          </button>
          <button
            className={`${styles.tabBtn}${activeTab === 'gallery' ? ` ${styles.tabBtnActive}` : ''}`}
            onClick={() => setActiveTab('gallery')}
            title="萌宠画廊"
          >
            <LayoutGrid size={15} />
            <span>画廊</span>
          </button>
          <button
            className={`${styles.tabBtn}${activeTab === 'embed' ? ` ${styles.tabBtnActive}` : ''}`}
            onClick={() => setActiveTab('embed')}
            title="代码移植"
          >
            <Code2 size={15} />
            <span>代码</span>
          </button>
        </div>

        {/* 顶部快捷操作 */}
        <div className={styles.headerActions}>
          <button className={styles.iconBtn} onClick={handleShuffle} title="随机摇萌宠">
            <Dices size={16} />
          </button>
          <button className={styles.primaryBtn} onClick={() => setActiveTab('embed')} title="获取组件代码">
            <Code2 size={15} />
            <span>代码</span>
          </button>
        </div>
      </header>

      {/* 主视图 */}
      <main className={styles.main}>
        {/* ================= 视图 1：全功能 3D 捏脸器 (默认首页) ================= */}
        {activeTab === 'editor' && (
          <FullAvatarEditor
            definition={liveDefinition}
            onDefinitionChange={setLiveDefinition}
          />
        )}

        {/* ================= 视图 2：3D 萌宠画廊 ================= */}
        {activeTab === 'gallery' && (
          <div>
            <div className={styles.categoryBar}>
              {CATEGORIES.map(cat => (
                <button
                  key={cat.id}
                  className={`${styles.categoryPill}${selectedCategory === cat.id ? ` ${styles.categoryPillActive}` : ''}`}
                  onClick={() => setSelectedCategory(cat.id)}
                >
                  {cat.label}
                </button>
              ))}
            </div>

            <div className={styles.galleryGrid}>
              {filteredAnimals.map((animal) => {
                const itemDef = buildComplete3DAnimalDefinition(animal.id, selectedPaletteId, 'circle');

                return (
                  <div
                    key={animal.id}
                    className={styles.galleryCard}
                    onClick={() => {
                      handleSelectAnimal(animal);
                      setActiveTab('editor');
                      showToast(`${animal.emoji} ${animal.name}`);
                    }}
                  >
                    <div className={styles.cardAvatarBox} style={{ width: 110, height: 110 }}>
                      <Avatar
                        definition={itemDef}
                        interactive={false}
                        theme="light"
                      />
                    </div>
                    <div className={styles.cardName}>
                      {animal.emoji} {animal.name}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ================= 视图 3：代码移植 ================= */}
        {activeTab === 'embed' && (
          <div className={styles.embedContainer}>
            <div className={styles.codeBlockCard}>
              <div className={styles.codeHeader}>
                <span className={styles.codeTitle}>User3DAvatar.tsx</span>
                <button className={styles.iconBtn} onClick={copyCode}>
                  {copied ? <Check size={14} color="#10B981" /> : <Copy size={14} />}
                  <span>{copied ? '已复制' : '复制'}</span>
                </button>
              </div>
              <pre className={styles.preBlock}>
{`import { Avatar } from '@oneworks/avatar-react';
import '@oneworks/avatar-react/style.css';
import { buildComplete3DAnimalDefinition } from './engine/animalFactory';

export function User3DAvatar({ animal = '${selectedAnimal.id}', palette = '${selectedPaletteId}', size = 32 }) {
  const definition = buildComplete3DAnimalDefinition(animal, palette, '${frame}');

  return (
    <div style={{ width: size, height: size, borderRadius: '50%', overflow: 'hidden' }}>
      <Avatar definition={definition} interactive theme="light" />
    </div>
  );
}`}
              </pre>
            </div>
          </div>
        )}
      </main>

      {/* 吐司提示 */}
      {toastMsg && (
        <div className={styles.toast}>
          <CheckCircle2 size={16} color="#38B6FF" />
          <span>{toastMsg}</span>
        </div>
      )}
    </div>
  );
}

export default App;
