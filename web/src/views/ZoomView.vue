<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import { EVENTS, type Side } from "../data/events";
import { clamp, laneLabel, laneOf } from "../lib/dataset";
import { avoidOverlap } from "../lib/timeline";

const DAY_MS = 86_400_000;
const YEAR_DAYS = 365.2425;
const TODAY = new Date();

type ScaleMode = "linear" | "log";
type Unit = "day" | "month" | "year";

const UNITS: Unit[] = ["day", "month", "year"];
const SIDES: Side[] = ["uk", "us"];
const UNIT_DAYS: Record<Unit, number> = {
  day: 1,
  month: YEAR_DAYS / 12,
  year: YEAR_DAYS,
};
const UNIT_LABEL: Record<Unit, string> = { day: "天", month: "月", year: "年" };
const LEVEL_NAME: Record<1 | 2 | 3, string> = {
  1: "主脉",
  2: "通史",
  3: "细节",
};

/** 轴线与事件标签之间的横向距离 */
const AXIS_GAP = 30;
/** 估算的标签高度，用于上下避让 */
const LABEL_HEIGHT = 26;
/** 画布上下留白，给最靠边的事件标签留出避让空间 */
const PLOT_PAD = 96;

/** 以 UTC 日序号表示时间，避免夏令时造成的半天偏移 */
const utcDay = (year: number, month = 1, day = 1) =>
  Date.UTC(year, month - 1, day) / DAY_MS;

const dayFromIso = (iso: string) => {
  const [year, month, day] = iso.split("-").map(Number);
  return utcDay(year, month, day);
};

const yearOf = (day: number) => new Date(day * DAY_MS).getUTCFullYear();
const monthOf = (day: number) => new Date(day * DAY_MS).getUTCMonth() + 1;
const dateOf = (day: number) => new Date(day * DAY_MS).getUTCDate();
const pad = (value: number) => String(value).padStart(2, "0");

const todayDay = utcDay(TODAY.getFullYear(), TODAY.getMonth() + 1, TODAY.getDate());

interface AxisEvent {
  id: number;
  day: number;
  year: number;
  side: Side;
  lvl: 1 | 2 | 3;
  precise: boolean;
  tag: string;
  title: string;
  desc: string;
}

const events: AxisEvent[] = EVENTS.map((event, id) => ({
  id,
  day: event.date ? dayFromIso(event.date) : utcDay(event.y, 7, 1),
  year: event.y,
  side: laneOf(event),
  lvl: event.lvl ?? 2,
  precise: Boolean(event.date),
  tag: event.tag,
  title: event.t,
  desc: event.d,
}));

const eventDays = events.map((event) => event.day);
/** 数据范围两端留白；最近一端始终包含今天，便于观察「今天」标记 */
const DATA_MIN = Math.min(...eventDays) - Math.round(YEAR_DAYS * 3);
const DATA_MAX = Math.max(Math.max(...eventDays), todayDay) + Math.round(YEAR_DAYS * 2);
/** 允许平移/缩放的硬边界，避免对数坐标算出无法表示的日期 */
const SAFE_MIN = DATA_MIN - Math.round(YEAR_DAYS * 2500);
const SAFE_MAX = todayDay + Math.round(YEAR_DAYS * 2500);

const viewport = ref<HTMLElement | null>(null);
const width = ref(1100);
const height = ref(560);
const scale = ref<ScaleMode>("linear");
const unit = ref<Unit>("year");
const center = ref(0);
const span = ref(1);
const axisX = ref(550);
const selected = ref<number | null>(null);
const hover = ref<{ y: number; day: number } | null>(null);
const dragging = ref(false);

const axisMargin = computed(() => Math.min(180, Math.max(110, width.value * 0.26)));

const unitDays = computed(() => UNIT_DAYS[unit.value]);

/** 对数模式下以「今天」为原点做有符号对数压缩；线性模式直接用日序号 */
function pOf(day: number): number {
  if (scale.value === "linear") return day;
  const delta = day - todayDay;
  return Math.sign(delta) * Math.log1p(Math.abs(delta) / unitDays.value);
}

function fromP(position: number): number {
  if (scale.value === "linear") return position;
  const sign = Math.sign(position);
  return todayDay + sign * unitDays.value * Math.expm1(Math.abs(position));
}

const plotHeight = computed(() => Math.max(1, height.value - PLOT_PAD * 2));

const yOfP = (position: number) =>
  PLOT_PAD +
  ((position - center.value + span.value / 2) / span.value) * plotHeight.value;

const pOfY = (y: number) =>
  center.value -
  span.value / 2 +
  ((y - PLOT_PAD) / plotHeight.value) * span.value;

const yOfDay = (day: number) => yOfP(pOf(day));
const dayOfY = (y: number) => fromP(pOfY(y));

const dayStart = computed(() => fromP(center.value - span.value / 2));
const dayEnd = computed(() => fromP(center.value + span.value / 2));
const visibleDays = computed(() => Math.max(1, dayEnd.value - dayStart.value));

const maxSpan = computed(() =>
  scale.value === "linear"
    ? (DATA_MAX - DATA_MIN) * 2.5
    : pOf(SAFE_MAX) - pOf(SAFE_MIN),
);
const minSpan = computed(() => (scale.value === "linear" ? 2 : 0.01));

function clampView() {
  span.value = clamp(span.value, minSpan.value, maxSpan.value);

  const low = pOf(SAFE_MIN);
  const high = pOf(SAFE_MAX);
  const half = span.value / 2;

  if (span.value >= high - low) {
    center.value = (low + high) / 2;
  } else {
    center.value = clamp(center.value, low + half, high - half);
  }
}

function clampAxis() {
  axisX.value = clamp(axisX.value, axisMargin.value, width.value - axisMargin.value);
}

function fitAll() {
  const low = pOf(DATA_MIN);
  const high = pOf(DATA_MAX);
  span.value = Math.max(minSpan.value, high - low);
  center.value = (low + high) / 2;
  axisX.value = width.value / 2;
  selected.value = null;
  clampView();
}

/** 切换坐标分布或基准单位时，尽量保持当前可见的日期区间不变 */
function preserveView(change: () => void) {
  const before = dayStart.value;
  const after = dayEnd.value;
  change();
  const low = pOf(before);
  const high = pOf(after);
  span.value = Math.max(minSpan.value, Math.abs(high - low));
  center.value = (low + high) / 2;
  clampView();
}

function setScale(next: ScaleMode) {
  if (next === scale.value) return;
  preserveView(() => {
    scale.value = next;
  });
}

function setUnit(next: Unit) {
  if (next === unit.value) return;
  preserveView(() => {
    unit.value = next;
  });
}

function zoomAt(factor: number, y: number) {
  const anchor = pOfY(y);
  const next = clamp(span.value / factor, minSpan.value, maxSpan.value);
  const ratio = (y - PLOT_PAD) / plotHeight.value;
  center.value = anchor + (0.5 - ratio) * next;
  span.value = next;
  clampView();
}

function onAxisWheel(event: WheelEvent) {
  const el = viewport.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const y = clamp(
    event.clientY - rect.top,
    PLOT_PAD,
    Math.max(PLOT_PAD, height.value - PLOT_PAD),
  );
  zoomAt(Math.exp(-event.deltaY * 0.002), y);
}

function centerOn(day: number) {
  center.value = pOf(day);
  clampView();
  selected.value = null;
}

let drag: {
  x: number;
  y: number;
  center: number;
  axisX: number;
  mode: "axis" | "time" | null;
} | null = null;
let moved = false;

function onPointerMove(event: PointerEvent) {
  if (!drag) return;

  const dx = event.clientX - drag.x;
  const dy = event.clientY - drag.y;

  if (drag.mode === null && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
    drag.mode = Math.abs(dx) > Math.abs(dy) ? "axis" : "time";
  }
  if (drag.mode === null) return;

  moved = true;
  if (drag.mode === "axis") {
    axisX.value = drag.axisX + dx;
    clampAxis();
  } else {
    center.value = drag.center - (dy / plotHeight.value) * span.value;
    clampView();
  }
}

function onPointerUp() {
  drag = null;
  dragging.value = false;
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", onPointerUp);
  window.removeEventListener("pointercancel", onPointerUp);
}

function onPointerDown(event: PointerEvent) {
  if (event.button !== 0) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest("button, a")) return;

  drag = {
    x: event.clientX,
    y: event.clientY,
    center: center.value,
    axisX: axisX.value,
    mode: null,
  };
  moved = false;
  dragging.value = true;
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
}

function pick(id: number) {
  if (moved) return;
  selected.value = selected.value === id ? null : id;
}

function onAxisMove(event: PointerEvent) {
  const el = viewport.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const y = clamp(event.clientY - rect.top, 0, rect.height || height.value);
  const plotY = clamp(y, PLOT_PAD, Math.max(PLOT_PAD, height.value - PLOT_PAD));
  hover.value = { y, day: dayOfY(plotY) };
}

function clearHover() {
  hover.value = null;
}

interface Tick {
  day: number;
  y: number;
  label: string;
}

const ticks = computed<Tick[]>(() => {
  const start = Math.min(dayStart.value, dayEnd.value);
  const end = Math.max(dayStart.value, dayEnd.value);
  const days = Math.max(1, end - start);
  const px = Math.max(1, plotHeight.value);
  const raw: { day: number; label: string }[] = [];

  if (days > YEAR_DAYS * 3) {
    const spanYears = days / YEAR_DAYS;
    // 对数轴的远近密度差异极大：先按年份生成较细的候选刻度，再按像素间距筛选
    const rawStep =
      scale.value === "log" ? Math.max(1, spanYears / 300) : (spanYears * 64) / px;
    const step =
      [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find(
        (candidate) => candidate >= rawStep,
      ) ?? 1000;

    let year = Math.ceil(yearOf(start) / step) * step;
    const lastYear = yearOf(end) + 1;
    let guard = 0;
    while (year <= lastYear && guard < 4000) {
      raw.push({ day: utcDay(year), label: String(year) });
      year += step;
      guard += 1;
    }
  } else if (days > 45) {
    const step =
      [1, 2, 3, 6, 12].find(
        (candidate) => candidate >= (((days / 30.44) * 82) / px),
      ) ?? 12;

    let year = yearOf(start);
    let month = 0;
    const lastYear = yearOf(end) + 1;
    let guard = 0;

    while (year <= lastYear && guard < 4000) {
      const day = utcDay(year, month + 1);
      if (day >= start && day <= end) {
        raw.push({
          day,
          label: step >= 12 ? String(year) : `${year}-${pad(month + 1)}`,
        });
      }
      month += step;
      year += Math.floor(month / 12);
      month %= 12;
      guard += 1;
    }
  } else {
    const step =
      [1, 2, 5, 7, 14, 28].find(
        (candidate) => candidate >= ((days * 82) / px),
      ) ?? 28;

    const first = Math.ceil(start / step) * step;
    let guard = 0;
    for (let day = first; day <= end && guard < 4000; day += step) {
      raw.push({ day, label: `${monthOf(day)}/${dateOf(day)}` });
      guard += 1;
    }
  }

  const kept: Tick[] = [];
  for (const tick of raw) {
    const y = yOfP(pOf(tick.day));
    if (y < PLOT_PAD - 12 || y > height.value - PLOT_PAD + 12) continue;
    if (kept.length > 0 && y - kept[kept.length - 1].y < 52) continue;
    kept.push({ ...tick, y });
  }
  return kept;
});

/** 缩放决定显示到哪一层事件：远景只看主脉，近景才展开细节 */
const level = computed<1 | 2 | 3>(() => {
  if (visibleDays.value > YEAR_DAYS * 220) return 1;
  if (visibleDays.value > YEAR_DAYS * 45) return 2;
  return 3;
});

const levelHint = computed(
  () =>
    ({
      1: "远景：只显示主脉事件，避免历史被标签淹没",
      2: "中景：主脉 + 通史事件",
      3: "近景：展开全部细节事件，可精确到日期",
    })[level.value],
);

interface Placed extends AxisEvent {
  anchor: number;
  labelTop: number;
  labelCenter: number;
}

const placed = computed<Record<Side, Placed[]>>(() => {
  const result: Record<Side, Placed[]> = { uk: [], us: [] };

  for (const side of SIDES) {
    const list = events
      .filter((event) => event.side === side && event.lvl <= level.value)
      .map((event) => ({ ...event, anchor: yOfDay(event.day) }))
      .filter((event) => event.anchor > -160 && event.anchor < height.value + 160)
      .sort((a, b) => a.anchor - b.anchor);

    const tops = avoidOverlap(
      list.map((event) => ({ anchor: event.anchor, height: LABEL_HEIGHT })),
    );

    result[side] = list.map((event, index) => ({
      ...event,
      labelTop: tops[index],
      labelCenter: tops[index] + LABEL_HEIGHT / 2,
    }));
  }

  return result;
});

const links = computed(() => {
  const out: { id: number; side: Side; d: string }[] = [];

  for (const side of SIDES) {
    const x1 = side === "uk" ? axisX.value - AXIS_GAP : axisX.value + AXIS_GAP;
    for (const event of placed.value[side]) {
      const mid = (event.anchor + event.labelCenter) / 2;
      out.push({
        id: event.id,
        side,
        d: `M${axisX.value},${event.anchor} C${axisX.value},${mid} ${x1},${mid} ${x1},${event.labelCenter}`,
      });
    }
  }

  return out;
});

const detail = computed(() =>
  selected.value === null ? null : events[selected.value],
);

function stamp(event: AxisEvent): string {
  if (!event.precise || level.value < 3) return String(event.year);
  return `${event.year}-${pad(monthOf(event.day))}-${pad(dateOf(event.day))}`;
}

function labelStyle(event: Placed) {
  return event.side === "uk"
    ? {
        right: `${Math.max(0, width.value - axisX.value + AXIS_GAP)}px`,
        top: `${event.labelTop}px`,
      }
    : {
        left: `${Math.max(0, axisX.value + AXIS_GAP)}px`,
        top: `${event.labelTop}px`,
      };
}

const todayY = computed(() => yOfDay(todayDay));
const todayVisible = computed(
  () => todayY.value > -24 && todayY.value < height.value + 24,
);

const hoverText = computed(() => {
  if (!hover.value) return null;
  const day = hover.value.day;
  return {
    y: hover.value.y,
    year: yearOf(day),
    full: `${yearOf(day)}-${pad(monthOf(day))}-${pad(dateOf(day))}`,
  };
});

const readoutRight = computed(() => axisX.value <= width.value / 2);

const hoverReadoutStyle = computed(() => {
  if (!hoverText.value) return {};
  return readoutRight.value
    ? {
        top: `${hoverText.value.y}px`,
        left: `${axisX.value + AXIS_GAP}px`,
      }
    : {
        top: `${hoverText.value.y}px`,
        right: `${Math.max(0, width.value - axisX.value + AXIS_GAP)}px`,
      };
});

const pxPerYear = computed(() =>
  visibleDays.value > 0 ? plotHeight.value / (visibleDays.value / YEAR_DAYS) : 0,
);

const scaleLabel = computed(() => (scale.value === "log" ? "对数" : "线性"));

let observer: ResizeObserver | undefined;

function syncSize() {
  const el = viewport.value;
  if (!el) return;
  const wasCentered = Math.abs(axisX.value - width.value / 2) < 2;
  width.value = Math.max(320, el.clientWidth);
  height.value = Math.max(320, el.clientHeight);
  if (wasCentered) axisX.value = width.value / 2;
  clampAxis();
}

onMounted(() => {
  syncSize();
  fitAll();
  observer = new ResizeObserver(syncSize);
  if (viewport.value) observer.observe(viewport.value);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  onPointerUp();
});
</script>

<template>
  <section class="view">
    <header class="view__head">
      <p class="view__kicker">Scheme 03 · Zoomable Axis</p>
      <h1 class="view__title">缩放时间轴</h1>
      <p class="view__sub">
        一条<b>竖直时间轴</b>：默认水平居中并适配全部数据，可以左右拖动轴线改变位置。
        鼠标在轴线上滚轮缩放、在轴线之外滚轮则正常滚动页面；上下拖动空白处平移时间。
        缩放同时改变事件层级——远景只看主脉，放大后才逐步展开通史与细节。
      </p>
    </header>

    <div class="toolbar">
      <button class="btn btn--icon" type="button" aria-label="缩小" @click="zoomAt(1 / 1.6, height / 2)">−</button>
      <button class="btn btn--icon" type="button" aria-label="放大" @click="zoomAt(1.6, height / 2)">＋</button>
      <button class="btn" type="button" @click="fitAll">全览</button>
      <button class="btn" type="button" @click="centerOn(todayDay)">今天</button>
      <span class="toolbar__value">
        {{ scaleLabel }}<template v-if="scale === 'log'"> · 基准 {{ UNIT_LABEL[unit] }}</template>
        · {{ pxPerYear >= 1 ? pxPerYear.toFixed(1) : pxPerYear.toFixed(3) }} px / 年
      </span>
      <span class="toolbar__spacer"></span>
      <span class="axis-level" :title="levelHint">L{{ level }} · {{ LEVEL_NAME[level] }}</span>
      <div class="seg" role="group" aria-label="刻度分布">
        <button
          type="button"
          :class="{ 'is-on': scale === 'linear' }"
          @click="setScale('linear')"
        >
          线性
        </button>
        <button
          type="button"
          :class="{ 'is-on': scale === 'log' }"
          @click="setScale('log')"
        >
          对数
        </button>
      </div>
      <div
        v-if="scale === 'log'"
        class="seg"
        role="group"
        aria-label="今天附近的基准单位"
        title="对数轴以今天为原点，基准单位决定今天附近被拉开的程度"
      >
        <button
          v-for="item in UNITS"
          :key="item"
          type="button"
          :class="{ 'is-on': unit === item }"
          @click="setUnit(item)"
        >
          {{ UNIT_LABEL[item] }}
        </button>
      </div>
    </div>

    <div
      ref="viewport"
      class="axis"
      :class="{ 'is-dragging': dragging }"
      @pointerdown="onPointerDown"
    >
      <i
        v-for="tick in ticks"
        :key="tick.day"
        class="axis__tick"
        :style="{ top: `${tick.y}px` }"
      >
        <span>{{ tick.label }}</span>
      </i>

      <div class="axis__spine" :style="{ left: `${axisX}px` }"></div>

      <svg
        class="axis__links"
        :width="width"
        :height="height"
        aria-hidden="true"
      >
        <path
          v-for="link in links"
          :key="link.id"
          :class="link.side"
          :d="link.d"
        ></path>
      </svg>

      <div
        v-if="todayVisible"
        class="axis__today"
        :style="{ top: `${todayY}px` }"
      >
        <span>今天</span>
      </div>

      <template v-for="side in SIDES" :key="side">
        <template v-for="event in placed[side]" :key="event.id">
          <span
            class="axis-event__dot"
            :class="[`is-${side}`, { 'is-l1': event.lvl === 1 }]"
            :style="{ left: `${axisX}px`, top: `${event.anchor}px` }"
          ></span>
          <button
            class="axis-event__label"
            :class="[
              `is-${side}`,
              { 'is-active': selected === event.id, 'is-l1': event.lvl === 1 },
            ]"
            :style="labelStyle(event)"
            type="button"
            :title="`${event.year} ${event.title}`"
            @click.stop="pick(event.id)"
          >
            <b>{{ stamp(event) }}</b><span>{{ event.title }}</span>
          </button>
        </template>
      </template>

      <i
        v-if="hover"
        class="axis__cursor"
        :style="{ top: `${hover.y}px` }"
      ></i>

      <div
        v-if="hoverText"
        class="axis__readout"
        :class="readoutRight ? 'is-right' : 'is-left'"
        :style="hoverReadoutStyle"
      >
        <b>{{ hoverText.year }}</b>
        <span>{{ hoverText.full }}</span>
      </div>

      <div
        class="axis__band"
        :style="{ left: `${axisX - 32}px` }"
        @wheel.prevent="onAxisWheel"
        @pointermove="onAxisMove"
        @pointerleave="clearHover"
      ></div>
    </div>

    <p class="axis__hint">
      <span class="hint__key">轴上滚轮</span> 缩放 ·
      <span class="hint__key">轴外滚轮</span> 滚动页面 ·
      <span class="hint__key">左右拖动</span> 移动轴线 ·
      <span class="hint__key">上下拖动</span> 平移时间 ·
      <span class="hint__key">悬停轴线</span> 放大查看年份 / 日期
    </p>

    <div class="detail" :class="{ 'is-empty': !detail }">
      <template v-if="detail">
        <p class="detail__meta">
          <b>{{ detail.precise ? `${detail.year}-${pad(monthOf(detail.day))}-${pad(dateOf(detail.day))}` : detail.year }}</b>
          · {{ laneLabel(detail.side) }} · {{ detail.tag }} · L{{ detail.lvl }}
        </p>
        <h2 class="detail__title">{{ detail.title }}</h2>
        <p class="detail__desc">{{ detail.desc }}</p>
      </template>
      <template v-else>
        {{ levelHint }}。点一个事件查看详情，或切换线性 / 对数观察不同的时间分布。
      </template>
    </div>
  </section>
</template>
