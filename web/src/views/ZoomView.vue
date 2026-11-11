<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from "vue";

import { EVENTS, type LaneId } from "../data/events";
import {
  clamp,
  LANE_IDS,
  LANES,
  laneIndex,
  laneLabel,
  laneOf,
} from "../lib/dataset";
import { pickVisible } from "../lib/timeline";

const DAY_MS = 86_400_000;
const YEAR_DAYS = 365.2425;
const TODAY = new Date();

type ScaleMode = "linear" | "log";
type Unit = "day" | "month" | "year";

const UNITS: Unit[] = ["day", "month", "year"];
const UNIT_DAYS: Record<Unit, number> = {
  day: 1,
  month: YEAR_DAYS / 12,
  year: YEAR_DAYS,
};
const UNIT_LABEL: Record<Unit, string> = { day: "天", month: "月", year: "年" };

/** 时间线标题节点的上下留白：节点与轴线端部之间留一点间隙 */
const NODE_GAP = 10;
/** 轴线与事件标签之间的横向距离 */
const AXIS_GAP = 30;
/** 轴线缩放的横向热区宽度：以轴线为中心左右各一半 */
const AXIS_BAND = 64;
/** 轴线热区的最小纵向高度，轴段被视野压扁时仍能抓到 */
const AXIS_BAND_MIN = 12;
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

/** 按时间线分组的初始容器，条目数始终与 LANES 一致 */
const byLane = <T>(make: () => T): Record<LaneId, T> =>
  Object.fromEntries(LANE_IDS.map((lane) => [lane, make()])) as Record<
    LaneId,
    T
  >;

interface AxisEvent {
  id: number;
  day: number;
  endDay: number | null;
  year: number;
  endYear: number | null;
  lane: LaneId;
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
    lane: laneOf(event),
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

/** 面板上的时间线：名称与起止都能就地修改，缺省沿用 dataset 里的配置 */
const lanes = reactive(
  LANES.map((lane) => ({
    id: lane.id,
    label: lane.label,
    start: lane.start ?? "",
    end: lane.end ?? "",
  })),
);

const laneConfig = (lane: LaneId) => lanes.find((item) => item.id === lane);

/** 时间线的当前名称：优先取页面上改过的名字 */
const laneName = (lane: LaneId) =>
  laneConfig(lane)?.label ?? laneLabel(lane);

/** 解析时间线起止：只写年份时起点取年初、终点取年末 */
function parseLaneEdge(text: string, edge: "start" | "end"): number | null {
  const match = /^(-?\d{1,5})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const year = Number(match[1]);
  if (match[2] === undefined) {
    return edge === "start" ? utcDay(year, 1, 1) : utcDay(year, 12, 31);
  }
  const month = clamp(Number(match[2]), 1, 12);
  if (match[3] === undefined) {
    return edge === "start"
      ? utcDay(year, month, 1)
      : utcDay(year, month + 1, 0);
  }
  return utcDay(year, month, clamp(Number(match[3]), 1, 31));
}

/** 每条时间线自身事件的范围，作为未手动设定起止时的默认区段 */
const laneDefaults = computed<Record<LaneId, { from: number; to: number }>>(() => {
  const out = byLane(() => ({ from: DATA_MAX, to: DATA_MIN }));
  const seen: Record<LaneId, boolean> = byLane(() => false);
  for (const event of events) {
    const end = event.endDay ?? event.day;
    const range = out[event.lane];
    range.from = Math.min(range.from, event.day);
    range.to = Math.max(range.to, end);
    seen[event.lane] = true;
  }
  // 没有任何事件的时间线退回整段数据范围，至少能看出轴线位置
  for (const lane of LANE_IDS) {
    if (!seen[lane]) out[lane] = { from: DATA_MIN, to: DATA_MAX };
  }
  return out;
});

/** 每条时间线实际展示的日期区段：手动起止优先，否则取自身事件范围 */
const laneBounds = computed<Record<LaneId, { from: number; to: number }>>(() => {
  const out = byLane(() => ({ from: DATA_MIN, to: DATA_MAX }));
  for (const lane of lanes) {
    const fallback = laneDefaults.value[lane.id];
    const from = lane.start ? parseLaneEdge(lane.start, "start") : null;
    const to = lane.end ? parseLaneEdge(lane.end, "end") : null;
    const start = clamp(from ?? fallback.from, DATA_MIN, DATA_MAX);
    const stop = clamp(to ?? fallback.to, DATA_MIN, DATA_MAX);
    out[lane.id] = {
      from: Math.min(start, stop),
      to: Math.max(start, stop),
    };
  }
  return out;
});

/** 事件是否落在时间线的起止范围内；区间事件按重叠判断 */
function inLane(lane: LaneId, event: AxisEvent): boolean {
  const { from, to } = laneBounds.value[lane];
  const end = event.endDay ?? event.day;
  return event.day <= to && end >= from;
}

/** 回车即确认输入：失焦会触发 change，无需另写提交逻辑 */
function commitInput(event: KeyboardEvent) {
  (event.target as HTMLInputElement | null)?.blur();
}

/** 改写时间线名称，清空时回落到 dataset 里的默认名称 */
function renameLane(lane: LaneId, event: Event) {
  const input = event.target as HTMLInputElement;
  const conf = laneConfig(lane);
  if (!conf) return;
  const fallback = LANES.find((item) => item.id === lane)?.label ?? lane;
  conf.label = input.value.trim() || fallback;
  input.value = conf.label;
}

/** 改写时间线起止；无法解析时恢复原值 */
function setLaneEdge(lane: LaneId, edge: "start" | "end", event: Event) {
  const input = event.target as HTMLInputElement;
  const conf = laneConfig(lane);
  if (!conf) return;
  const text = input.value.trim();
  if (text === "") {
    conf[edge] = "";
    return;
  }
  if (parseLaneEdge(text, edge) === null) {
    input.value = conf[edge];
    return;
  }
  conf[edge] = text;
}

const viewport = ref<HTMLElement | null>(null);
/** 画布整体尺寸：所有时间线共用同一套纵向映射 */
const width = ref(1100);
const height = ref(560);
const scale = ref<ScaleMode>("linear");
/** 基准日：基准线选中的时间点，拖动基准线、输入日期或点准星都会改变它 */
const logOrigin = ref(todayDay);
const reversed = ref(false);
const unit = ref<Unit>("year");
const center = ref(0);
const span = ref(1);
/** 每条时间线各自的轴线横坐标（画布坐标），可分别左右拖动 */
const axisX = reactive<Record<LaneId, number>>(
  Object.fromEntries(LANE_IDS.map((lane) => [lane, 0])),
);
const selected = ref<number | null>(null);
const hover = ref<{ y: number; day: number; lane: LaneId } | null>(null);
const dragging = ref(false);
const query = ref("");
const searchOpen = ref(false);
const activeResult = ref(0);
const searchWrap = ref<HTMLElement | null>(null);
const originInput = ref<HTMLInputElement | null>(null);

/** 轴线默认位置：所有时间线在同一块画布里均匀铺开 */
const axisDefault = (lane: LaneId) =>
  ((laneIndex(lane) + 0.5) / Math.max(1, LANES.length)) * width.value;

/** 标签排在轴线的哪一侧：相邻两条时间线的标签因此背对背展开 */
const labelSide = (lane: LaneId): "left" | "right" =>
  laneIndex(lane) % 2 === 0 ? "right" : "left";

/** 轴线可移动的左右边界，保证标签与时间读数都还有落脚处 */
const axisMargin = computed(() =>
  Math.min(140, Math.max(64, width.value * 0.07)),
);

const unitDays = computed(() => UNIT_DAYS[unit.value]);

/** 屏幕方向：+1 历史在上、今天在下；-1 今天在上、历史向下 */
const dir = computed(() => (reversed.value ? -1 : 1));

/** 线性模式直接用日序号；对数以基准线为界做有符号压缩 */
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

/** 绘图区高度：整块画布都用于绘制 */
const plotArea = computed(() => Math.max(1, height.value));

/** 绘图区上下留白：面板变矮时同步收窄，避免留白吃掉可视高度 */
const plotPad = computed(() => Math.min(PLOT_PAD, plotArea.value * 0.18));

const plotHeight = computed(() =>
  Math.max(1, plotArea.value - plotPad.value * 2),
);

/** 基准线所在高度：始终画在选中日期上，随内容平移、缩放与反向移动 */
const midY = computed(() => yOfDay(logOrigin.value));

/** 纵向映射在整块画布里统一进行，所有时间线共用 */
const yOfP = (position: number) =>
  plotPad.value +
  ((dir.value * (position - center.value) + span.value / 2) / span.value) *
    plotHeight.value;

const pOfY = (y: number) =>
  center.value +
  dir.value * (((y - plotPad.value) / plotHeight.value - 0.5) * span.value);

const yOfDay = (day: number) => yOfP(pOf(day));
const dayOfY = (y: number) => fromP(pOfY(y));

const dayStart = computed(() => fromP(center.value - span.value / 2));
const dayEnd = computed(() => fromP(center.value + span.value / 2));
const visibleDays = computed(() => Math.max(1, dayEnd.value - dayStart.value));

const minSpan = computed(() => (scale.value === "linear" ? 2 : 0.01));
const maxSpan = computed(() =>
  scale.value === "linear"
    ? (DATA_MAX - DATA_MIN) * 2.5
    : // 对数视野最多展开整个数据跨度
      2 * Math.log1p((DATA_MAX - DATA_MIN) / unitDays.value),
);

function clampView() {
  span.value = clamp(span.value, minSpan.value, maxSpan.value);

  if (scale.value === "log") {
    logOrigin.value = clamp(logOrigin.value, DATA_MIN, DATA_MAX);
    // 允许往数据两侧各多平移一个视野，避免拖成完全空白
    const half = span.value / 2;
    center.value = clamp(
      center.value,
      pOf(DATA_MIN) - half,
      pOf(DATA_MAX) + half,
    );
    return;
  }

  const half = span.value / 2;
  if (span.value >= SAFE_MAX - SAFE_MIN) {
    center.value = (SAFE_MIN + SAFE_MAX) / 2;
  } else {
    center.value = clamp(center.value, SAFE_MIN + half, SAFE_MAX - half);
  }
}

function clampAxis(lane: LaneId) {
  axisX[lane] = clamp(
    axisX[lane],
    axisMargin.value,
    Math.max(axisMargin.value, width.value - axisMargin.value),
  );
}

function fitAll() {
  // 全览只调整视野，保留基准线选中的时间点
  const low = pOf(DATA_MIN);
  const high = pOf(DATA_MAX);
  span.value = Math.max(minSpan.value, high - low);
  center.value = (low + high) / 2;
  // 全览同时把所有轴线放回各自列的默认位置
  for (const lane of LANE_IDS) axisX[lane] = axisDefault(lane);
  selected.value = null;
  clampView();
}

/** 切换坐标分布或对数单位时，保持基准日与可见跨度不变 */
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

/** 选中指定日期作为基准：基准线移到该日期并居中显示 */
function setOrigin(day: number) {
  const next = clamp(Math.round(day), DATA_MIN, DATA_MAX);
  if (next === Math.round(logOrigin.value)) return;
  logOrigin.value = next;
  center.value = pOf(next);
  clampView();
}

const isoOf = (day: number) =>
  `${yearOf(day)}-${pad(monthOf(day))}-${pad(dateOf(day))}`;

/** 基准线上实时显示的日期，也就是当前选中的基准日 */
const middleDay = computed(() => dayOfY(midY.value));

/** 基准线日期始终显示在气泡与输入框里，拖动或缩放后同步更新 */
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

/** 把事件日期选为基准并居中，不切换分布 */
function useEventOrigin(day: number) {
  logOrigin.value = clamp(Math.round(day), DATA_MIN, DATA_MAX);
  center.value = pOf(logOrigin.value);
  clampView();
}

/** 指针落在哪条时间线上：优先看最近的 data-lane 容器，落在间隙时按位置就近归属 */
function laneAt(
  target: EventTarget | null,
  clientX?: number,
  clientY?: number,
): LaneId {
  const el = target as HTMLElement | null;
  const marked = el?.closest<HTMLElement>("[data-lane]")?.dataset.lane;
  if (marked !== undefined && LANE_IDS.includes(marked)) return marked;
  if (clientX === undefined) return LANE_IDS[0];
  // 落在空白处时归属到横向最近的轴线
  const rect = viewport.value?.getBoundingClientRect();
  const x = clientX - (rect?.left ?? 0);
  return LANE_IDS.reduce((best, lane) =>
    Math.abs(axisX[lane] - x) < Math.abs(axisX[best] - x) ? lane : best,
  );
}

/** 把视口坐标换算成画布内的纵向坐标 */
function localY(clientY: number): number {
  const rect = viewport.value?.getBoundingClientRect();
  return clientY - (rect?.top ?? 0);
}

function zoomAt(factor: number, y: number) {
  const next = clamp(span.value / factor, minSpan.value, maxSpan.value);
  const ratio = (y - plotPad.value) / plotHeight.value;
  // 锚点日期保持不动，基准日不变，基准线随内容移到新位置
  const anchorDay = dayOfY(y);
  center.value = pOf(anchorDay) - dir.value * (ratio - 0.5) * next;
  span.value = next;
  clampView();
}

function onAxisWheel(event: WheelEvent) {
  const y = clamp(
    localY(event.clientY),
    plotPad.value,
    Math.max(plotPad.value, plotArea.value - plotPad.value),
  );
  zoomAt(Math.exp(-event.deltaY * 0.002), y);
}

/** 轴线热区之外：滚轮平移时间 */
function onCanvasWheel(event: WheelEvent) {
  // 事件标签与标题节点里的输入自己处理滚轮，不抢占成时间平移
  if ((event.target as HTMLElement | null)?.closest(".lane-node, input")) return;
  event.preventDefault();
  const scaleBy =
    event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? plotHeight.value : 1;
  const shift =
    dir.value * ((event.deltaY * scaleBy) / plotHeight.value) * span.value;

  center.value += shift;
  clampView();
}

/** 只把视野移到指定日期，不改变基准线选中的时间点 */
function centerOn(day: number) {
  center.value = pOf(day);
  clampView();
  selected.value = null;
}

let drag: {
  x: number;
  y: number;
  top: number;
  center: number;
  origin: number;
  span: number;
  lane: LaneId;
  axisX: number;
  /** 手势是否起于轴线热区：只有轴上横向拖动才移动轴线 */
  canAxis: boolean;
  mode: "axis" | "time" | "mid" | "none" | null;
} | null = null;
let moved = false;

function onPointerMove(event: PointerEvent) {
  if (!drag) return;

  const dx = event.clientX - drag.x;
  const dy = event.clientY - drag.y;

  if (drag.mode === null && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
    // 只有起于轴段热区的横向手势才拖轴，其余横向手势不移动任何东西
    if (Math.abs(dx) > Math.abs(dy)) drag.mode = drag.canAxis ? "axis" : "none";
    else drag.mode = "time";
  }
  if (drag.mode === null || drag.mode === "none") return;

  moved = true;
  if (drag.mode === "axis") {
    // 只移动指针所在那条时间线的轴线，另一条保持不动
    axisX[drag.lane] = drag.axisX + dx;
    clampAxis(drag.lane);
  } else if (drag.mode === "mid") {
    // 基准线搬到指针处并选中该日期：按拖拽起点的布局换算，避免逐帧叠加失真
    const ratio = clamp(
      (event.clientY - drag.top - plotPad.value) /
        plotHeight.value,
      0.05,
      0.95,
    );
    const position = drag.center + dir.value * (ratio - 0.5) * drag.span;
    const day =
      scale.value === "log"
        ? drag.origin + offsetOfP(position)
        : position;
    logOrigin.value = clamp(Math.round(day), DATA_MIN, DATA_MAX);
    // 让基准线正好落在指针高度上
    center.value =
      pOf(logOrigin.value) - dir.value * (ratio - 0.5) * span.value;
    clampView();
  } else {
    // 平移时间：只移动视野，基准线随选中的日期一起移动
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
  if (target?.closest("button, a, input, label, .lane-node")) return;

  // 指针落在哪条时间线上，就只拖动那条线的轴线
  const lane = laneAt(target, event.clientX, event.clientY);
  const top = viewport.value?.getBoundingClientRect().top ?? 0;

  // 基准线在两种分布下都可抓取：气泡本身或线上下几条像素
  const onMidline =
    Boolean(target?.closest(".axis__midline")) ||
    Math.abs(event.clientY - top - midY.value) <= 8;

  selected.value = null;
  drag = {
    x: event.clientX,
    y: event.clientY,
    top,
    center: center.value,
    origin: logOrigin.value,
    span: span.value,
    lane,
    axisX: axisX[lane],
    // 轴线只在自身区段内可拖，其余位置横拖不再移动轴线
    canAxis: inAxisBand(lane, event.clientX, event.clientY),
    mode: onMidline ? "mid" : null,
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
  const lane = laneAt(event.currentTarget, event.clientX, event.clientY);
  const y = clamp(localY(event.clientY), 0, plotArea.value);
  const plotY = clamp(
    y,
    plotPad.value,
    Math.max(plotPad.value, plotArea.value - plotPad.value),
  );
  hover.value = { y, day: dayOfY(plotY), lane };
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
  // 按整列而非可视区生成刻度，虚线一直画到列边缘再由 overflow 裁剪
  const canvasStart = dayOfY(plotArea.value);
  const canvasEnd = dayOfY(0);
  const start = Math.min(canvasStart, canvasEnd);
  const end = Math.max(canvasStart, canvasEnd);
  const days = Math.max(1, end - start);
  const px = Math.max(1, plotArea.value);
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

const placed = computed<Record<LaneId, Placed[]>>(() => {
  const result = byLane<Placed[]>(() => []);

  for (const lane of LANE_IDS) {
    // 任何缩放都纳入全部事件，是否显示只由标签遮挡筛选决定
    const list = events
      .filter((event) => event.lane === lane && inLane(lane, event))
      .map((event) => ({ ...event, anchor: yOfDay(event.day) }))
      // 滚出画布的标签由列的 overflow 裁掉，不提前卸载
      .sort((a, b) => a.anchor - b.anchor);

    const keep = pickVisible(
      list.map((event) => ({
        anchor: event.anchor,
        height: LABEL_HEIGHT[event.lvl],
        level: event.lvl,
      })),
    );

    result[lane] = list
      // 选中的事件始终保留，卡片不因遮挡筛选而消失
      .filter((event, index) => keep[index] || event.id === selected.value)
      .map((event) => ({
        ...event,
        labelTop: event.anchor - LABEL_HEIGHT[event.lvl] / 2,
      }));
  }

  return result;
});

/** 标签与轴线之间的水平连线，坐标相对各自列 */
const links = computed<Record<LaneId, { id: number; y: number; x1: number; x2: number }[]>>(
  () => {
    const out = byLane<{ id: number; y: number; x1: number; x2: number }[]>(
      () => [],
    );

    for (const lane of LANE_IDS) {
      const x1 = axisX[lane];
      const x2 = x1 + (labelSide(lane) === "left" ? -AXIS_GAP : AXIS_GAP);
      for (const event of placed.value[lane]) {
        out[lane].push({ id: event.id, y: event.anchor, x1, x2 });
      }
    }

    return out;
  },
);

/** 区间线段：标签被遮挡筛选隐藏时，时间跨度本身仍如实显示 */
const ranges = computed<Record<LaneId, { id: number; x: number; y1: number; y2: number }[]>>(
  () => {
    const out = byLane<{ id: number; x: number; y1: number; y2: number }[]>(
      () => [],
    );

    for (const lane of LANE_IDS) {
      const x =
        axisX[lane] + (labelSide(lane) === "left" ? -RANGE_OFFSET : RANGE_OFFSET);
      for (const event of events) {
        if (event.lane !== lane || event.endDay === null) continue;
        if (!inLane(lane, event)) continue;
        out[lane].push({
          id: event.id,
          x,
          y1: yOfDay(event.day),
          y2: yOfDay(event.endDay),
        });
      }
    }

    return out;
  },
);

/** 统一绘图区里的连线与区间：所有时间线的坐标已经落在同一套画布坐标系 */
const allLinks = computed(() =>
  LANE_IDS.flatMap((lane) =>
    links.value[lane].map((link) => ({ ...link, lane })),
  ),
);

const allRanges = computed(() =>
  LANE_IDS.flatMap((lane) =>
    ranges.value[lane].map((range) => ({ ...range, lane })),
  ),
);

/** 每条时间线的事件总数，显示在顶部时间线栏 */
const totals = computed<Record<LaneId, number>>(() => {
  const out = byLane(() => 0);
  for (const event of events) {
    if (inLane(event.lane, event)) out[event.lane] += 1;
  }
  return out;
});

/** 标题节点贴在轴线的起始端，默认朝上、反向显示时朝下 */
function nodeStyle(lane: LaneId): Record<string, string> {
  const startY = yOfDay(laneBounds.value[lane].from);
  return {
    left: `${axisX[lane]}px`,
    top: `${startY + (dir.value > 0 ? -NODE_GAP : NODE_GAP)}px`,
  };
}

/** 轴线只画在时间线的起止范围内，两端实心结束 */
function spineStyle(lane: LaneId) {
  const { from, to } = laneBounds.value[lane];
  const a = yOfDay(from);
  const b = yOfDay(to);
  return {
    left: `${axisX[lane]}px`,
    top: `${Math.min(a, b)}px`,
    height: `${Math.abs(b - a)}px`,
  };
}

/** 轴线热区的纵向范围：与轴线等长，只覆盖这条时间线的起止区段 */
function axisBand(lane: LaneId): { top: number; height: number } {
  const { from, to } = laneBounds.value[lane];
  const a = yOfDay(from);
  const b = yOfDay(to);
  const span = Math.abs(b - a);
  // 轴段被视野压得比最小热区还短时，围绕轴段中心向外补足
  const height = Math.max(AXIS_BAND_MIN, span);
  return { top: Math.min(a, b) - (height - span) / 2, height };
}

/** 指针是否落在某条轴线的热区内：横向贴轴、纵向落在轴段上 */
function inAxisBand(lane: LaneId, clientX: number, clientY: number): boolean {
  const rect = viewport.value?.getBoundingClientRect();
  if (!rect) return false;
  const { top, height } = axisBand(lane);
  const y = clientY - rect.top;
  return (
    Math.abs(clientX - rect.left - axisX[lane]) <= AXIS_BAND / 2 &&
    y >= top &&
    y <= top + height
  );
}

/** 缩放热区与轴线等长，滚轮只在轴段上生效 */
function bandStyle(lane: LaneId) {
  const { top, height } = axisBand(lane);
  return {
    left: `${axisX[lane] - AXIS_BAND / 2}px`,
    top: `${top}px`,
    height: `${height}px`,
  };
}

/**
 * 标签可用的横向空间：算到标签一侧最近的轴线或画布边缘。
 * 相邻两条时间线的标签会在同一段间隔里相遇，相遇时各占一半。
 */
function labelRoom(lane: LaneId): number {
  const x = axisX[lane];
  const xs = LANE_IDS.map((id) => axisX[id]).sort((a, b) => a - b);
  const right = labelSide(lane) === "right";
  const neighbor = right
    ? xs.find((value) => value > x + 1)
    : [...xs].reverse().find((value) => value < x - 1);
  const edge = right ? width.value : 0;
  const span = Math.abs((neighbor ?? edge) - x) / (neighbor === undefined ? 1 : 2);
  return span - AXIS_GAP - 8;
}

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
    // 已被时间线起止裁掉的事件搜不到，避免定位到一个不会出现的气泡
    .filter((event) => inLane(event.lane, event))
    .filter((event) =>
      [
        event.title,
        event.tag,
        event.desc,
        laneName(event.lane),
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

/** 卡片取代气泡出现在同一位置：排在轴线外侧，并保证整体留在画布内 */
function cardStyle(event: Placed) {
  const x = axisX[event.lane];
  const left = labelSide(event.lane) === "left";
  const maxWidth = width.value - CARD_PAD * 2;
  const cardWidth = clamp(
    Math.min(labelRoom(event.lane), CARD_MAX_WIDTH),
    Math.min(CARD_MIN_WIDTH, maxWidth),
    maxWidth,
  );
  const preferred = left ? x - AXIS_GAP - cardWidth : x + AXIS_GAP;
  const cardLeft = clamp(
    preferred,
    CARD_PAD,
    width.value - CARD_PAD - cardWidth,
  );
  const half = Math.max(
    48,
    Math.min(
      event.anchor - CARD_PAD,
      plotArea.value - event.anchor - CARD_PAD,
    ),
  );
  const top = clamp(
    event.anchor,
    CARD_PAD + half,
    plotArea.value - CARD_PAD - half,
  );

  return {
    left: `${cardLeft}px`,
    top: `${top}px`,
    width: `${cardWidth}px`,
    maxHeight: `${half * 2}px`,
  };
}

/** 标签排在轴线外侧，宽度不越过相邻轴线，文字先省略 */
function labelStyle(event: Placed) {
  const x = axisX[event.lane];
  const left = labelSide(event.lane) === "left";
  return {
    ...(left
      ? { right: `${width.value - x + AXIS_GAP}px` }
      : { left: `${x + AXIS_GAP}px` }),
    top: `${event.labelTop}px`,
    maxWidth: `${Math.max(80, labelRoom(event.lane))}px`,
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

/** 读数气泡放在轴线外侧 */
const readoutRight = computed(
  () => !hover.value || labelSide(hover.value.lane) === "right",
);

const hoverReadoutStyle = computed(() => {
  if (!hoverText.value || !hover.value) return {};
  const x = axisX[hover.value.lane];
  return readoutRight.value
    ? {
        top: `${hoverText.value.y}px`,
        left: `${x + AXIS_GAP}px`,
        right: "auto",
      }
    : {
        top: `${hoverText.value.y}px`,
        right: `${Math.max(0, width.value - x + AXIS_GAP)}px`,
        left: "auto",
      };
});

let observer: ResizeObserver | undefined;

function syncSize() {
  const el = viewport.value;
  if (!el) return;
  const wasDefault = LANE_IDS.every(
    (lane) => Math.abs(axisX[lane] - axisDefault(lane)) < 2,
  );
  width.value = Math.max(320, el.clientWidth);
  height.value = Math.max(120, el.clientHeight);
  // 尺寸变化后轴线仍停在默认位置时，跟着新的画布宽度重新对齐
  if (wasDefault) {
    for (const lane of LANE_IDS) axisX[lane] = axisDefault(lane);
  }
  for (const lane of LANE_IDS) clampAxis(lane);
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
      @wheel="onCanvasWheel"
    >
      <div class="axis__plot">
        <i
          v-for="tick in ticks"
          :key="tick.day"
          class="axis__tick"
          :style="{ top: `${tick.y}px` }"
        >
          <span v-if="tick.showLabel">{{ tick.label }}</span>
        </i>

        <svg
          class="axis__links"
          :width="width"
          :height="plotArea"
          aria-hidden="true"
        >
          <line
            v-for="range in allRanges"
            :key="`range-${range.lane}-${range.id}`"
            class="axis__range"
            :class="`is-${range.lane}`"
            :x1="range.x"
            :x2="range.x"
            :y1="range.y1"
            :y2="range.y2"
          ></line>
          <line
            v-for="link in allLinks"
            :key="`${link.lane}-${link.id}`"
            :class="`is-${link.lane}`"
            :x1="link.x1"
            :x2="link.x2"
            :y1="link.y"
            :y2="link.y"
          ></line>
        </svg>

        <div
          class="axis__today"
          :class="{ 'is-lifted': Math.abs(todayY - midY) < 24 }"
          :style="{ top: `${todayY}px` }"
        >
          <span>今天</span>
        </div>

        <div class="axis__midline" :style="{ top: `${midY}px` }">
          <span
            title="上下拖动基准线，选中指针处的日期"
            @wheel.prevent.stop="onAxisWheel"
          >
            基准 {{ originText }}
          </span>
        </div>

        <template v-for="lane in lanes" :key="lane.id">
          <div
            class="lane-group"
            :class="`is-${lane.id}`"
            :data-lane="lane.id"
          >
            <div class="axis__spine" :style="spineStyle(lane.id)"></div>

            <div
              class="lane-node"
              :class="dir > 0 ? 'is-above' : 'is-below'"
              :style="nodeStyle(lane.id)"
            >
              <div class="lane-node__head">
                <input
                  class="lane-node__name"
                  :value="lane.label"
                  aria-label="时间线名称"
                  spellcheck="false"
                  @change="renameLane(lane.id, $event)"
                  @keydown.enter.prevent="commitInput"
                  @pointerdown.stop
                  @wheel.stop
                />
                <span class="lane-node__count">{{ totals[lane.id] }}</span>
              </div>
              <div class="lane-node__edges">
                <input
                  class="lane-node__edge"
                  :value="lane.start"
                  placeholder="起"
                  title="起点，可写 YYYY、YYYY-MM 或 YYYY-MM-DD；留空取该线最早事件"
                  aria-label="时间线起点"
                  spellcheck="false"
                  @change="setLaneEdge(lane.id, 'start', $event)"
                  @keydown.enter.prevent="commitInput"
                  @pointerdown.stop
                  @wheel.stop
                />
                <i>–</i>
                <input
                  class="lane-node__edge"
                  :value="lane.end"
                  placeholder="止"
                  title="终点，可写 YYYY、YYYY-MM 或 YYYY-MM-DD；留空取该线最晚事件"
                  aria-label="时间线终点"
                  spellcheck="false"
                  @change="setLaneEdge(lane.id, 'end', $event)"
                  @keydown.enter.prevent="commitInput"
                  @pointerdown.stop
                  @wheel.stop
                />
              </div>
            </div>

            <template v-for="event in placed[lane.id]" :key="event.id">
              <span
                class="axis-event__dot"
                :class="{ 'is-l1': event.lvl === 1 }"
                :style="{ left: `${axisX[lane.id]}px`, top: `${event.anchor}px` }"
              ></span>
              <div
                v-if="selected === event.id"
                class="axis-event__card"
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
                  aria-label="把该事件移到基准线作为对数基准"
                  title="把该事件移到基准线作为对数基准"
                  @click.stop="useEventOrigin(event.day)"
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <circle cx="8" cy="8" r="3.2"></circle>
                    <path d="M8 1v2.6M8 12.4V15M1 8h2.6M12.4 8H15"></path>
                  </svg>
                </button>
                <p class="axis-event__meta">
                  <b>{{ detailStamp(event) }}</b> · {{ lane.label }} ·
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
                :class="{ 'is-l1': event.lvl === 1 }"
                :style="labelStyle(event)"
                type="button"
                :data-event="event.id"
                :title="`${labelStamp(event)} ${event.title}`"
                @click.stop="pick(event.id)"
              >
                <b>{{ labelStamp(event) }}</b><span>{{ event.title }}</span>
              </button>
            </template>

            <div
              class="axis__band"
              :style="bandStyle(lane.id)"
              @wheel.prevent.stop="onAxisWheel"
              @pointermove="onAxisMove"
              @pointerleave="clearHover"
            ></div>
          </div>
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
      </div>
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
              <span class="search__lane">{{ laneName(item.lane) }}</span>
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
        title="对数基准：始终取基准线选中的日期，越靠近基准线越舒展；拖动基准线选点，或直接输入日期"
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
