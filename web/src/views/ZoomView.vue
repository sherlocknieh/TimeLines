<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { EVENTS, type Side } from "../data/events";
import { clamp, laneLabel, laneOf } from "../lib/dataset";
import { pickVisible } from "../lib/timeline";

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

/** 轴线与事件标签之间的横向距离 */
const AXIS_GAP = 30;
/** 区间线段与轴线的横向偏移，落在标签连线内侧 */
const RANGE_OFFSET = 8;
/** 标签高度（像素）：L1 字号更大，用于遮挡判断与垂直居中 */
const LABEL_HEIGHT: Record<1 | 2 | 3, number> = { 1: 28, 2: 25, 3: 25 };
/** 画布上下留白，给最靠边的事件标签留出显示空间 */
const PLOT_PAD = 96;
/** 刻度文字气泡高度约 20px，留一点间隙即可：只要不重叠就随虚线显示 */
const MIN_TICK_LABEL_GAP = 22;
/** 事件卡片的尺寸约束，展开后仍要留在画布内 */
const CARD_MAX_WIDTH = 320;
const CARD_MIN_WIDTH = 160;
const CARD_PAD = 12;

/** 以 UTC 日序号表示时间，避免夏令时造成的半天偏移 */
const utcDay = (year: number, month = 1, day = 1) => {
  // Date.UTC 会把 0–99 年当作 1900–1999 年，用 setUTCFullYear 保留真实年份
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getTime() / DAY_MS;
};

const yearOf = (day: number) => new Date(day * DAY_MS).getUTCFullYear();
const monthOf = (day: number) => new Date(day * DAY_MS).getUTCMonth() + 1;
const dateOf = (day: number) => new Date(day * DAY_MS).getUTCDate();
const pad = (value: number) => String(value).padStart(2, "0");

type Precision = "year" | "month" | "day";

interface Stamp {
  day: number;
  year: number;
  precision: Precision;
}

/** 解析 YYYY / YYYY-MM / YYYY-MM-DD，保留书写粒度以决定展示精度 */
function parseStamp(text: string): Stamp {
  const [year, month, day] = text.split("-").map(Number);
  if (month === undefined) {
    return { day: utcDay(year, 7, 1), year, precision: "year" };
  }
  if (day === undefined) {
    return { day: utcDay(year, month, 1), year, precision: "month" };
  }
  return { day: utcDay(year, month, day), year, precision: "day" };
}

/** 按书写粒度输出日期：只写年份就不补月份与日，避免制造虚假精度 */
function stampText(stamp: Stamp): string {
  const year = yearOf(stamp.day);
  if (stamp.precision === "year") return String(year);
  const month = `${year}-${pad(monthOf(stamp.day))}`;
  return stamp.precision === "month"
    ? month
    : `${month}-${pad(dateOf(stamp.day))}`;
}

const todayDay = utcDay(TODAY.getFullYear(), TODAY.getMonth() + 1, TODAY.getDate());

interface AxisEvent {
  id: number;
  day: number;
  endDay: number | null;
  year: number;
  endYear: number | null;
  side: Side;
  lvl: 1 | 2 | 3;
  startStamp: string;
  endStamp: string | null;
  tag: string;
  title: string;
  desc: string;
}

const events: AxisEvent[] = EVENTS.map((event, id) => {
  const start: Stamp = event.date
    ? parseStamp(event.date)
    : { day: utcDay(event.y, 7, 1), year: event.y, precision: "year" };
  const end = event.end ? parseStamp(event.end) : null;

  return {
    id,
    day: start.day,
    endDay: end?.day ?? null,
    year: start.year,
    endYear: end?.year ?? null,
    side: laneOf(event),
    lvl: event.lvl ?? 2,
    startStamp: stampText(start),
    endStamp: end ? stampText(end) : null,
    tag: event.tag,
    title: event.t,
    desc: event.d,
  };
});

const eventDays = events.flatMap((event) =>
  event.endDay === null ? [event.day] : [event.day, event.endDay],
);
/** 数据范围：历史端留一点余量，未来端止于今天 */
const DATA_MIN = Math.min(...eventDays) - Math.round(YEAR_DAYS * 3);
const DATA_MAX = Math.max(...eventDays, todayDay);
/** 线性平移/缩放的安全边界，避免拖到数据之外的空白 */
const SAFE_MIN = DATA_MIN - Math.round(YEAR_DAYS * 2500);
const SAFE_MAX = DATA_MAX + Math.round(YEAR_DAYS * 2);

const viewport = ref<HTMLElement | null>(null);
const width = ref(1100);
const height = ref(560);
const scale = ref<ScaleMode>("linear");
/** 对数的基准日：始终等于中间线所在日期，中心位置固定为零点 */
const logOrigin = ref(todayDay);
const reversed = ref(false);
const unit = ref<Unit>("year");
const center = ref(0);
const span = ref(1);
const axisX = ref(550);
const selected = ref<number | null>(null);
const hover = ref<{ y: number; day: number } | null>(null);
const dragging = ref(false);
const query = ref("");
const searchOpen = ref(false);
const activeResult = ref(0);
const searchWrap = ref<HTMLElement | null>(null);
const originInput = ref<HTMLInputElement | null>(null);

const axisMargin = computed(() => Math.min(180, Math.max(110, width.value * 0.26)));

const unitDays = computed(() => UNIT_DAYS[unit.value]);

/** 屏幕方向：+1 历史在上、今天在下；-1 今天在上、历史向下 */
const dir = computed(() => (reversed.value ? -1 : 1));

/** 线性模式直接用日序号；对数以中间线为界做有符号压缩 */
function pOf(day: number): number {
  if (scale.value === "linear") return day;
  const delta = day - logOrigin.value;
  return Math.sign(delta) * Math.log1p(Math.abs(delta) / unitDays.value);
}

/** 对数坐标中 position 对应的日期偏移，用于把缩放锚点换算成新的基准日 */
const offsetOfP = (position: number) =>
  Math.sign(position) * unitDays.value * Math.expm1(Math.abs(position));

function fromP(position: number): number {
  if (scale.value === "linear") return position;
  return logOrigin.value + offsetOfP(position);
}

const plotHeight = computed(() => Math.max(1, height.value - PLOT_PAD * 2));

const yOfP = (position: number) =>
  PLOT_PAD +
  ((dir.value * (position - center.value) + span.value / 2) / span.value) *
    plotHeight.value;

const pOfY = (y: number) =>
  center.value +
  dir.value * (((y - PLOT_PAD) / plotHeight.value - 0.5) * span.value);

const yOfDay = (day: number) => yOfP(pOf(day));
const dayOfY = (y: number) => fromP(pOfY(y));

const dayStart = computed(() => fromP(center.value - span.value / 2));
const dayEnd = computed(() => fromP(center.value + span.value / 2));
const visibleDays = computed(() => Math.max(1, dayEnd.value - dayStart.value));

const minSpan = computed(() => (scale.value === "linear" ? 2 : 0.01));
const maxSpan = computed(() =>
  scale.value === "linear"
    ? (DATA_MAX - DATA_MIN) * 2.5
    : // 对数视野以中间线为轴对称展开：每侧最多展开整个数据跨度，未来不足的部分留白
      2 * Math.log1p((DATA_MAX - DATA_MIN) / unitDays.value),
);

function clampView() {
  span.value = clamp(span.value, minSpan.value, maxSpan.value);

  if (scale.value === "log") {
    logOrigin.value = clamp(logOrigin.value, DATA_MIN, DATA_MAX);
    center.value = 0;
    return;
  }

  const half = span.value / 2;
  if (span.value >= SAFE_MAX - SAFE_MIN) {
    center.value = (SAFE_MIN + SAFE_MAX) / 2;
  } else {
    center.value = clamp(center.value, SAFE_MIN + half, SAFE_MAX - half);
  }
}

function clampAxis() {
  axisX.value = clamp(axisX.value, axisMargin.value, width.value - axisMargin.value);
}

function fitAll() {
  if (scale.value === "log") {
    // 以数据中点作基准时，两侧对数跨度相等，刚好覆盖全部数据
    logOrigin.value = (DATA_MIN + DATA_MAX) / 2;
    span.value = Math.max(
      minSpan.value,
      2 * Math.log1p((DATA_MAX - DATA_MIN) / (2 * unitDays.value)),
    );
    center.value = 0;
  } else {
    const low = pOf(DATA_MIN);
    const high = pOf(DATA_MAX);
    span.value = Math.max(minSpan.value, high - low);
    center.value = (low + high) / 2;
  }
  axisX.value = width.value / 2;
  selected.value = null;
  clampView();
}

/** 切换坐标分布或对数单位时，尽量保持中间线日期与可见跨度不变 */
function preserveView(change: () => void) {
  const before = dayStart.value;
  const after = dayEnd.value;
  const middle = dayOfY(height.value / 2);
  change();
  const low = pOf(before);
  const high = pOf(after);
  span.value = Math.max(minSpan.value, Math.abs(high - low));
  if (scale.value === "log") {
    logOrigin.value = middle;
    center.value = 0;
  } else {
    center.value = (low + high) / 2;
  }
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

/** 切换对数基准：把指定日期移到中间线上 */
function setOrigin(day: number) {
  const next = clamp(Math.round(day), DATA_MIN, DATA_MAX);
  if (next === Math.round(logOrigin.value)) return;
  logOrigin.value = next;
  center.value = 0;
  clampView();
}

const isoOf = (day: number) =>
  `${yearOf(day)}-${pad(monthOf(day))}-${pad(dateOf(day))}`;

/** 中间线实时日期：对数模式就是基准日，线性模式取画布中心对应的日期 */
const middleDay = computed(() => dayOfY(height.value / 2));

/** 中间线日期始终显示在气泡与输入框里，拖动或缩放后同步更新 */
const originText = computed(() => isoOf(Math.round(middleDay.value)));

/** 解析 YYYY / YYYY-MM / YYYY-MM-DD；只写年份时取年中，与无日期的数据一致 */
function parseDay(text: string): number | null {
  const match = /^(\d{1,4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = clamp(Number(match[2] ?? 7), 1, 12);
  const lastDay = new Date(utcDay(year, month + 1, 0) * DAY_MS).getUTCDate();
  const day = clamp(Number(match[3] ?? 1), 1, lastDay);
  return utcDay(year, month, day);
}

function applyOrigin(event: Event) {
  const input = event.target as HTMLInputElement;
  const raw = input.value.trim();
  const day = raw ? parseDay(raw) : todayDay;
  if (day !== null) setOrigin(day);
  input.value = originText.value;
}

function resetOrigin() {
  setOrigin(todayDay);
  if (originInput.value) originInput.value.value = originText.value;
}

/** 以某个事件为对数基准：对数模式移到中间线，线性模式只居中，不切换分布 */
function useEventOrigin(day: number) {
  if (scale.value === "log") {
    setOrigin(day);
    return;
  }
  logOrigin.value = clamp(Math.round(day), DATA_MIN, DATA_MAX);
  center.value = pOf(day);
  clampView();
}

function zoomAt(factor: number, y: number) {
  const next = clamp(span.value / factor, minSpan.value, maxSpan.value);
  const ratio = (y - PLOT_PAD) / plotHeight.value;

  if (scale.value === "log") {
    // 基准固定在中间线：先求出缩放后锚点的对数位置，再反推能把它留在原处的基准日
    const anchorDay = dayOfY(y);
    const position = dir.value * (ratio - 0.5) * next;
    logOrigin.value = anchorDay - offsetOfP(position);
    center.value = 0;
  } else {
    const anchor = pOfY(y);
    center.value = anchor + dir.value * (0.5 - ratio) * next;
  }

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

/** 轴线热区之外：滚轮平移时间 */
function onCanvasWheel(event: WheelEvent) {
  const scaleBy =
    event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? plotHeight.value : 1;
  const shift =
    dir.value * ((event.deltaY * scaleBy) / plotHeight.value) * span.value;

  if (scale.value === "log") {
    logOrigin.value = fromP(shift);
    center.value = 0;
  } else {
    center.value += shift;
  }
  clampView();
}

function centerOn(day: number) {
  if (scale.value === "log") {
    logOrigin.value = clamp(day, DATA_MIN, DATA_MAX);
    center.value = 0;
  } else {
    center.value = pOf(day);
  }
  clampView();
  selected.value = null;
}

let drag: {
  x: number;
  y: number;
  center: number;
  origin: number;
  span: number;
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
  } else if (scale.value === "log") {
    // 以拖拽起点的基准换算中间线日期，避免逐帧叠加造成非线性加速
    logOrigin.value =
      drag.origin +
      offsetOfP(-dir.value * (dy / plotHeight.value) * drag.span);
    center.value = 0;
    clampView();
  } else {
    center.value =
      drag.center - dir.value * (dy / plotHeight.value) * span.value;
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
  // 每次重新按下都是一次新手势，避免上一次拖拽的 moved 标记吞掉气泡点击
  moved = false;
  const target = event.target as HTMLElement | null;
  if (target?.closest("button, a")) return;

  selected.value = null;
  drag = {
    x: event.clientX,
    y: event.clientY,
    center: center.value,
    origin: logOrigin.value,
    span: span.value,
    axisX: axisX.value,
    mode: null,
  };
  dragging.value = true;
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
}

function pick(id: number) {
  if (moved) return;
  selected.value = selected.value === id ? null : id;
}

function closeCard() {
  selected.value = null;
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") closeCard();
}

function onGlobalPointerDown(event: PointerEvent) {
  if (!searchOpen.value) return;
  const target = event.target as Node | null;
  if (target && searchWrap.value?.contains(target)) return;
  searchOpen.value = false;
}

let lastSelected: number | null = null;
let fromSearch = false;
watch(selected, async (id) => {
  const previous = lastSelected;
  lastSelected = id;
  if (fromSearch) {
    fromSearch = false;
    return;
  }
  await nextTick();
  const el = viewport.value;
  if (!el) return;
  if (id !== null) {
    el.querySelector<HTMLButtonElement>(".axis-event__close")?.focus({
      preventScroll: true,
    });
  } else if (previous !== null) {
    el.querySelector<HTMLButtonElement>(`[data-event="${previous}"]`)?.focus({
      preventScroll: true,
    });
  }
});

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
  /** 标签间距不足时只隐藏文字，虚线始终保留 */
  showLabel: boolean;
}

const ticks = computed<Tick[]>(() => {
  // 按整块画布而非可视区生成刻度，虚线一直画到画布边缘再由 overflow 裁剪
  const canvasStart = dayOfY(height.value);
  const canvasEnd = dayOfY(0);
  const start = Math.min(canvasStart, canvasEnd);
  const end = Math.max(canvasStart, canvasEnd);
  const days = Math.max(1, end - start);
  const px = Math.max(1, height.value);
  const raw: { day: number; label: string }[] = [];

  if (days > YEAR_DAYS * 3) {
    const spanYears = days / YEAR_DAYS;
    // 对数轴按固定时间步长生成刻度，让虚线的疏密直接体现时间被压缩的程度
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
  let lastLabelY = Number.NEGATIVE_INFINITY;
  for (const tick of raw) {
    // 越界刻度交给 .axis 的 overflow 裁剪，不在接近边缘时提前卸载
    const y = yOfP(pOf(tick.day));
    // 虚线全部保留，密度如实反映对数轴的时间压缩；只对重叠文字做筛选
    const showLabel = Math.abs(y - lastLabelY) >= MIN_TICK_LABEL_GAP;
    if (showLabel) lastLabelY = y;
    kept.push({ ...tick, y, showLabel });
  }
  return kept;
});

interface Placed extends AxisEvent {
  anchor: number;
  labelTop: number;
}

const placed = computed<Record<Side, Placed[]>>(() => {
  const result: Record<Side, Placed[]> = { uk: [], us: [] };

  for (const side of SIDES) {
    // 任何缩放都纳入全部事件，是否显示只由标签遮挡筛选决定
    const list = events
      .filter((event) => event.side === side)
      .map((event) => ({ ...event, anchor: yOfDay(event.day) }))
      // 滚出画布的标签由 .axis 的 overflow 裁掉，不提前卸载
      .sort((a, b) => a.anchor - b.anchor);

    const keep = pickVisible(
      list.map((event) => ({
        anchor: event.anchor,
        height: LABEL_HEIGHT[event.lvl],
        level: event.lvl,
      })),
    );

    result[side] = list
      // 选中的事件始终保留，卡片不因遮挡筛选而消失
      .filter((event, index) => keep[index] || event.id === selected.value)
      .map((event) => ({
        ...event,
        labelTop: event.anchor - LABEL_HEIGHT[event.lvl] / 2,
      }));
  }

  return result;
});

/** 标签与轴线之间的水平连线 */
const links = computed(() => {
  const out: { id: number; side: Side; y: number; x2: number }[] = [];

  for (const side of SIDES) {
    const x2 = side === "uk" ? axisX.value - AXIS_GAP : axisX.value + AXIS_GAP;
    for (const event of placed.value[side]) {
      out.push({ id: event.id, side, y: event.anchor, x2 });
    }
  }

  return out;
});

/** 区间线段：标签被遮挡筛选隐藏时，时间跨度本身仍如实显示 */
const ranges = computed(() => {
  const out: { id: number; side: Side; x: number; y1: number; y2: number }[] =
    [];

  for (const side of SIDES) {
    const x = axisX.value + (side === "uk" ? -RANGE_OFFSET : RANGE_OFFSET);
    for (const event of events) {
      if (event.side !== side || event.endDay === null) continue;
      out.push({
        id: event.id,
        side,
        x,
        y1: yOfDay(event.day),
        y2: yOfDay(event.endDay),
      });
    }
  }

  return out;
});

/** 卡片与搜索使用的完整日期；区间事件给出两个端点 */
const detailStamp = (event: AxisEvent) =>
  event.endStamp ? `${event.startStamp}–${event.endStamp}` : event.startStamp;

/** 标签保持紧凑：跨年区间只写年份，同年区间不重复年份 */
const labelStamp = (event: AxisEvent) => {
  if (event.endYear === null) return event.startStamp;
  return event.year === event.endYear
    ? String(event.year)
    : `${event.year}–${event.endYear}`;
};

const results = computed<AxisEvent[]>(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return [];
  return events
    .filter((event) =>
      [
        event.title,
        event.tag,
        event.desc,
        laneLabel(event.side),
        labelStamp(event),
        detailStamp(event),
      ].some((field) => field.toLowerCase().includes(q)),
    )
    .sort((a, b) => a.day - b.day);
});

const shownResults = computed(() => results.value.slice(0, 8));
const searchVisible = computed(
  () => searchOpen.value && query.value.trim().length > 0,
);
const activeDescendant = computed(() => {
  const item = shownResults.value[activeResult.value];
  return searchVisible.value && item ? `search-option-${item.id}` : undefined;
});

watch(results, () => {
  activeResult.value = 0;
});

function onSearchInput(event: Event) {
  query.value = (event.target as HTMLInputElement).value;
  searchOpen.value = true;
}

function onSearchKeydown(event: KeyboardEvent) {
  if (event.isComposing) return;
  const list = shownResults.value;
  if (event.key === "ArrowDown" && list.length > 0) {
    event.preventDefault();
    activeResult.value = (activeResult.value + 1) % list.length;
  } else if (event.key === "ArrowUp" && list.length > 0) {
    event.preventDefault();
    activeResult.value = (activeResult.value - 1 + list.length) % list.length;
  } else if (event.key === "Enter" && list.length > 0) {
    event.preventDefault();
    locate(list[activeResult.value]);
  } else if (event.key === "Escape" && searchVisible.value) {
    event.stopPropagation();
    searchOpen.value = false;
  }
}

/** 定位时收窄到的视野（年），0 表示保持当前跨度 */
const LOCATE_SPAN_YEARS: Record<1 | 2 | 3, number> = { 1: 0, 2: 120, 3: 30 };

/** 定位到搜索结果：居中到该事件，收窄到能显示其层级的跨度，并展开卡片 */
function locate(event: AxisEvent) {
  const end = event.endDay ?? event.day;
  const middle = (event.day + end) / 2;
  const duration = Math.abs(end - event.day);
  // 区间事件至少要让整个区间落在视野内，再叠加层级要求的跨度
  const target = Math.max(YEAR_DAYS * LOCATE_SPAN_YEARS[event.lvl], duration);
  if (
    target > 0 &&
    (visibleDays.value > target || duration > visibleDays.value)
  ) {
    span.value = clamp(
      scale.value === "linear"
        ? target
        : scale.value === "log"
          ? 2 * Math.log1p(target / 2 / unitDays.value)
          : Math.abs(pOf(middle + target / 2) - pOf(middle - target / 2)),
      minSpan.value,
      maxSpan.value,
    );
  }
  centerOn(middle);
  fromSearch = true;
  selected.value = event.id;
  searchOpen.value = false;
}

/** 卡片取代气泡出现在同一位置：贴向轴线一侧，并保证整体留在画布内 */
function cardStyle(event: Placed) {
  const room =
    event.side === "uk"
      ? axisX.value - AXIS_GAP
      : width.value - axisX.value - AXIS_GAP;
  const maxWidth = width.value - CARD_PAD * 2;
  const cardWidth = clamp(
    Math.min(room, CARD_MAX_WIDTH),
    Math.min(CARD_MIN_WIDTH, maxWidth),
    maxWidth,
  );
  const preferred =
    event.side === "uk"
      ? axisX.value - AXIS_GAP - cardWidth
      : axisX.value + AXIS_GAP;
  const left = clamp(preferred, CARD_PAD, width.value - CARD_PAD - cardWidth);
  const half = Math.max(
    48,
    Math.min(
      event.anchor - CARD_PAD,
      height.value - event.anchor - CARD_PAD,
    ),
  );
  const top = clamp(
    event.anchor,
    CARD_PAD + half,
    height.value - CARD_PAD - half,
  );

  return {
    left: `${left}px`,
    top: `${top}px`,
    width: `${cardWidth}px`,
    maxHeight: `${half * 2}px`,
  };
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

const scaleLabel = computed(() =>
  scale.value === "linear" ? "线性" : "对数",
);

let observer: ResizeObserver | undefined;

function syncSize() {
  const el = viewport.value;
  if (!el) return;
  const wasCentered = Math.abs(axisX.value - width.value / 2) < 2;
  width.value = Math.max(320, el.clientWidth);
  height.value = Math.max(120, el.clientHeight);
  if (wasCentered) axisX.value = width.value / 2;
  clampAxis();
}

onMounted(() => {
  syncSize();
  fitAll();
  observer = new ResizeObserver(syncSize);
  if (viewport.value) observer.observe(viewport.value);
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("pointerdown", onGlobalPointerDown);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("pointerdown", onGlobalPointerDown);
  onPointerUp();
});
</script>

<template>
  <section class="view">
    <div
      ref="viewport"
      class="axis"
      :class="{ 'is-dragging': dragging }"
      @pointerdown="onPointerDown"
      @wheel.prevent="onCanvasWheel"
    >
      <i
        v-for="tick in ticks"
        :key="tick.day"
        class="axis__tick"
        :style="{ top: `${tick.y}px` }"
      >
        <span v-if="tick.showLabel">{{ tick.label }}</span>
      </i>

      <div class="axis__spine" :style="{ left: `${axisX}px` }"></div>

      <svg
        class="axis__links"
        :width="width"
        :height="height"
        aria-hidden="true"
      >
        <line
          v-for="range in ranges"
          :key="`range-${range.id}`"
          class="axis__range"
          :class="range.side"
          :x1="range.x"
          :x2="range.x"
          :y1="range.y1"
          :y2="range.y2"
        ></line>
        <line
          v-for="link in links"
          :key="link.id"
          :class="link.side"
          :x1="axisX"
          :x2="link.x2"
          :y1="link.y"
          :y2="link.y"
        ></line>
      </svg>

      <div
        class="axis__today"
        :class="{ 'is-lifted': Math.abs(todayY - height / 2) < 24 }"
        :style="{ top: `${todayY}px` }"
      >
        <span>今天</span>
      </div>

      <div class="axis__midline" :style="{ top: `${height / 2}px` }">
        <span @wheel.prevent.stop="onAxisWheel">
          基准 {{ originText }}
        </span>
      </div>

      <template v-for="side in SIDES" :key="side">
        <template v-for="event in placed[side]" :key="event.id">
          <span
            class="axis-event__dot"
            :class="[`is-${side}`, { 'is-l1': event.lvl === 1 }]"
            :style="{ left: `${axisX}px`, top: `${event.anchor}px` }"
          ></span>
          <div
            v-if="selected === event.id"
            class="axis-event__card"
            :class="`is-${side}`"
            role="group"
            :aria-labelledby="`event-title-${event.id}`"
            :style="cardStyle(event)"
            @pointerdown.stop
            @wheel.stop
          >
            <button
              class="axis-event__close"
              type="button"
              aria-label="收起事件卡片"
              @click.stop="closeCard"
            >
              ×
            </button>
            <button
              class="axis-event__origin"
              :class="{ 'is-on': Math.abs(event.day - logOrigin) < 0.5 }"
              type="button"
              aria-label="把该事件移到中间线作为对数基准"
              title="把该事件移到中间线作为对数基准"
              @click.stop="useEventOrigin(event.day)"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="8" cy="8" r="3.2"></circle>
                <path d="M8 1v2.6M8 12.4V15M1 8h2.6M12.4 8H15"></path>
              </svg>
            </button>
            <p class="axis-event__meta">
              <b>{{ detailStamp(event) }}</b> · {{ laneLabel(side) }} ·
              {{ event.tag }} · L{{ event.lvl }}
            </p>
            <h3 :id="`event-title-${event.id}`" class="axis-event__title">
              {{ event.title }}
            </h3>
            <p class="axis-event__desc">{{ event.desc }}</p>
          </div>
          <button
            v-else
            class="axis-event__label"
            :class="[`is-${side}`, { 'is-l1': event.lvl === 1 }]"
            :style="labelStyle(event)"
            type="button"
            :data-event="event.id"
            :title="`${labelStamp(event)} ${event.title}`"
            @click.stop="pick(event.id)"
          >
            <b>{{ labelStamp(event) }}</b><span>{{ event.title }}</span>
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
        @wheel.prevent.stop="onAxisWheel"
        @pointermove="onAxisMove"
        @pointerleave="clearHover"
      ></div>
    </div>
    <div class="toolbar">
      <div ref="searchWrap" class="search" role="search">
        <svg class="search__icon" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5"></circle>
          <path d="m10.5 10.5 3.5 3.5"></path>
        </svg>
        <input
          class="search__input"
          type="search"
          :value="query"
          placeholder="搜索事件 / 年份 / 分类"
          aria-label="搜索历史事件"
          role="combobox"
          aria-autocomplete="list"
          aria-controls="event-search-results"
          :aria-expanded="searchVisible"
          :aria-activedescendant="activeDescendant"
          @input="onSearchInput"
          @focus="searchOpen = true"
          @keydown="onSearchKeydown"
        />
        <ul
          v-if="searchVisible"
          id="event-search-results"
          class="search__results"
          role="listbox"
        >
          <li v-for="(item, index) in shownResults" :key="item.id">
            <button
              :id="`search-option-${item.id}`"
              class="search__result"
              :class="{ 'is-active': index === activeResult }"
              type="button"
              role="option"
              :aria-selected="index === activeResult"
              @click="locate(item)"
            >
              <b>{{ detailStamp(item) }}</b>
              <span class="search__title">{{ item.title }}</span>
              <span class="search__lane">{{ laneLabel(item.side) }}</span>
            </button>
          </li>
          <li v-if="shownResults.length === 0" class="search__empty">
            没有匹配的事件
          </li>
          <li
            v-else-if="results.length > shownResults.length"
            class="search__empty"
          >
            另有 {{ results.length - shownResults.length }} 条匹配，继续输入以缩小范围
          </li>
        </ul>
      </div>
      <span class="toolbar__value">
        {{ scaleLabel }}<template v-if="scale === 'log'"> · 单位 {{ UNIT_LABEL[unit] }}</template>
        · {{ pxPerYear >= 1 ? pxPerYear.toFixed(1) : pxPerYear.toFixed(3) }} px / 年
      </span>
      <span class="toolbar__spacer"></span>
      <button class="btn" type="button" @click="fitAll">全览</button>
      <button class="btn" type="button" @click="centerOn(todayDay)">今天</button>
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
        class="seg"
        role="group"
        aria-label="时间方向"
        :title="reversed ? '反向：今天在上，历史向下' : '正向：历史在上，今天在下'"
      >
        <button
          type="button"
          :class="{ 'is-on': !reversed }"
          @click="reversed = false"
        >
          正向
        </button>
        <button
          type="button"
          :class="{ 'is-on': reversed }"
          @click="reversed = true"
        >
          反向
        </button>
      </div>
      <div
        v-if="scale === 'log'"
        class="seg"
        role="group"
        aria-label="对数单位"
        title="对数单位决定靠近基准处被拉开的程度"
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
      <div
        v-if="scale === 'log'"
        class="origin"
        title="对数基准：始终取中间线所在日期，越靠近中间线越舒展；输入日期会把该日期移到中间线"
      >
        <label class="origin__label" for="log-origin">基准</label>
        <input
          id="log-origin"
          ref="originInput"
          class="origin__input"
          type="text"
          inputmode="numeric"
          autocomplete="off"
          spellcheck="false"
          placeholder="今天"
          aria-label="对数基准，输入 YYYY 或 YYYY-MM-DD，留空回到今天"
          :value="originText"
          @change="applyOrigin"
          @keydown.enter.prevent="applyOrigin"
        />
        <button
          v-if="Math.round(logOrigin) !== todayDay"
          class="origin__reset"
          type="button"
          aria-label="对数基准回到今天"
          title="基准回到今天"
          @click="resetOrigin"
        >
          ↺
        </button>
      </div>
    </div>
  </section>
</template>
