<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from "vue";

import { EVENTS } from "../data/events";
import { LANES, YEAR_MAX, YEAR_MIN, clamp, laneLabel, laneOf, ticksBetween } from "../lib/dataset";

/** 画布左右留白，避免首尾事件贴边 */
const PAD = 56;
const MIN_PX = 0.45;
const MAX_PX = 56;
const JUMPS = [1215, 1588, 1776, 1861, 1914, 1945, 2001];

const viewport = ref<HTMLElement | null>(null);
const pxPerYear = ref(4);
const selected = ref<number | null>(null);
const dragging = ref(false);

let drag: { x: number; y: number; left: number; top: number } | null = null;
let moved = false;

/** 缩放得很小时只画点，避免标签堆积分层 */
const compact = computed(() => pxPerYear.value < 2);

const width = computed(() =>
  Math.round((YEAR_MAX - YEAR_MIN) * pxPerYear.value + PAD * 2),
);

const xOf = (year: number) => PAD + (year - YEAR_MIN) * pxPerYear.value;

const ticks = computed(() => ticksBetween(pxPerYear.value));

interface Pill {
  id: number;
  year: number;
  title: string;
  left: number;
  level: number;
}

const lanes = computed(() =>
  LANES.map((lane) => {
    const pills: Pill[] = [];

    EVENTS.forEach((event, id) => {
      if (laneOf(event) !== lane.id) return;
      const left = xOf(event.y);
      if (compact.value) {
        pills.push({ id, year: event.y, title: event.t, left, level: 0 });
        return;
      }
      // 同一行内水平间隔太近就换到下一层，避免标签互相压住
      let level = 0;
      while (
        pills.some((pill) => pill.level === level && Math.abs(pill.left - left) < 118)
      ) {
        level += 1;
      }
      pills.push({ id, year: event.y, title: event.t, left, level });
    });

    const levels = pills.reduce((max, pill) => Math.max(max, pill.level), 0);
    const height = compact.value ? 78 : (levels + 1) * 30 + 40;
    return { ...lane, pills, height };
  }),
);

const detail = computed(() =>
  selected.value === null ? null : { ...EVENTS[selected.value], side: laneOf(EVENTS[selected.value]) },
);

function pick(id: number) {
  if (moved) return;
  selected.value = selected.value === id ? null : id;
}

async function zoomBy(factor: number, anchorRatio = 0.5) {
  const el = viewport.value;
  if (!el) return;

  const anchorPx = el.clientWidth * anchorRatio;
  const yearAt = YEAR_MIN + (el.scrollLeft + anchorPx - PAD) / pxPerYear.value;
  const next = clamp(pxPerYear.value * factor, MIN_PX, MAX_PX);
  pxPerYear.value = next;

  await nextTick();
  el.scrollLeft = PAD + (yearAt - YEAR_MIN) * next - anchorPx;
}

async function fit() {
  const el = viewport.value;
  if (!el) return;
  pxPerYear.value = clamp(
    (el.clientWidth - PAD * 2 - 24) / (YEAR_MAX - YEAR_MIN),
    MIN_PX,
    MAX_PX,
  );
  await nextTick();
  el.scrollLeft = 0;
}

async function scrollToYear(year: number) {
  const el = viewport.value;
  if (!el) return;
  el.scrollTo({
    left: Math.max(0, xOf(year) - el.clientWidth / 2),
    behavior: "smooth",
  });
}

async function onWheel(event: WheelEvent) {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  const el = viewport.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const ratio = (event.clientX - rect.left) / rect.width;
  await zoomBy(Math.exp(-event.deltaY * 0.0022), ratio);
}

function onPointerMove(event: PointerEvent) {
  const el = viewport.value;
  if (!drag || !el) return;
  const dx = event.clientX - drag.x;
  const dy = event.clientY - drag.y;
  if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
  el.scrollLeft = drag.left - dx;
  el.scrollTop = drag.top - dy;
}

function onPointerUp() {
  drag = null;
  dragging.value = false;
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", onPointerUp);
  window.removeEventListener("pointercancel", onPointerUp);
}

// 不在容器上做 pointer capture：否则浏览器的 click 会被重定向，
// 泳道里的胶囊按钮就点不动了。
function onPointerDown(event: PointerEvent) {
  const el = viewport.value;
  if (!el || event.button !== 0) return;
  drag = { x: event.clientX, y: event.clientY, left: el.scrollLeft, top: el.scrollTop };
  moved = false;
  dragging.value = true;
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
}

onBeforeUnmount(onPointerUp);
</script>

<template>
  <section class="view">
    <header class="view__head">
      <p class="view__kicker">Scheme 02 · Horizontal Gantt</p>
      <h1 class="view__title">横向甘特视图</h1>
      <p class="view__sub">
        年份是横轴，每条泳道一行。拖动空白处平移，Ctrl / ⌘ + 滚轮或按钮缩放，
        点击事件查看详情——适合快速扫视一段时间内的分布与同频对比。
      </p>
    </header>

    <div class="toolbar">
      <button class="btn btn--icon" type="button" aria-label="缩小" @click="zoomBy(1 / 1.4)">−</button>
      <button class="btn btn--icon" type="button" aria-label="放大" @click="zoomBy(1.4)">＋</button>
      <button class="btn" type="button" @click="fit">适应宽度</button>
      <span class="toolbar__value">
        {{ compact ? "概览模式 · " : "" }}{{ pxPerYear.toFixed(2) }} px / 年
      </span>
      <span class="toolbar__spacer"></span>
      <button
        v-for="year in JUMPS"
        :key="year"
        class="btn"
        type="button"
        @click="scrollToYear(year)"
      >
        {{ year }}
      </button>
    </div>

    <div
      ref="viewport"
      class="gantt__viewport"
      :class="{ 'is-dragging': dragging }"
      @wheel="onWheel"
      @pointerdown="onPointerDown"
    >
      <div class="gantt__canvas" :style="{ width: `${width}px` }">
        <div class="gantt__axis">
          <span
            v-for="year in ticks"
            :key="year"
            class="gantt__year"
            :style="{ left: `${xOf(year)}px` }"
          >
            {{ year }}
          </span>
        </div>

        <div
          v-for="lane in lanes"
          :key="lane.id"
          class="gantt__lane"
          :style="{ height: `${lane.height}px` }"
        >
          <span class="gantt__lane-name" :class="`is-${lane.id}`">{{ lane.label }}</span>
          <i
            v-for="year in ticks"
            :key="year"
            class="gantt__gridline"
            :style="{ left: `${xOf(year)}px` }"
          ></i>
          <button
            v-for="pill in lane.pills"
            :key="pill.id"
            class="gantt__pill"
            :class="[`is-${lane.id}`, { 'is-active': selected === pill.id, 'is-dot': compact }]"
            :style="{
              left: `${pill.left}px`,
              top: `${compact ? 44 : 30 + pill.level * 30}px`,
            }"
            type="button"
            :aria-label="`${pill.year} ${pill.title}`"
            :title="compact ? `${pill.year} ${pill.title}` : undefined"
            @click.stop="pick(pill.id)"
          >
            <template v-if="compact"></template>
            <template v-else><b>{{ pill.year }}</b><span>{{ pill.title }}</span></template>
          </button>
        </div>
      </div>
    </div>

    <div class="detail" :class="{ 'is-empty': !detail }">
      <template v-if="detail">
        <p class="detail__meta">
          <b>{{ detail.y }}</b> · {{ laneLabel(detail.side) }} · {{ detail.tag }}
        </p>
        <h2 class="detail__title">{{ detail.t }}</h2>
        <p class="detail__desc">{{ detail.d }}</p>
      </template>
      <template v-else>点一个事件查看详情；Ctrl / ⌘ + 滚轮可在指针处缩放。</template>
    </div>
  </section>
</template>
