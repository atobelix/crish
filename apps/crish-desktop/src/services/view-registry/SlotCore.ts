import type {
  StandardSlotId,
  OwnerPropsOf,
  SingleSlotEntry,
  ListSlotEntry,
  KeyedSlotEntry,
  ChainSlotEntry,
} from './SlotTypes';

export class SlotCoreImpl {
  private singleSlots = new Map<string, SingleSlotEntry[]>();
  private listSlots = new Map<string, ListSlotEntry[]>();
  private keyedSlots = new Map<string, Map<string, KeyedSlotEntry>>();
  private chainSlots = new Map<string, ChainSlotEntry[]>();
  private abdicatedSingleEntries = new Map<string, Set<string>>();
  private versions = new Map<string, number>();
  private listeners = new Map<string, Set<() => void>>();

  public registerSingle<K extends StandardSlotId | string>(
    slotKey: K,
    entry: SingleSlotEntry<OwnerPropsOf<K>>
  ): () => void {
    const list = this.singleSlots.get(slotKey) ?? [];
    const filtered = list.filter((e) => e.id !== entry.id);
    filtered.push(entry);
    filtered.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    this.singleSlots.set(slotKey, filtered);
    this.bump(slotKey);
    return () => {
      const cur = this.singleSlots.get(slotKey) ?? [];
      this.singleSlots.set(
        slotKey,
        cur.filter((e) => e.id !== entry.id)
      );
      this.bump(slotKey);
    };
  }

  public registerList<K extends StandardSlotId | string>(
    slotKey: K,
    entry: ListSlotEntry<OwnerPropsOf<K>>
  ): () => void {
    const list = this.listSlots.get(slotKey) ?? [];
    // 支持按 id 覆盖
    const filtered = list.filter((e) => e.id !== entry.id);
    filtered.push(entry);
    filtered.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    this.listSlots.set(slotKey, filtered);
    this.bump(slotKey);
    return () => {
      const cur = this.listSlots.get(slotKey) ?? [];
      this.listSlots.set(
        slotKey,
        cur.filter((e) => e.id !== entry.id)
      );
      this.bump(slotKey);
    };
  }

  public registerKeyed<K extends StandardSlotId | string>(
    slotKey: K,
    entry: KeyedSlotEntry<OwnerPropsOf<K>>
  ): () => void {
    const map =
      this.keyedSlots.get(slotKey) ?? new Map<string, KeyedSlotEntry>();
    map.set(entry.key, entry);
    this.keyedSlots.set(slotKey, map);
    this.bump(slotKey);
    return () => {
      const m = this.keyedSlots.get(slotKey);
      if (m) {
        m.delete(entry.key);
        this.bump(slotKey);
      }
    };
  }

  public registerChain<K extends StandardSlotId | string>(
    slotKey: K,
    entry: ChainSlotEntry<OwnerPropsOf<K>>
  ): () => void {
    const list = this.chainSlots.get(slotKey) ?? [];
    const filtered = list.filter((e) => e.id !== entry.id);
    filtered.push(entry);
    this.chainSlots.set(slotKey, filtered);
    this.bump(slotKey);
    return () => {
      const cur = this.chainSlots.get(slotKey) ?? [];
      this.chainSlots.set(
        slotKey,
        cur.filter((e) => e.id !== entry.id)
      );
      this.bump(slotKey);
    };
  }

  /** 影子退让容灾协议：当前胜出者异常时退让给次优 entry */
  public abdicateSingle(slotKey: string, entryId: string): void {
    let set = this.abdicatedSingleEntries.get(slotKey);
    if (!set) {
      set = new Set();
      this.abdicatedSingleEntries.set(slotKey, set);
    }
    set.add(entryId);
    this.bump(slotKey);
  }

  /** 重置退让状态 */
  public resetAbdication(slotKey: string): void {
    this.abdicatedSingleEntries.delete(slotKey);
    this.bump(slotKey);
  }

  public getVersion(slotKey: string): number {
    return this.versions.get(slotKey) ?? 0;
  }

  public subscribe(slotKey: string, cb: () => void): () => void {
    let set = this.listeners.get(slotKey);
    if (!set) {
      set = new Set();
      this.listeners.set(slotKey, set);
    }
    set.add(cb);
    return () => {
      set?.delete(cb);
    };
  }

  private bump(slotKey: string): void {
    this.versions.set(slotKey, (this.versions.get(slotKey) ?? 0) + 1);
    this.listeners.get(slotKey)?.forEach((cb) => cb());
  }

  public getSingle(slotKey: string): SingleSlotEntry | undefined {
    const list = this.singleSlots.get(slotKey) ?? [];
    const abdicated = this.abdicatedSingleEntries.get(slotKey);
    if (!abdicated || abdicated.size === 0) {
      return list[0];
    }
    return list.find((e) => !abdicated.has(e.id));
  }

  public getList(slotKey: string): ListSlotEntry[] {
    return this.listSlots.get(slotKey) ?? [];
  }

  public getKeyed(
    slotKey: string,
    entryKey: string
  ): KeyedSlotEntry | undefined {
    return this.keyedSlots.get(slotKey)?.get(entryKey);
  }

  public getChain(slotKey: string, context: any): ChainSlotEntry | undefined {
    const list = this.chainSlots.get(slotKey) ?? [];
    return list.find((e) => e.select(context));
  }

  /** 清空所有插槽（用于测试隔离） */
  public clear(): void {
    this.singleSlots.clear();
    this.listSlots.clear();
    this.keyedSlots.clear();
    this.chainSlots.clear();
    this.abdicatedSingleEntries.clear();
    this.versions.clear();
    this.listeners.clear();
  }
}

export const slotCore = new SlotCoreImpl();
