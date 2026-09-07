import React, { useState, useMemo, useRef } from 'react';
import type { AvatarDefinition } from '@oneworks/avatar';
import { Avatar } from '@oneworks/avatar-react';
import { BlenderViewport } from './BlenderViewport';
import {
  ALL_3D_ANIMALS,
  CATEGORIES,
  CURATED_SUNLIT_PALETTES,
  buildComplete3DAnimalDefinition,
  type AnimalPresetInfo,
} from '../engine/animalFactory';
import {
  Palette,
  Eye,
  Sun,
  Smile,
  Sparkles,
  ChevronLeft,
  ChevronRight,
  Circle,
  Square,
  MoveHorizontal,
  MoveVertical,
  RotateCw,
  Compass,
  Minimize2,
  Grid,
} from 'lucide-react';
import styles from './FullAvatarEditor.module.css';

interface FullAvatarEditorProps {
  definition: AvatarDefinition;
  onDefinitionChange: (definition: AvatarDefinition) => void;
}

// 优化：拖拽时冻结缩略图计算，避免 4 个额外 Avatar 重复进行 3D CPU 渲染
const DockPreviews = React.memo(function DockPreviews({
  definition,
  isDragging,
}: {
  definition: AvatarDefinition;
  isDragging: boolean;
}) {
  const lastDefRef = useRef(definition);
  if (!isDragging) {
    lastDefRef.current = definition;
  }
  const displayDef = isDragging ? lastDefRef.current : definition;

  return (
    <div className={styles.dockSizes}>
      <div className={styles.dockItem}>
        <div className={styles.dockAvatarRing} style={{ width: 22, height: 22 }}>
          <Avatar definition={displayDef} interactive={false} />
        </div>
        <span className={styles.dockItemText}>22</span>
      </div>
      <div className={styles.dockItem}>
        <div className={styles.dockAvatarRing} style={{ width: 34, height: 34 }}>
          <Avatar definition={displayDef} interactive={false} />
        </div>
        <span className={styles.dockItemText}>34</span>
      </div>
      <div className={styles.dockItem}>
        <div className={styles.dockAvatarRing} style={{ width: 46, height: 46 }}>
          <Avatar definition={displayDef} interactive={false} />
        </div>
        <span className={styles.dockItemText}>46</span>
      </div>
      <div className={styles.dockItem}>
        <div className={styles.dockAvatarRing} style={{ width: 62, height: 62 }}>
          <Avatar definition={displayDef} interactive={false} />
        </div>
        <span className={styles.dockItemText}>62</span>
      </div>
    </div>
  );
}, (prev, next) => {
  // 拖拽中直接阻断渲染，释放 80% CPU 占用
  if (next.isDragging) return true;
  return prev.definition === next.definition && prev.isDragging === next.isDragging;
});

export function FullAvatarEditor({
  definition,
  onDefinitionChange,
}: FullAvatarEditorProps) {
  const [activeTab, setActiveTab] = useState<'species' | 'palette' | 'face' | 'lighting'>('species');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [isViewportDragging, setIsViewportDragging] = useState(false);

  const filteredAnimals = useMemo(() => {
    if (selectedCategory === 'all') return ALL_3D_ANIMALS;
    return ALL_3D_ANIMALS.filter(a => a.category === selectedCategory);
  }, [selectedCategory]);

  const scene = definition.scene;
  const currentPreset = (definition.metadata?.id || scene.entity.preset) as any;
  const currentPaletteId = scene.appearance.paletteId;
  const currentFrame = scene.camera.frame;
  const face = scene.face as Record<string, any>;
  const lighting = scene.lighting;

  const currentAnimalIndex = ALL_3D_ANIMALS.findIndex(a => a.id === currentPreset);
  const currentAnimal = ALL_3D_ANIMALS[currentAnimalIndex >= 0 ? currentAnimalIndex : 0];

  // 1. 切换动物物种 (完整重装全部 3D 部件)
  const handleSelectAnimal = (animal: AnimalPresetInfo) => {
    const freshDef = buildComplete3DAnimalDefinition(
      animal.id,
      currentPaletteId,
      currentFrame
    );
    onDefinitionChange({
      ...freshDef,
      scene: {
        ...freshDef.scene,
        view: { ...scene.view },
      },
    });
  };

  const handlePrevAnimal = () => {
    const nextIdx = (currentAnimalIndex - 1 + ALL_3D_ANIMALS.length) % ALL_3D_ANIMALS.length;
    handleSelectAnimal(ALL_3D_ANIMALS[nextIdx]);
  };

  const handleNextAnimal = () => {
    const nextIdx = (currentAnimalIndex + 1) % ALL_3D_ANIMALS.length;
    handleSelectAnimal(ALL_3D_ANIMALS[nextIdx]);
  };

  // 2. 切换调色盘
  const handleSelectPalette = (paletteId: string) => {
    const freshDef = buildComplete3DAnimalDefinition(
      currentPreset,
      paletteId,
      currentFrame
    );
    onDefinitionChange({
      ...freshDef,
      scene: {
        ...freshDef.scene,
        face: { ...scene.face },
        view: { ...scene.view },
        lighting: { ...scene.lighting },
      },
    });
  };

  // 3. 切换画框形状
  const handleSelectFrame = (frame: 'circle' | 'rounded' | 'square') => {
    onDefinitionChange({
      ...definition,
      scene: {
        ...scene,
        camera: {
          ...scene.camera,
          frame,
        },
      },
    });
  };

  // 4. 更新五官参数
  const updateFaceParam = (key: string, value: any) => {
    onDefinitionChange({
      ...definition,
      scene: {
        ...scene,
        face: {
          ...scene.face,
          [key]: value,
        },
      },
    });
  };

  // 5. 更新光照参数
  const updateLightingParam = (key: string, value: any) => {
    onDefinitionChange({
      ...definition,
      scene: {
        ...scene,
        lighting: {
          ...scene.lighting,
          [key]: value,
        },
      },
    });
  };

  // 6. 更新身材锥度
  const updateBottomTaper = (bottomTaper: number) => {
    onDefinitionChange({
      ...definition,
      scene: {
        ...scene,
        appearance: {
          ...scene.appearance,
          bottomTaper,
        },
      },
    });
  };

  // 7. 动效测试 (眨眼)
  const triggerBlink = () => {
    const originalHeight = face.height ?? 32;
    updateFaceParam('height', 4);
    window.setTimeout(() => updateFaceParam('height', originalHeight), 300);
  };

  // 8. 动效测试 (大笑)
  const triggerSmile = () => {
    const originalCurve = face.mouthCurve ?? 30;
    updateFaceParam('mouthCurve', 95);
    window.setTimeout(() => updateFaceParam('mouthCurve', originalCurve), 800);
  };

  // 9. 动效测试 (好奇歪头)
  const triggerTilt = () => {
    const originalRoll = scene.view.roll ?? 0;
    onDefinitionChange({
      ...definition,
      scene: {
        ...scene,
        view: {
          ...scene.view,
          roll: 0.28,
        },
      },
    });
    window.setTimeout(() => {
      onDefinitionChange({
        ...definition,
        scene: {
          ...scene,
          view: {
            ...scene.view,
            roll: originalRoll,
          },
        },
      });
    }, 700);
  };

  return (
    <div className={styles.editorContainer}>
      {/* ================= 左列：Blender 3D 交互视口 + 快捷工具栏 + 实测缩略 ================= */}
      <div className={styles.leftColumn}>
        <div className={styles.viewportCard}>
          {/* Blender 视口控制器 */}
          <BlenderViewport
            definition={definition}
            size={310}
            onDefinitionChange={onDefinitionChange}
            onDragStateChange={setIsViewportDragging}
          />

          {/* 视口下方微型工具条：物种快速前后切换 + 3个表情快捷图标 */}
          <div className={styles.stageActionRow}>
            <div className={styles.stageAnimalSwitch}>
              <button
                className={styles.stageArrowBtn}
                onClick={handlePrevAnimal}
                title="上一个物种"
              >
                <ChevronLeft size={16} />
              </button>
              <div className={styles.stageAnimalBadge}>
                <span style={{ fontSize: 18 }}>{currentAnimal?.emoji}</span>
                <span className={styles.stageAnimalName}>{currentAnimal?.name}</span>
              </div>
              <button
                className={styles.stageArrowBtn}
                onClick={handleNextAnimal}
                title="下一个物种"
              >
                <ChevronRight size={16} />
              </button>
            </div>

            <div className={styles.stageAnimGroup}>
              <button className={styles.stageIconBtn} onClick={triggerBlink} title="眨眼">
                <Eye size={15} />
              </button>
              <button className={styles.stageIconBtn} onClick={triggerSmile} title="微笑">
                <Smile size={15} />
              </button>
              <button className={styles.stageIconBtn} onClick={triggerTilt} title="歪头">
                <Sparkles size={15} />
              </button>
            </div>
          </div>
        </div>

        {/* 视口下方实测微型多尺寸卡 (极简纯图标与数字，拖拽中自动冻结高负载) */}
        <div className={styles.dockCard}>
          <DockPreviews definition={definition} isDragging={isViewportDragging} />
        </div>
      </div>

      {/* ================= 右列：极简四格检查器 ================= */}
      <div className={styles.rightColumn}>
        {/* 顶部纯图标/极简标签切换 */}
        <div className={styles.inspectorTabs}>
          <button
            className={`${styles.inspectorTabBtn}${activeTab === 'species' ? ` ${styles.inspectorTabBtnActive}` : ''}`}
            onClick={() => setActiveTab('species')}
            title="3D 物种"
          >
            <Sparkles size={15} />
            <span>物种</span>
          </button>
          <button
            className={`${styles.inspectorTabBtn}${activeTab === 'palette' ? ` ${styles.inspectorTabBtnActive}` : ''}`}
            onClick={() => setActiveTab('palette')}
            title="配色与画框"
          >
            <Palette size={15} />
            <span>配色</span>
          </button>
          <button
            className={`${styles.inspectorTabBtn}${activeTab === 'face' ? ` ${styles.inspectorTabBtnActive}` : ''}`}
            onClick={() => setActiveTab('face')}
            title="五官精调"
          >
            <Smile size={15} />
            <span>五官</span>
          </button>
          <button
            className={`${styles.inspectorTabBtn}${activeTab === 'lighting' ? ` ${styles.inspectorTabBtnActive}` : ''}`}
            onClick={() => setActiveTab('lighting')}
            title="光影与体态"
          >
            <Sun size={15} />
            <span>光影</span>
          </button>
        </div>

        {/* 1. 实体物种选择器 */}
        {activeTab === 'species' && (
          <div className={styles.panelCard}>
            {/* 分类过滤条 */}
            <div className={styles.categoryFilterRow}>
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

            {/* 32 物种网格 */}
            <div className={styles.speciesGrid}>
              {filteredAnimals.map(animal => {
                const isSelected = animal.id === currentPreset;
                return (
                  <div
                    key={animal.id}
                    className={`${styles.speciesCard}${isSelected ? ` ${styles.speciesCardActive}` : ''}`}
                    onClick={() => handleSelectAnimal(animal)}
                  >
                    <span className={styles.speciesEmoji}>{animal.emoji}</span>
                    <span className={styles.speciesName}>{animal.name}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 2. 阳光调色板与画框 */}
        {activeTab === 'palette' && (
          <div className={styles.panelCard}>
            {/* 调色盘网格 */}
            <div className={styles.paletteGrid}>
              {CURATED_SUNLIT_PALETTES.map(p => {
                const isActive = p.id === currentPaletteId;
                return (
                  <div
                    key={p.id}
                    className={`${styles.paletteItem}${isActive ? ` ${styles.paletteItemActive}` : ''}`}
                    onClick={() => handleSelectPalette(p.id)}
                    title={p.inspiration}
                  >
                    <div className={styles.swatchDual}>
                      <div className={styles.swatchBg} style={{ background: p.cameraBackground }} />
                      <div className={styles.swatchBody} style={{ background: p.bodyBase }} />
                      <div className={styles.swatchAccent} style={{ background: p.accent }} />
                    </div>
                    <div className={styles.paletteTextCol}>
                      <span className={styles.paletteTitle}>{p.name}</span>
                      <span className={styles.paletteSub}>{p.inspiration.split(' · ')[0]}</span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 画框外轮廓 */}
            <div className={styles.frameSection}>
              <div className={styles.btnGroup}>
                <button
                  className={`${styles.toggleBtn}${currentFrame === 'circle' ? ` ${styles.toggleBtnActive}` : ''}`}
                  onClick={() => handleSelectFrame('circle')}
                  title="圆形"
                >
                  <Circle size={16} />
                </button>
                <button
                  className={`${styles.toggleBtn}${currentFrame === 'rounded' ? ` ${styles.toggleBtnActive}` : ''}`}
                  onClick={() => handleSelectFrame('rounded')}
                  title="圆角"
                  style={{ borderRadius: 8 }}
                >
                  <Square size={16} style={{ borderRadius: 4 }} />
                </button>
                <button
                  className={`${styles.toggleBtn}${currentFrame === 'square' ? ` ${styles.toggleBtnActive}` : ''}`}
                  onClick={() => handleSelectFrame('square')}
                  title="方形"
                >
                  <Square size={16} />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 3. 五官细节调整 */}
        {activeTab === 'face' && (
          <div className={styles.panelCard}>
            <div className={styles.controlsGrid}>
              <div className={styles.controlField}>
                <div className={styles.fieldLabelRow}>
                  <span className={styles.fieldLabel}>
                    <Eye size={13} />
                    间距
                  </span>
                  <span className={styles.fieldValue}>{face.gap ?? 42}px</span>
                </div>
                <input
                  type="range"
                  min="24"
                  max="64"
                  value={face.gap ?? 42}
                  className={styles.slider}
                  onChange={e => updateFaceParam('gap', Number(e.target.value))}
                />
              </div>

              <div className={styles.controlField}>
                <div className={styles.fieldLabelRow}>
                  <span className={styles.fieldLabel}>
                    <MoveVertical size={13} />
                    眼高
                  </span>
                  <span className={styles.fieldValue}>{face.height ?? 32}px</span>
                </div>
                <input
                  type="range"
                  min="16"
                  max="52"
                  value={face.height ?? 32}
                  className={styles.slider}
                  onChange={e => updateFaceParam('height', Number(e.target.value))}
                />
              </div>

              <div className={styles.controlField}>
                <div className={styles.fieldLabelRow}>
                  <span className={styles.fieldLabel}>
                    <MoveHorizontal size={13} />
                    眼宽
                  </span>
                  <span className={styles.fieldValue}>{face.width ?? 22}px</span>
                </div>
                <input
                  type="range"
                  min="12"
                  max="36"
                  value={face.width ?? 22}
                  className={styles.slider}
                  onChange={e => updateFaceParam('width', Number(e.target.value))}
                />
              </div>

              <div className={styles.controlField}>
                <div className={styles.fieldLabelRow}>
                  <span className={styles.fieldLabel}>
                    <RotateCw size={13} />
                    倾角
                  </span>
                  <span className={styles.fieldValue}>{face.leftEyeRotation ?? 0}°</span>
                </div>
                <input
                  type="range"
                  min="-25"
                  max="25"
                  value={face.leftEyeRotation ?? 0}
                  className={styles.slider}
                  onChange={e => updateFaceParam('leftEyeRotation', Number(e.target.value))}
                />
              </div>

              <div className={styles.controlField}>
                <div className={styles.fieldLabelRow}>
                  <span className={styles.fieldLabel}>
                    <Smile size={13} />
                    微笑
                  </span>
                  <span className={styles.fieldValue}>{face.mouthCurve ?? 30}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={face.mouthCurve ?? 30}
                  className={styles.slider}
                  onChange={e => updateFaceParam('mouthCurve', Number(e.target.value))}
                />
              </div>

              <div className={styles.controlField}>
                <div className={styles.fieldLabelRow}>
                  <span className={styles.fieldLabel}>
                    <MoveHorizontal size={13} />
                    唇宽
                  </span>
                  <span className={styles.fieldValue}>{face.mouthWidth ?? 16}px</span>
                </div>
                <input
                  type="range"
                  min="8"
                  max="36"
                  value={face.mouthWidth ?? 16}
                  className={styles.slider}
                  onChange={e => updateFaceParam('mouthWidth', Number(e.target.value))}
                />
              </div>

              <div className={styles.controlField}>
                <div className={styles.fieldLabelRow}>
                  <span className={styles.fieldLabel}>
                    <MoveVertical size={13} />
                    唇位
                  </span>
                  <span className={styles.fieldValue}>{face.mouthY ?? 36}px</span>
                </div>
                <input
                  type="range"
                  min="20"
                  max="60"
                  value={face.mouthY ?? 36}
                  className={styles.slider}
                  onChange={e => updateFaceParam('mouthY', Number(e.target.value))}
                />
              </div>

              <div className={styles.controlField}>
                <div className={styles.fieldLabelRow}>
                  <span className={styles.fieldLabel}>
                    <MoveVertical size={13} />
                    鼻位
                  </span>
                  <span className={styles.fieldValue}>{face.noseY ?? 26}px</span>
                </div>
                <input
                  type="range"
                  min="14"
                  max="45"
                  value={face.noseY ?? 26}
                  className={styles.slider}
                  onChange={e => updateFaceParam('noseY', Number(e.target.value))}
                />
              </div>
            </div>
          </div>
        )}

        {/* 4. 光影方位与身材锥度 */}
        {activeTab === 'lighting' && (
          <div className={styles.panelCard}>
            <div className={styles.controlsGrid}>
              <div className={styles.controlField}>
                <div className={styles.fieldLabelRow}>
                  <span className={styles.fieldLabel}>
                    <Compass size={13} />
                    方位角
                  </span>
                  <span className={styles.fieldValue}>{lighting.azimuth}°</span>
                </div>
                <input
                  type="range"
                  min="-180"
                  max="180"
                  value={lighting.azimuth}
                  className={styles.slider}
                  onChange={e => updateLightingParam('azimuth', Number(e.target.value))}
                />
              </div>

              <div className={styles.controlField}>
                <div className={styles.fieldLabelRow}>
                  <span className={styles.fieldLabel}>
                    <Sun size={13} />
                    仰角
                  </span>
                  <span className={styles.fieldValue}>{lighting.elevation}°</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="90"
                  value={lighting.elevation}
                  className={styles.slider}
                  onChange={e => updateLightingParam('elevation', Number(e.target.value))}
                />
              </div>

              <div className={styles.controlField}>
                <div className={styles.fieldLabelRow}>
                  <span className={styles.fieldLabel}>
                    <Minimize2 size={13} />
                    锥度
                  </span>
                  <span className={styles.fieldValue}>{scene.appearance.bottomTaper ?? 0}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="70"
                  value={scene.appearance.bottomTaper ?? 0}
                  className={styles.slider}
                  onChange={e => updateBottomTaper(Number(e.target.value))}
                />
              </div>

              <div className={styles.controlField}>
                <div className={styles.fieldLabelRow}>
                  <span className={styles.fieldLabel}>
                    <Grid size={13} />
                    密度
                  </span>
                  <span className={styles.fieldValue}>{lighting.gridDensity}</span>
                </div>
                <input
                  type="range"
                  min="15"
                  max="35"
                  value={lighting.gridDensity}
                  className={styles.slider}
                  onChange={e => updateLightingParam('gridDensity', Number(e.target.value))}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
