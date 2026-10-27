import React, {
  createContext,
  useContext,
  useRef,
  useCallback,
  useEffect,
} from 'react';
import type { MenuItemRecord } from './types';

export interface MenuCollectionContextValue {
  registerItem: (item: MenuItemRecord) => () => void;
  getItems: () => MenuItemRecord[];
}

export const MenuCollectionContext =
  createContext<MenuCollectionContextValue | null>(null);

export interface MenuCollectionProviderProps {
  children: React.ReactNode;
}

/**
 * 声明式 JSX 子项自动注册收集器 Provider
 * 收集挂载的所有子项，基于 compareDocumentPosition 严格按 DOM 物理顺序排序
 */
export const MenuCollectionProvider: React.FC<MenuCollectionProviderProps> = ({
  children,
}) => {
  const itemsMapRef = useRef<Map<string, MenuItemRecord>>(new Map());

  const registerItem = useCallback((item: MenuItemRecord) => {
    itemsMapRef.current.set(item.id, item);
    return () => {
      itemsMapRef.current.delete(item.id);
    };
  }, []);

  const getItems = useCallback(() => {
    return Array.from(itemsMapRef.current.values()).sort((a, b) => {
      const elA = a.ref?.current;
      const elB = b.ref?.current;
      if (!elA || !elB) {
        if (!elA && !elB) return 0;
        return !elA ? 1 : -1;
      }
      if (elA === elB) return 0;
      const position = elA.compareDocumentPosition(elB);
      if (position & Node.DOCUMENT_POSITION_DISCONNECTED) return 0;
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
        return -1; // elA 在 DOM 树中位于 elB 之前
      }
      if (position & Node.DOCUMENT_POSITION_PRECEDING) {
        return 1; // elA 在 DOM 树中位于 elB 之后
      }
      return 0;
    });
  }, []);

  return (
    <MenuCollectionContext.Provider value={{ registerItem, getItems }}>
      {children}
    </MenuCollectionContext.Provider>
  );
};

export function useMenuCollection(): MenuCollectionContextValue | null {
  return useContext(MenuCollectionContext);
}

/**
 * 声明式子项注册 Hook：在挂载或属性变化时向 MenuCollectionContext 注册/更新自身，卸载时自动注销
 */
export function useCollectionItem(item: MenuItemRecord): void {
  const collection = useMenuCollection();

  useEffect(() => {
    if (!collection) return;
    return collection.registerItem(item);
  }, [
    collection,
    item.id,
    item.disabled,
    item.textValue,
    item.isSeparator,
    item.hasSubmenu,
    item.isSubmenuOpen,
    item.role,
  ]);
}
