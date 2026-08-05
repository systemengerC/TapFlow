/**
 * 画布视图状态 store
 * 只管 UI 交互态：viewport / 当前工具 / 选择集。
 * 不持有业务实体（节点数据在 nodesStore），不自建契约传输类型。
 */
'use client';

import { create } from 'zustand';
import type { Uuid } from '@tapflow/contracts';

export type CanvasTool = 'select' | 'pan' | 'create';

export interface Viewport {
  x: number;
  y: number;
  scale: number;
}

interface CanvasState {
  viewport: Viewport;
  tool: CanvasTool;
  selectedNodeIds: Uuid[];

  setViewport: (v: Partial<Viewport>) => void;
  setTool: (t: CanvasTool) => void;
  setSelection: (ids: Uuid[]) => void;
  toggleSelection: (id: Uuid) => void;
  clearSelection: () => void;
}

export const useCanvasStore = create<CanvasState>((set) => ({
  viewport: { x: 0, y: 0, scale: 1 },
  tool: 'select',
  selectedNodeIds: [],

  setViewport: (v) =>
    set((s) => ({ viewport: { ...s.viewport, ...v } })),
  setTool: (t) => set({ tool: t }),
  setSelection: (ids) => set({ selectedNodeIds: ids }),
  toggleSelection: (id) =>
    set((s) => ({
      selectedNodeIds: s.selectedNodeIds.includes(id)
        ? s.selectedNodeIds.filter((x) => x !== id)
        : [...s.selectedNodeIds, id],
    })),
  clearSelection: () => set({ selectedNodeIds: [] }),
}));
