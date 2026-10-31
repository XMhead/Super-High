<script setup lang="ts">
import { fileIconComponents, fileIconTone } from '@/lib/fileIcons'
import type { EditorTab } from '@/types'

withDefaults(defineProps<{ tab: EditorTab; closable?: boolean; listed?: boolean }>(), { closable: true, listed: false })
defineEmits<{ select: []; close: [] }>()
</script>

<template>
  <div class="editor-tab">
    <button class="editor-tab-main" type="button" :role="listed ? 'menuitem' : undefined" :title="tab.path" @click="$emit('select')">
      <span class="tree-kind-icon" :class="fileIconTone(tab.path)" aria-hidden="true">
        <component :is="fileIconComponents[fileIconTone(tab.path)]" :size="15" :stroke-width="1.9" />
      </span>
      <span class="tab-name">{{ tab.name }}</span>
      <span v-if="tab.isDirty" class="dirty-dot" />
    </button>
    <button v-if="closable" class="tab-close" type="button" title="关闭" @click.stop="$emit('close')">×</button>
  </div>
</template>
