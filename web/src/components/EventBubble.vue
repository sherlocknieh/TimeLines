<script setup lang="ts">
import { computed } from "vue";

import type { Side } from "../data/events";
import type { TimelineItem } from "../types";

const props = defineProps<{
  item: TimelineItem;
  open: boolean;
  hot: boolean;
  /** 气泡相对 .ev 的顶部偏移 */
  top: number;
  peer: { side: Side; year: number; title: string } | null;
}>();

const emit = defineEmits<{
  toggle: [];
  close: [];
  peer: [];
  hover: [active: boolean];
}>();

const peerLabel = computed(() => (props.peer?.side === "uk" ? "英国" : "美国"));
</script>

<template>
  <div
    class="ev"
    :class="[`ev--${item.side}`, { open, hot }]"
    :style="{ top: `${item.anchor}px` }"
  >
    <span class="dot"></span>
    <div
      class="bub"
      :class="{ open }"
      :style="{ top: `${top}px` }"
      role="button"
      tabindex="0"
      :aria-expanded="open"
      @click.stop="emit('toggle')"
      @keydown.enter.self.prevent="emit('toggle')"
      @keydown.space.self.prevent="emit('toggle')"
      @mouseenter="emit('hover', true)"
      @mouseleave="emit('hover', false)"
      @focus="emit('hover', true)"
      @blur="emit('hover', false)"
    >
      <span class="bub__head">
        <span class="bub__y">{{ item.year }}</span>
        <span class="bub__tag">{{ item.tag }}</span>
      </span>
      <span class="bub__t">{{ item.title }}</span>
      <span class="bub__more"><span class="bub__d">{{ item.desc }}</span></span>
      <button
        v-if="peer"
        class="bub__peer"
        type="button"
        @click.stop="emit('peer')"
      >
        对岸 · {{ peerLabel }} <b>{{ peer.year }} {{ peer.title }}</b> →
      </button>
      <button
        class="bub__x"
        type="button"
        aria-label="收起"
        @click.stop="emit('close')"
      >
        ×
      </button>
    </div>
  </div>
</template>
