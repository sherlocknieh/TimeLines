<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";

import EventBubble from "./EventBubble.vue";
import { EVENTS, type Side } from "../data/events";
import {
  BOTTOM_PAD,
  GRID_YEARS,
  TICKS,
  TOP_PAD,
  axisHeight,
  avoidOverlap,
  baseStageHeight,
  yOf,
} from "../lib/timeline";
import type { TimelineItem } from "../types";

const items = reactive<TimelineItem[]>(
  EVENTS.map((event, id) => ({
    id,
    side: event.s ?? "us",
    year: event.y,
    tag: event.tag,
    title: event.t,
    desc: event.d,
    anchor: yOf(event.y),
    height: 0,
    top: 0,
    dy: 0,
    openTop: 0,
    peerId: null,
  })),
);

for (const item of items) {
  let bestId: number | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const other of items) {
    if (other.side === item.side) continue;
    const delta = Math.abs(other.year - item.year);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestId = other.id;
    }
  }
  if (bestId !== null && bestDelta <= 50) item.peerId = bestId;
}

const stageRef = ref<HTMLElement | null>(null);
const eventsRef = ref<HTMLElement | null>(null);
const stageHeight = ref(baseStageHeight);
const currentId = ref<number | null>(null);
const hotId = ref<number | null>(null);
const ready = ref(false);
const links = ref<{ id: number; side: Side; d: string }[]>([]);

const spineStyle = computed(() => ({
  top: `${TOP_PAD}px`,
  height: `${axisHeight}px`,
}));

function bubbleOf(item: TimelineItem): HTMLElement | null {
  const event = eventsRef.value?.children[item.id] as HTMLElement | undefined;
  return event?.querySelector<HTMLElement>(".bub") ?? null;
}

function bubbleTop(item: TimelineItem): number {
  return currentId.value === item.id ? item.openTop - item.anchor : item.dy;
}

function peerOf(item: TimelineItem) {
  if (item.peerId === null) return null;
  const peer = items[item.peerId];
  return { side: peer.side, year: peer.year, title: peer.title };
}

function drawLinks() {
  const stage = stageRef.value;
  if (!stage) return;
  const axisX = stage.clientWidth / 2;
  const next: { id: number; side: Side; d: string }[] = [];

  for (const item of items) {
    const bubble = bubbleOf(item);
    if (!bubble) continue;

    const x0 = axisX;
    const y0 = item.anchor;
    const y1 = item.anchor + bubble.offsetTop + bubble.offsetHeight / 2;
    const x1 =
      item.side === "uk"
        ? Math.min(bubble.offsetLeft + bubble.offsetWidth, axisX - 2)
        : Math.max(bubble.offsetLeft, axisX + 2);
    const dx = x1 - x0;

    next.push({
      id: item.id,
      side: item.side,
      d: `M${x0},${y0} C${x0 + dx * 0.6},${y0} ${x0 + dx * 0.4},${y1} ${x1},${y1}`,
    });
  }

  links.value = next;
}

async function layout() {
  for (const item of items) {
    if (currentId.value === item.id) continue;
    const bubble = bubbleOf(item);
    if (bubble) item.height = bubble.offsetHeight;
  }

  for (const side of ["uk", "us"] as Side[]) {
    const list = items.filter((item) => item.side === side);
    const tops = avoidOverlap(list);
    list.forEach((item, index) => {
      item.top = tops[index];
      item.dy = item.top - item.anchor;
    });
  }

  let maxBottom = 0;
  for (const item of items) {
    maxBottom = Math.max(maxBottom, item.top + item.height);
  }
  stageHeight.value = Math.max(baseStageHeight, maxBottom + BOTTOM_PAD);

  await nextTick();
  drawLinks();
  ready.value = true;
}

async function closeSilently() {
  if (currentId.value === null) return;
  currentId.value = null;
  await nextTick();
  drawLinks();
}

async function close() {
  await closeSilently();
}

function softScroll(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const viewportHeight = window.innerHeight;
  if (rect.top < 80) {
    window.scrollBy({ top: rect.top - 120, behavior: "smooth" });
  } else if (rect.bottom > viewportHeight - 80) {
    window.scrollBy({ top: rect.bottom - viewportHeight + 120, behavior: "smooth" });
  }
}

async function open(item: TimelineItem) {
  if (currentId.value === item.id) return;
  await closeSilently();

  const center = item.anchor + item.dy + item.height / 2;
  item.openTop = item.anchor + item.dy;
  currentId.value = item.id;

  await nextTick();
  const bubble = bubbleOf(item);
  if (!bubble) return;

  const height = bubble.offsetHeight;
  let top = center - height / 2;
  if (top < 8) top = 8;
  if (top + height > stageHeight.value - 8) {
    top = stageHeight.value - 8 - height;
  }
  item.openTop = top;

  await nextTick();
  drawLinks();
  softScroll(bubble);
}

function toggle(item: TimelineItem) {
  if (currentId.value === item.id) {
    void close();
  } else {
    void open(item);
  }
}

function openPeer(item: TimelineItem) {
  const peer = item.peerId === null ? null : items[item.peerId];
  if (peer) void open(peer);
}

function setHot(item: TimelineItem, active: boolean) {
  hotId.value = active ? item.id : null;
}

function onDocumentClick(event: MouseEvent) {
  if (currentId.value === null) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest(".ev")) return;
  void close();
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") void close();
}

let resizeTimer: number | undefined;
function onResize() {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    void (async () => {
      const openItem =
        currentId.value === null ? null : items[currentId.value];
      if (openItem) {
        currentId.value = null;
        await nextTick();
        await layout();
        await open(openItem);
      } else {
        await layout();
      }
    })();
  }, 140);
}

onMounted(async () => {
  document.addEventListener("click", onDocumentClick);
  document.addEventListener("keydown", onKeydown);
  window.addEventListener("resize", onResize);

  await nextTick();
  await layout();

  if (document.fonts?.ready) {
    void document.fonts.ready.then(() => layout());
  }
});

onBeforeUnmount(() => {
  document.removeEventListener("click", onDocumentClick);
  document.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", onResize);
  window.clearTimeout(resizeTimer);
});
</script>

<template>
  <main
    id="stage"
    ref="stageRef"
    class="stage"
    :class="{ 'is-ready': ready }"
    :style="{ height: `${stageHeight}px` }"
  >
    <div class="stage__inner" :style="{ height: `${stageHeight}px` }">
      <div class="grids">
        <i v-for="tick in TICKS" :key="tick" class="tick" :style="{ top: `${tick}px` }"></i>
        <div
          v-for="year in GRID_YEARS"
          :key="year"
          class="grid"
          :style="{ top: `${yOf(year)}px` }"
        >
          <span class="grid__chip">{{ year }}</span>
        </div>
      </div>

      <div class="spine" :style="spineStyle"></div>

      <svg class="links" aria-hidden="true">
        <path v-for="link in links" :key="link.id" :class="link.side" :d="link.d"></path>
      </svg>

      <div ref="eventsRef" class="events">
        <EventBubble
          v-for="item in items"
          :key="item.id"
          :item="item"
          :open="currentId === item.id"
          :hot="hotId === item.id"
          :top="bubbleTop(item)"
          :peer="peerOf(item)"
          @toggle="toggle(item)"
          @close="close()"
          @peer="openPeer(item)"
          @hover="setHot(item, $event)"
        />
      </div>
    </div>
  </main>
</template>
