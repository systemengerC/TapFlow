/**
 * PropertiesPanel 渲染测试。
 *
 * 覆盖 gpt 门禁指出的缺口：单选删除入口、多选批量删除入口、无选中不渲染。
 *
 * 断言对象是纯展示层 `PropertiesPanelView`（props 驱动）而非默认导出的 store 连接层：
 * zustand v5 的 useStore 在服务端渲染时走 getServerSnapshot → getInitialState()，
 * renderToStaticMarkup 永远只能看到初始空状态，对 store 连接层做渲染断言必然失败。
 * 连接层到 store 的实际删除行为由 lib/canvas/deleteNodes.test.ts 覆盖。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { PropertiesPanelView, type PanelNode } from './PropertiesPanel.tsx';
import type { ClientOperation, Uuid } from '@tapflow/contracts';

const NODE_A = '11111111-1111-4111-8111-111111111111' as Uuid;
const NODE_B = '22222222-2222-4222-8222-222222222222' as Uuid;

const NODE: PanelNode = {
  nodeType: 'image',
  position: { x: 120, y: 240 },
  size: { x: 300, y: 200 },
  locked: false,
};

/** 收集回调调用，便于断言交互契约 */
function harness() {
  const applied: ClientOperation[] = [];
  const deleted: Uuid[][] = [];
  return {
    applied,
    deleted,
    onApply: (op: ClientOperation) => applied.push(op),
    onDelete: (ids: Uuid[]) => deleted.push(ids),
  };
}

describe('PropertiesPanel 删除入口', () => {
  test('无选中节点时不渲染面板', () => {
    const h = harness();
    const html = renderToStaticMarkup(
      <PropertiesPanelView selectedNodeIds={[]} node={undefined} onApply={h.onApply} onDelete={h.onDelete} />
    );
    assert.equal(html, '', '未选中时面板应完全不渲染');
  });

  test('选中节点在 store 中不存在时不渲染（防脏选中崩溃）', () => {
    const h = harness();
    const html = renderToStaticMarkup(
      <PropertiesPanelView selectedNodeIds={[NODE_A]} node={undefined} onApply={h.onApply} onDelete={h.onDelete} />
    );
    assert.equal(html, '', '脏选中不应导致渲染或抛错');
  });

  test('单选渲染删除节点按钮和位置属性', () => {
    const h = harness();
    const html = renderToStaticMarkup(
      <PropertiesPanelView selectedNodeIds={[NODE_A]} node={NODE} onApply={h.onApply} onDelete={h.onDelete} />
    );

    assert.ok(html.includes('删除节点'), '单选必须有删除入口');
    assert.ok(html.includes('>X<'), '单选应展示 X 位置行');
    assert.ok(html.includes('>Y<'), '单选应展示 Y 位置行');
    assert.ok(html.includes('value="120"'), '位置 X 应回填节点实际值');
    assert.ok(html.includes('value="300"'), '尺寸宽应回填节点实际值');
    assert.ok(html.includes('image'), '标题应显示节点类型');
    assert.ok(!html.includes('个节点'), '单选不应出现多选计数文案');
  });

  test('多选渲染批量删除按钮并显示数量', () => {
    const h = harness();
    const html = renderToStaticMarkup(
      <PropertiesPanelView
        selectedNodeIds={[NODE_A, NODE_B]}
        node={NODE}
        onApply={h.onApply}
        onDelete={h.onDelete}
      />
    );

    assert.ok(html.includes('删除 2 个节点'), '多选删除按钮应显示选中数量');
    assert.ok(html.includes('2 个节点'), '标题应显示多选数量');
    assert.ok(!html.includes('>X<'), '多选不应渲染单节点位置编辑');
  });

  test('锁定状态反映在按钮文案上', () => {
    const h = harness();
    const unlocked = renderToStaticMarkup(
      <PropertiesPanelView selectedNodeIds={[NODE_A]} node={NODE} onApply={h.onApply} onDelete={h.onDelete} />
    );
    assert.ok(unlocked.includes('未锁'), '未锁定节点应显示未锁');

    const locked = renderToStaticMarkup(
      <PropertiesPanelView
        selectedNodeIds={[NODE_A]}
        node={{ ...NODE, locked: true }}
        onApply={h.onApply}
        onDelete={h.onDelete}
      />
    );
    assert.ok(locked.includes('已锁'), '锁定节点应显示已锁');
  });
});

describe('PropertiesPanel 交互契约', () => {
  test('删除按钮把全部选中 id 交给 onDelete', () => {
    const h = harness();
    // 通过 React 元素树取出 onClick，验证传参而非只验证渲染
    const view = PropertiesPanelView({
      selectedNodeIds: [NODE_A, NODE_B],
      node: NODE,
      onApply: h.onApply,
      onDelete: h.onDelete,
    });
    const btn = findByText(view, '删除');
    assert.ok(btn, '多选应存在删除按钮');
    btn.props.onClick();

    assert.deepEqual(h.deleted, [[NODE_A, NODE_B]], 'onDelete 必须收到全部选中 id');
  });

  test('锁定切换产生 set_nodes_locked 操作并取反当前状态', () => {
    const h = harness();
    const view = PropertiesPanelView({
      selectedNodeIds: [NODE_A],
      node: NODE, // locked: false
      onApply: h.onApply,
      onDelete: h.onDelete,
    });
    const btn = findByText(view, '未锁');
    assert.ok(btn, '单选应存在锁定切换按钮');
    btn.props.onClick();

    assert.equal(h.applied.length, 1, '应产生一个操作');
    const op = h.applied[0];
    assert.equal(op.type, 'set_nodes_locked');
    assert.deepEqual(op.payload, { nodeIds: [NODE_A], locked: true }, 'locked 必须取反');
  });
});

/** 在 React 元素树里找出文案包含 text 的按钮元素 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findByText(node: any, text: string): any {
  if (node === null || node === undefined || typeof node !== 'object') return null;

  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByText(child, text);
      if (hit) return hit;
    }
    return null;
  }

  const children = node.props?.children;
  if (node.type === 'button' && flatten(children).includes(text)) return node;
  return findByText(children, text);
}

/** 把 children 递归拼成纯文本，用于文案匹配 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function flatten(children: any): string {
  if (children === null || children === undefined || typeof children === 'boolean') return '';
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(flatten).join('');
  return flatten(children.props?.children);
}
