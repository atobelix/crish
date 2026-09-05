/**
 * 模型名称智能自适应缩写引擎（SADA-Omni 2.0 / MUDT 终极融合版）。
 * 
 * 核心特性：
 * 1. 纯函数、无状态、零副作用、可独立单测；
 * 2. 严格守卫代际版本号（1.2, 1.3, 3.5, 4o, r1）为 Hard Pin 不可变锚点；
 * 3. 彻底剥离渠道前缀、时间戳快照（-\d{8}）与通道冗余（-contributor）；
 * 4. 零先验字典泛化：对未知专有名词采用音节辅音骨架抽脂算法（Consonant Skeleton）；
 * 5. MUDT 最小唯一判别差分消歧器，防止同屏同前缀模型撞名；
 * 6. 输出三阶标准文本：Standard (L1)、Compact (L2)、Micro (L3)。
 */

export interface ModelAbbrResult {
  /** 原始标识符 */
  rawId: string;
  /** 清洗物理噪音后的纯净核心 Slug */
  cleanId: string;
  /** L1: 规范去噪态（18~26 字符，适合展开抽屉或详细设置） */
  standard: string;
  /** L2: 紧凑特征态（12~18 字符，适合顶栏卡片与中等宽度下拉框） */
  compact: string;
  /** L3: 极微胶囊态（6~10 字符，适合 60~100px 极窄状态栏徽标） */
  micro: string;
  /** 识别出的主品牌/家族 */
  family: string;
  /** 识别出的版本代际（Hard Pin 锚点） */
  version: string;
  /** 识别出的规格档位 */
  tier: string;
  /** 识别出的参数量或 MoE 结构（如 70B, 8x7B） */
  scale: string;
}

export interface ModelAbbrOptions {
  /** 显式覆盖指定的 displayName（如果有） */
  displayName?: string | null;
  /** 是否处于同胞候选集消歧上下文中 */
  disambiguationDiffToken?: string;
}

/** 知名核心品牌/家族映射表 */
const FAM_MAP: Record<string, { full: string; compact: string; micro: string }> = {
  claude: { full: 'Claude', compact: 'Claude', micro: 'C' },
  deepseek: { full: 'DeepSeek', compact: 'DS', micro: 'DS' },
  gpt: { full: 'GPT', compact: 'GPT', micro: 'G' },
  gemini: { full: 'Gemini', compact: 'Gemini', micro: 'Gem' },
  qwen: { full: 'Qwen', compact: 'Qwen', micro: 'QW' },
  llama: { full: 'Llama', compact: 'Llama', micro: 'Ll' },
  mistral: { full: 'Mistral', compact: 'Mistral', micro: 'Mis' },
  sensenova: { full: 'SenseNova', compact: 'Nova', micro: 'SN' },
  muse: { full: 'Muse', compact: 'Muse', micro: 'Muse' },
  grok: { full: 'Grok', compact: 'Grok', micro: 'Grk' },
};

/** 常见能力规格档位映射表 */
const TIER_MAP: Record<string, { full: string; compact: string; micro: string }> = {
  sonnet: { full: 'Sonnet', compact: 'Sonnet', micro: 'Snt' },
  haiku: { full: 'Haiku', compact: 'Haiku', micro: 'Hku' },
  opus: { full: 'Opus', compact: 'Opus', micro: 'Ops' },
  flash: { full: 'Flash', compact: 'Flash', micro: 'F' },
  pro: { full: 'Pro', compact: 'Pro', micro: 'P' },
  mini: { full: 'Mini', compact: 'Mini', micro: 'm' },
  spark: { full: 'Spark', compact: 'Spk', micro: 'Spk' },
  coder: { full: 'Coder', compact: 'Coder', micro: 'Code' },
  turbo: { full: 'Turbo', compact: 'Turbo', micro: 'Trb' },
  max: { full: 'Max', compact: 'Max', micro: 'Max' },
  plus: { full: 'Plus', compact: 'Plus', micro: 'Pls' },
  lite: { full: 'Lite', compact: 'Lite', micro: 'Lite' },
};

/**
 * 物理噪音清洗（安全剥离网关路由、组织前缀、本地文件路径及扩展名）
 */
export function stripPhysicalNoise(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';
  let s = raw.trim();
  // 超长输入防爆浆守卫（SEC-02）
  if (s.length > 256) {
    s = s.slice(0, 256);
  }

  // 1. 剥离本地路径 D:/xxx/ 或 C:\xxx\
  if (s.includes('/') || s.includes('\\')) {
    const parts = s.split(/[/\\]/);
    s = parts[parts.length - 1] || s;
  }

  // 2. 剥离协议前缀（如 ollama: 或 local:）
  if (s.includes(':')) {
    const parts = s.split(':');
    const firstPart = parts[0];
    if (firstPart && ['ollama', 'model', 'local', 'http', 'https'].includes(firstPart.toLowerCase())) {
      parts.shift();
    }
    s = parts.join(':');
  }

  // 3. 剥离容器扩展名（.gguf, .bin, .safetensors, .pt）
  s = s.replace(/\.(gguf|bin|safetensors|pt|ckpt)$/i, '');

  // 4. 剥离通道后缀（:beta, :free, :latest, @channel）
  s = s.replace(/:(beta|free|preview|latest)$/i, '');
  s = s.replace(/@\w+$/i, '');

  return s.trim();
}

/**
 * 零字典未知生词辅音骨架抽脂算法（Consonant Skeleton）
 * 规则：首字母保留 + 弱元音抽脂 + 重复辅音折叠，收敛至 maxLen 字符
 */
export function consonantSkeleton(word: string, maxLen = 4): string {
  if (!word || word.length <= maxLen) return word;
  const lower = word.toLowerCase();
  const first = lower[0];
  // 剥离除首字母外的全部元音 (a, e, i, o, u)
  const withoutVowels = lower.slice(1).replace(/[aeiou]/g, '');
  // 折叠相邻重复辅音（如 tt -> t, ss -> s）
  const dedupe = withoutVowels.replace(/(.)\1+/g, '$1');
  const res = first + dedupe;
  if (res.length <= maxLen) return res;
  return res.slice(0, maxLen);
}

/**
 * 复合词法分词器（严格保护浮点版本 1.2, 1.3, 3.5, 6.8，拆分驼峰与字母数字边界）
 */
export function tokenizeModelId(cleanId: string): string[] {
  if (!cleanId) return [];

  let s = cleanId;

  // 1. 保护 MoE 乘法算力模式 (如 8x7b, 16x8b, 8x22b)
  s = s.replace(/(\d+)x(\d+[bmk]?)/gi, '$1@@X@@$2');

  // 2. 保护常见连字符版本号 (如 claude-3-5-sonnet -> claude-3.5-sonnet)
  s = s.replace(/\b(\d+)-(\d+)\b/g, '$1.$2');

  // 3. 保护浮点版本 (如 1.2, 3.5, 6.8)
  s = s.replace(/(\d+)\.(\d+)/g, '$1@@DOT@@$2');

  // 4. 驼峰切分 (QwenCoder -> Qwen-Coder)
  s = s.replace(/([a-z])([A-Z])/g, '$1-$2');

  // 5. 字母与数字边界切分 (Llama3 -> Llama-3, 但保护 4o, o1, o3, r1, v3, v4)
  s = s.replace(/([a-zA-Z]+)(\d+)/g, (match, letters, num) => {
    if (['v', 'r', 'o'].includes(letters.toLowerCase()) && num.length <= 2) {
      return match;
    }
    if (letters.startsWith('@@') || letters.endsWith('@@')) return match;
    return `${letters}-${num}`;
  });
  s = s.replace(/(\d+)([a-zA-Z]+)/g, (match, num, letters) => {
    if (letters.toLowerCase() === 'o') return match;
    if (/^[bmk]$/i.test(letters)) return match;
    if (letters.startsWith('@@') || letters.endsWith('@@')) return match;
    return `${num}-${letters}`;
  });

  // 6. 多分隔符统一切分并还原
  return s
    .split(/[-_/\s:]+/)
    .map((t) => t.replace(/@@DOT@@/g, '.').replace(/@@X@@/g, 'x'))
    .filter(Boolean);
}

/**
 * 核心纯函数：智能自适应缩写计算
 */
export function abbreviateModel(
  rawId: string,
  options?: ModelAbbrOptions
): ModelAbbrResult {
  const cleanId = stripPhysicalNoise(rawId);
  if (!cleanId) {
    return {
      rawId: rawId || '',
      cleanId: '',
      standard: rawId || '',
      compact: rawId || '',
      micro: rawId || '',
      family: '',
      version: '',
      tier: '',
      scale: '',
    };
  }

  const tokens = tokenizeModelId(cleanId);

  let family = '';
  let version = '';
  let tier = '';
  let scale = '';
  let branch = '';

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    const low = t.toLowerCase();

    // 1. 过滤纯时间戳（如 20241022, 2025-02-19, 0731）与临时快照修饰
    if (
      /^\d{8}$/.test(t) ||
      /^\d{4}$/.test(t) ||
      /^\d{4}-\d{2}-\d{2}$/.test(t) ||
      ['latest', 'preview', 'instruct', 'chat', 'contributor', 'v1', 'v2', 'lora', 'distill'].includes(low)
    ) {
      continue;
    }

    // 2. 参数规模识别 (70B, 32B, 8x7B, 16x8B, 128K)
    if (/^(\d+x)?\d+(\.\d+)?[bmk]$/i.test(t)) {
      scale = t.toUpperCase();
      continue;
    }

    // 3. 版本代际识别 (1.2, 1.3, 3.5, 4o, r1, v3, v4, 6.8, 9.2) - Hard Pin 锚点
    if (
      /^[vr]?\d+(\.\d+)?$/i.test(t) ||
      /^\d+o$/i.test(t) ||
      /^r\d+$/i.test(t)
    ) {
      if (!version) {
        version = t.toUpperCase();
        continue;
      }
    }

    // 4. 品牌/家族识别
    if (!family) {
      if (FAM_MAP[low]) {
        family = FAM_MAP[low].full;
        continue;
      }
    }

    // 5. 档位识别
    if (TIER_MAP[low]) {
      if (!tier) {
        tier = TIER_MAP[low].full;
        continue;
      }
    }

    // 6. 未知生词处理
    if (!family) {
      family = t.charAt(0).toUpperCase() + t.slice(1);
    } else if (!branch) {
      branch = t;
    }
  }

  // 兜底保底
  if (!family) {
    const first = tokens[0];
    family = first ? first.charAt(0).toUpperCase() + first.slice(1) : 'Model';
  }

  // 风格特化策略（对齐用户明确指示）
  const lowFam = family.toLowerCase();
  const isClaude = lowFam.includes('claude');
  const isDeepSeek = lowFam.includes('deepseek');
  const isMuse = lowFam.includes('muse');

  // --- L1: Standard 规范去噪态 (18~26 字符) ---
  let standard = '';
  if (isDeepSeek && version && tier) {
    standard = `DeepSeek ${version.startsWith('V') ? version : 'V' + version} ${tier}`;
  } else if (isClaude && version && tier) {
    standard = `Claude ${version} ${tier}`;
  } else if (isMuse) {
    const spk = tier ? `${tier} ` : (branch ? `${branch.charAt(0).toUpperCase() + branch.slice(1)} ` : '');
    standard = `Muse ${spk}${version || ''}`.trim();
  } else {
    standard = `${family} ${version} ${tier} ${scale}`.replace(/\s+/g, ' ').trim();
  }

  // --- L2: Compact 紧凑特征态 (12~18 字符) ---
  let compact = '';
  if (isDeepSeek) {
    compact = `DS ${version.startsWith('V') ? version : 'V' + version} ${tier || scale || ''}`.trim();
  } else if (isClaude) {
    compact = `${version} ${tier}`;
  } else if (isMuse) {
    const spkShort = tier ? (TIER_MAP[tier.toLowerCase()]?.compact || tier) : (branch ? consonantSkeleton(branch, 3) : '');
    compact = `Muse ${version} ${spkShort}`.trim();
  } else {
    const shortFam = FAM_MAP[lowFam]?.compact || consonantSkeleton(family, 5);
    const shortTier = TIER_MAP[tier.toLowerCase()]?.compact || tier;
    compact = `${shortFam} ${version} ${shortTier || scale || ''}`.replace(/\s+/g, ' ').trim();
  }

  // --- L3: Micro 极微胶囊态 (6~10 字符) ---
  let micro = '';
  if (isDeepSeek) {
    const tierChar = tier ? tier.toUpperCase()[0] : '';
    micro = `DS ${version.startsWith('V') ? version : 'V' + version}${tierChar}`;
  } else if (isClaude) {
    const tierShort = TIER_MAP[tier.toLowerCase()]?.micro || (tier ? tier.slice(0, 3) : '');
    micro = `${version} ${tierShort}`;
  } else if (isMuse) {
    micro = `Muse ${version}`;
  } else {
    let microFam = FAM_MAP[lowFam]?.micro || consonantSkeleton(family, 3);
    microFam = microFam.charAt(0).toUpperCase() + microFam.slice(1);
    const microTier = TIER_MAP[tier.toLowerCase()]?.micro || (tier ? tier[0] : '');
    if (version && scale) {
      micro = `${microFam} ${version}-${scale}`.trim();
    } else if (scale) {
      micro = `${microFam} ${scale}`.trim();
    } else {
      micro = `${microFam} ${version}${microTier ? ' ' + microTier : ''}`.trim();
    }
  }

  // 若存在消歧差分 Token，回填消歧
  if (options?.disambiguationDiffToken) {
    const diff = options.disambiguationDiffToken;
    if (!compact.toLowerCase().includes(diff.toLowerCase())) {
      compact = `${compact} (${diff})`;
    }
    if (!micro.toLowerCase().includes(diff.toLowerCase())) {
      micro = `${micro}-${diff}`;
    }
  }

  return {
    rawId,
    cleanId,
    standard: standard || cleanId,
    compact: compact || standard || cleanId,
    micro: micro || compact || cleanId,
    family,
    version,
    tier,
    scale,
  };
}

/**
 * MUDT 候选列表动态消歧器（感知并存候选集合，杜绝同屏撞名）
 */
export function disambiguateModelList(
  entries: { id: string; name?: string }[]
): Map<string, ModelAbbrResult> {
  const resultMap = new Map<string, ModelAbbrResult>();
  if (!entries || entries.length === 0) return resultMap;

  // 1. 初步单模解析
  const initialList = entries.map((e) => ({
    entry: e,
    abbr: abbreviateModel(e.id, { displayName: e.name }),
  }));

  // 2. 检测 Micro 级别同名碰撞
  const microGroups = new Map<string, typeof initialList>();
  for (const item of initialList) {
    const m = item.abbr.micro;
    const group = microGroups.get(m) || [];
    group.push(item);
    microGroups.set(m, group);
  }

  // 3. 针对发生碰撞的近邻同族模型，提取 MUDT 差异特征
  for (const [, group] of microGroups.entries()) {
    if (group.length <= 1) {
      for (const item of group) {
        resultMap.set(item.entry.id, item.abbr);
      }
      continue;
    }

    // 碰撞发生：计算同族差异位
    for (const item of group) {
      const tokensA = tokenizeModelId(stripPhysicalNoise(item.entry.id));
      let diffToken = '';

      // 寻找唯一异构特征词
      for (const other of group) {
        if (other === item) continue;
        const tokensB = tokenizeModelId(stripPhysicalNoise(other.entry.id));
        const uniqueInA = tokensA.find((ta) => !tokensB.map((tb) => tb.toLowerCase()).includes(ta.toLowerCase()));
        if (uniqueInA) {
          diffToken = uniqueInA;
          break;
        }
      }

      // 提取日期后4位或辅音缩写作为消歧指纹
      let diffTag = '';
      if (diffToken) {
        const digits = diffToken.replace(/\D/g, '');
        if (digits.length >= 4) {
          diffTag = digits.slice(-4);
        } else {
          diffTag = consonantSkeleton(diffToken, 3);
        }
      }

      // 重新生成注入差分后的缩写
      const resolved = abbreviateModel(item.entry.id, {
        displayName: item.entry.name,
        disambiguationDiffToken: diffTag || undefined,
      });
      resultMap.set(item.entry.id, resolved);
    }
  }

  return resultMap;
}
