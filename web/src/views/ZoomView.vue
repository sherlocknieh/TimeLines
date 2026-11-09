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
const LEVEL_NAME: Record<1 | 2 | 3, string> = {
  1: "主脉",
  2: "通史",
  3: "细节",
};

/** 轴线与事件标签之间的横向距离 */
const AXIS_GAP = 30;
/** 标签高度（像素）：L1 字号更大，用于遮挡判断与垂直居中 */
const LABEL_HEIGHT: Record<1 | 2 | 3, number> = { 1: 28, 2: 25, 3: 25 };
/** 画布上下留白，给最靠边的事件标签留出显示空间 */
const PLOT_PAD = 96;
/** 事件卡片的尺寸约束，展开后仍要留在画布内 */
const CARD_MAX_WIDTH = 320;
const CARD_MIN_WIDTH = 160;
const CARD_PAD = 12;

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
/** 数据范围：历史端留一点余量，未来端止于今天 */
const DATA_MIN = Math.min(...eventDays) - Math.round(YEAR_DAYS * 3);
const DATA_MAX = Math.max(...eventDays, todayDay);
/** 今天之后只留少量可平移空间，避免空白的未来占掉太多画布 */
const FUTURE_PAD = Math.round(YEAR_DAYS * 2);
/** 允许平移/缩放的硬边界，避免对数坐标算出无法表示的日期 */
const SAFE_MIN = DATA_MIN - Math.round(YEAR_DAYS * 2500);
const SAFE_MAX = DATA_MAX + FUTURE_PAD;

const viewport = ref<HTMLElement | null>(null);
const width = ref(1100);
const height = ref(560);
const scale = ref<ScaleMode>("linear");
/** 对数起点：默认今天，可改成任意日期，起点前后两段都按对数展开 */
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

/** 对数模式以「起点」为界做有符号对数压缩，起点前后都按对数展开；线性模式直接用日序号 */
function pOf(day: number): number {
  if (scale.value === "linear") return day;
  const delta = day - logOrigin.value;
  return Math.sign(delta) * Math.log1p(Math.abs(delta) / unitDays.value);
}

function fromP(position: number): number {
  if (scale.value === "linear") return position;
  const sign = Math.sign(position);
  return (
    logOrigin.value + sign * unitDays.value * Math.expm1(Math.abs(position))
  );
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

/** 切换坐标分布、基准单位或对数起点时，尽量保持当前可见的日期区间不变 */
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

/** 换对数起点：日期区间保持不变，只是围绕新起点重新压缩 */
function setOrigin(day: number) {
  const next = clamp(Math.round(day), DATA_MIN, DATA_MAX);
  if (next === logOrigin.value) return;
  preserveView(() => {
    logOrigin.value = next;
  });
}

const isoOf = (day: number) =>
  `${yearOf(day)}-${pad(monthOf(day))}-${pad(dateOf(day))}`;

/** 起点就是今天时输入框留空，用占位符表达默认值 */
const originText = computed(() =>
  logOrigin.value === todayDay ? "" : isoOf(logOrigin.value),
);

/** 解析 YYYY / YYYY-MM / YYYY-MM-DD；只写年份时取年中，与无日期的数据一致 */
function parseDay(text: string): number | null {
  const match = /^(\d{1,4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = clamp(Number(match[2] ?? 7), 1, 12);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
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

/** 以某个事件为对数起点：切到对数分布，把起点落在该事件上并居中显示 */
function useEventOrigin(day: number) {
  if (scale.value === "linear") setScale("log");
  setOrigin(day);
  center.value = pOf(day);
  clampView();
}

function zoomAt(factor: number, y: number) {
  const anchor = pOfY(y);
  const next = clamp(span.value / factor, minSpan.value, maxSpan.value);
  const ratio = (y - PLOT_PAD) / plotHeight.value;
  center.value = anchor + dir.value * (0.5 - ratio) * next;
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
  center.value +=
    dir.value * ((event.deltaY * scaleBy) / plotHeight.value) * span.value;
  clampView();
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
    if (kept.length > 0 && Math.abs(y - kept[kept.length - 1].y) < 52) continue;
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
}

const placed = computed<Record<Side, Placed[]>>(() => {
  const result: Record<Side, Placed[]> = { uk: [], us: [] };

  for (const side of SIDES) {
    const list = events
      .filter(
        (event) =>
          event.side === side &&
          (event.lvl <= level.value || event.id === selected.value),
      )
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

function stamp(event: AxisEvent): string {
  if (!event.precise || level.value < 3) return String(event.year);
  return `${event.year}-${pad(monthOf(event.day))}-${pad(dateOf(event.day))}`;
}

function fullStamp(event: AxisEvent): string {
  if (!event.precise) return String(event.year);
  return `${event.year}-${pad(monthOf(event.day))}-${pad(dateOf(event.day))}`;
}

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
        fullStamp(event),
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
  const target = YEAR_DAYS * LOCATE_SPAN_YEARS[event.lvl];
  if (target > 0 && visibleDays.value > target) {
    span.value = clamp(
      scale.value === "linear"
        ? target
        : Math.abs(pOf(event.day + target / 2) - pOf(event.day - target / 2)),
      minSpan.value,
      maxSpan.value,
    );
  }
  centerOn(event.day);
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
const originY = computed(() => yOfDay(logOrigin.value));

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
              <b>{{ fullStamp(item) }}</b>
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
        {{ scaleLabel }}<template v-if="scale === 'log'"> · 基准 {{ UNIT_LABEL[unit] }}</template>
        · {{ pxPerYear >= 1 ? pxPerYear.toFixed(1) : pxPerYear.toFixed(3) }} px / 年
      </span>
      <span class="toolbar__spacer"></span>
      <button class="btn" type="button" @click="fitAll">全览</button>
      <button class="btn" type="button" @click="centerOn(todayDay)">今天</button>
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
        aria-label="起点附近的基准单位"
        title="对数轴以起点为界，基准单位决定起点附近被拉开的程度"
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
        title="对数起点：起点前后两段都按对数展开，越靠近起点越舒展；留空表示以今天为起点"
      >
        <label class="origin__label" for="log-origin">起点</label>
        <input
          id="log-origin"
          ref="originInput"
          class="origin__input"
          type="text"
          inputmode="numeric"
          autocomplete="off"
          spellcheck="false"
          placeholder="今天"
          aria-label="对数起点，输入 YYYY 或 YYYY-MM-DD，留空表示今天"
          :value="originText"
          @change="applyOrigin"
          @keydown.enter.prevent="applyOrigin"
        />
        <button
          v-if="originText"
          class="origin__reset"
          type="button"
          aria-label="对数起点回到今天"
          title="起点回到今天"
          @click="resetOrigin"
        >
          ↺
        </button>
      </div>
    </div>

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
        <span>{{ tick.label }}</span>
      </i>

      <div class="axis__spine" :style="{ left: `${axisX}px` }"></div>

      <svg
        class="axis__links"
        :width="width"
        :height="height"
        aria-hidden="true"
      >
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

      <div class="axis__today" :style="{ top: `${todayY}px` }">
        <span>今天</span>
      </div>

      <div
        v-if="scale === 'log' && logOrigin !== todayDay"
        class="axis__origin"
        :style="{ top: `${originY}px` }"
      >
        <span>起点 {{ isoOf(logOrigin) }}</span>
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
              :class="{ 'is-on': event.day === logOrigin }"
              type="button"
              aria-label="以该事件为对数起点"
              title="以该事件为对数起点"
              @click.stop="useEventOrigin(event.day)"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="8" cy="8" r="3.2"></circle>
                <path d="M8 1v2.6M8 12.4V15M1 8h2.6M12.4 8H15"></path>
              </svg>
            </button>
            <p class="axis-event__meta">
              <b>{{ fullStamp(event) }}</b> · {{ laneLabel(side) }} ·
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
        @wheel.prevent.stop="onAxisWheel"
        @pointermove="onAxisMove"
        @pointerleave="clearHover"
      ></div>
    </div>
  </section>
</template>
