<script setup lang="ts">
import type { Folder } from '@kh/shared';

/**
 * 目录树的一个节点，递归渲染自己的 children —— 实现「无限层级」文件夹。
 * Nuxt 会自动注册本组件，递归时用组件名 FolderTreeItem 自引用即可。
 */
interface FolderNode extends Folder {
  children: FolderNode[];
}

const props = defineProps<{
  node: FolderNode;
  depth: number;
  current: string;
  expanded: Set<string>;
}>();

const emit = defineEmits<{
  (e: 'enter', id: string): void;
  (e: 'toggle', id: string): void;
  (e: 'new-sub', parentId: string): void;
  (e: 'remove', payload: { id: string; name: string }): void;
  (e: 'ingest', payload: { id: string; name: string }): void;
  /** 直接把文件/文件夹传到这一层，不用先切进去 */
  (e: 'upload', payload: { id: string; name: string }, kind: 'files' | 'folder'): void;
}>();

const open = computed(() => props.expanded.has(props.node.id));
const isCurrent = computed(() => props.current === props.node.id);
const indent = computed(() => `${props.depth * 14}px`);
</script>

<template>
  <div>
    <div
      class="tree-node"
      :class="{ on: isCurrent }"
      :style="{ paddingLeft: indent }"
      @click="emit('enter', node.id)"
    >
      <button
        class="tree-caret"
        :class="{ open }"
        type="button"
        @click.stop="emit('toggle', node.id)"
      >
        <template v-if="node.children.length > 0">▸</template>
      </button>
      <span class="tree-ico">📁</span>
      <span class="tree-name" :title="node.name">{{ node.name }}</span>

      <button
        class="tree-btn"
        type="button"
        :title="`上传文件到「${node.name}」`"
        @click.stop="emit('upload', { id: node.id, name: node.name }, 'files')"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M8 10.6V3.2M5.6 5.6L8 3.2l2.4 2.4M3.5 12.6h9" />
        </svg>
      </button>
      <button
        class="tree-btn"
        type="button"
        :title="`上传整个文件夹到「${node.name}」`"
        @click.stop="emit('upload', { id: node.id, name: node.name }, 'folder')"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2 5.4A1.5 1.5 0 013.5 3.9h1.9l1.2 1.5h4.9a1.5 1.5 0 011.5 1.5v4.4a1.5 1.5 0 01-1.5 1.5h-8A1.5 1.5 0 012 11.3z" />
          <path d="M8 10.8V7.4M6.5 8.9L8 7.4l1.5 1.5" />
        </svg>
      </button>
      <button
        class="tree-btn"
        title="把整个文件夹纳入知识库（保留目录层级）"
        type="button"
        @click.stop="emit('ingest', { id: node.id, name: node.name })"
      >
        ⇪
      </button>
      <button
        class="tree-btn"
        title="在此文件夹下新建子文件夹"
        type="button"
        @click.stop="emit('new-sub', node.id)"
      >
        ＋
      </button>
      <button
        class="tree-btn danger"
        title="删除文件夹"
        type="button"
        @click.stop="emit('remove', { id: node.id, name: node.name })"
      >
        ×
      </button>
    </div>
    <template v-if="open">
      <FolderTreeItem
        v-for="child in node.children"
        :key="child.id"
        :node="child"
        :depth="depth + 1"
        :current="current"
        :expanded="expanded"
        @enter="emit('enter', $event)"
        @toggle="emit('toggle', $event)"
        @new-sub="emit('new-sub', $event)"
        @remove="emit('remove', $event)"
        @ingest="emit('ingest', $event)"
        @upload="(p, k) => emit('upload', p, k)"
      />
    </template>
  </div>
</template>

<style scoped>
.tree-node {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding-right: 6px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--ink-2);
  font-size: 13px;
  transition: background var(--t), color var(--t);
  user-select: none;
}
.tree-node:hover {
  background: var(--g100);
  color: var(--ink);
}
.tree-node.on {
  background: var(--brand-s);
  color: var(--brand);
  font-weight: 500;
}
.tree-caret {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: none;
  padding: 0;
  font-size: 10px;
  color: var(--ink-3);
  cursor: pointer;
  transition: transform var(--t);
  line-height: 1;
}
.tree-caret.open {
  transform: rotate(90deg);
}
.tree-ico {
  flex-shrink: 0;
  font-size: 13px;
}
.tree-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 行内小按钮：默认隐藏，鼠标移到整行才出现 */
.tree-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: none;
  background: none;
  border-radius: 4px;
  color: var(--ink-3);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: 0;
  opacity: 0;
  transition: opacity var(--t), background var(--t), color var(--t);
}
.tree-node:hover .tree-btn {
  opacity: 1;
}
.tree-btn:hover {
  background: var(--g100);
  color: var(--brand);
}
.tree-btn.danger:hover {
  background: var(--er-s);
  color: var(--er-t);
}
</style>
