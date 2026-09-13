<script setup lang="ts">
import type { KbTreeNode } from '@kh/shared';

/**
 * 知识库目录树的递归节点。
 * 只负责「文件夹 / 文件」两态的渲染与展开，数据由父级组装好的 KbTreeNode 传入。
 */
const props = defineProps<{
  node: KbTreeNode;
  depth: number;
  selectedId?: string | null;
}>();

const emit = defineEmits<{
  (e: 'select', node: KbTreeNode): void;
  (e: 'menu', node: KbTreeNode, event: MouseEvent): void;
  (e: 'new-sub', node: KbTreeNode): void;
  (e: 'remove-folder', node: KbTreeNode): void;
  /** 直接上传到这一层，不用先切进目录再传 */
  (e: 'upload', node: KbTreeNode, kind: 'files' | 'folder'): void;
}>();

// 目录层级通常不深，默认展开让用户一眼看到全部内容
const open = ref(true);

const isFolder = computed(() => props.node.kind === 'folder');
const isSelected = computed(() => !isFolder.value && props.selectedId === props.node.id);

function activate() {
  if (isFolder.value) open.value = !open.value;
  else emit('select', props.node);
}
</script>

<template>
  <div class="knode-wrap">
    <div
      class="knode"
      :class="{ on: isSelected, folder: isFolder }"
      :style="{ paddingLeft: `${10 + depth * 10}px` }"
      :title="node.name"
      @click="activate"
    >
      <span v-if="isFolder" class="caret" :class="{ closed: !open }">▾</span>
      <span v-else class="caret ph" />

      <svg
        v-if="isFolder"
        class="ico"
        width="13"
        height="13"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
      >
        <path d="M2 4.5A1.5 1.5 0 013.5 3h2.2l1.3 1.6H13a1.5 1.5 0 011.5 1.5v5.4A1.5 1.5 0 0113 13H3.5A1.5 1.5 0 012 11.5z" />
      </svg>
      <span v-else class="kdoc" :class="`d-${(node.file?.extension ?? '').toLowerCase()}`">
        {{ (node.file?.extension ?? '').toUpperCase().slice(0, 4) }}
      </span>

      <span class="nm">{{ node.name }}</span>
      <template v-if="isFolder">
        <button
          class="more"
          type="button"
          :title="`上传文件到「${node.name}」`"
          @click.stop="emit('upload', node, 'files')"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8 10.6V3.2M5.6 5.6L8 3.2l2.4 2.4M3.5 12.6h9" />
          </svg>
        </button>
        <button
          class="more"
          type="button"
          :title="`上传整个文件夹到「${node.name}」`"
          @click.stop="emit('upload', node, 'folder')"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M2 5.4A1.5 1.5 0 013.5 3.9h1.9l1.2 1.5h4.9a1.5 1.5 0 011.5 1.5v4.4a1.5 1.5 0 01-1.5 1.5h-8A1.5 1.5 0 012 11.3z" />
            <path d="M8 10.8V7.4M6.5 8.9L8 7.4l1.5 1.5" />
          </svg>
        </button>
        <button class="more" type="button" title="新建子文件夹" @click.stop="emit('new-sub', node)">＋</button>
        <button class="more" type="button" title="删除文件夹" @click.stop="emit('remove-folder', node)">×</button>
      </template>
      <button v-else class="more" type="button" title="更多操作" @click.stop="emit('menu', node, $event)">···</button>
    </div>

    <template v-if="isFolder && open">
      <KbTreeNode
        v-for="child in node.children"
        :key="child.id"
        :node="child"
        :depth="depth + 1"
        :selected-id="selectedId"
        @select="emit('select', $event)"
        @menu="(n, e) => emit('menu', n, e)"
        @new-sub="emit('new-sub', $event)"
        @remove-folder="emit('remove-folder', $event)"
        @upload="(n, k) => emit('upload', n, k)"
      />
    </template>
  </div>
</template>

<style scoped>
.knode {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding-right: 8px;
  border-radius: 7px;
  cursor: pointer;
  font-size: 13px;
  color: var(--ink-2);
}
.knode:hover {
  background: var(--g100);
}
.knode.on {
  background: var(--brand-t);
  color: var(--brand);
  font-weight: 600;
}

.caret {
  width: 10px;
  flex-shrink: 0;
  font-size: 9px;
  color: var(--ink-3);
  transition: transform 0.12s;
}
.caret.closed {
  transform: rotate(-90deg);
}
.caret.ph {
  display: inline-block;
}

.ico {
  flex-shrink: 0;
  color: var(--ink-3);
}
.knode.folder .ico {
  color: #d9a441;
}

.kdoc {
  flex-shrink: 0;
  width: 26px;
  height: 16px;
  line-height: 16px;
  text-align: center;
  border-radius: 3px;
  font-size: 9px;
  font-weight: 700;
  background: var(--g100);
  color: var(--ink-3);
}
.kdoc.d-md,
.kdoc.d-txt {
  background: #e8f1fd;
  color: #2f6fd0;
}
.kdoc.d-pdf {
  background: #fdeaea;
  color: #c0392b;
}
.kdoc.d-docx,
.kdoc.d-doc {
  background: #e9f0fd;
  color: #2b579a;
}
.kdoc.d-xlsx,
.kdoc.d-csv {
  background: #e9f7ee;
  color: #217346;
}

.nm {
  flex: 1;
  min-width: 0;
  /* 允许换行：深嵌套时名字也能完整显示，避免被截成 … */
  overflow-wrap: anywhere;
  word-break: break-word;
  line-height: 1.4;
}
.more {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--ink-3);
  cursor: pointer;
  opacity: 0;
  font-size: 12px;
  line-height: 1;
}
.knode:hover .more {
  opacity: 1;
}
.more:hover {
  background: var(--g200, var(--g100));
  color: var(--ink-1);
}
</style>
