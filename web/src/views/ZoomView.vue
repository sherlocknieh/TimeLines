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

import {
  clamp,
  LANE_IDS,
  LANES,
  laneColor,
  laneLabel,
  laneParent,
  type TimelineEvent,
} from "../lib/dataset";
import { pickVisible } from "../lib/timeline";

/** 时间线 id 就是文件夹路径，如「美国/原住民」 */
type LaneId = string;

const DAY_MS = 86_400_000;
const YEAR_DAYS = 365.2425;
const TODAY = new Date();

/** 轴线与事件标签之间的横向距离 */
const AXIS_GAP = 16;
/** 轴线缩放的横向热区宽度：以轴线为中心左右各一半 */
const AXIS_BAND = 64;
/** 轴线热区的最小纵向高度，轴段被视野压扁时仍能抓到 */
const AXIS_BAND_MIN = 12;
/** 标签高度（像素）：L1 字号更大，用于遮挡判断与垂直居中 */
const LABEL_HEIGHT: Record<1 | 2 | 3, number> = { 1: 28, 2: 25, 3: 25 };
/** 画布上下留白，给最靠边的事件标签留出显示空间 */
const PLOT_PAD = 96;
/** 刻度文字气泡高度约 20px，留一点间隙即可：只要不重叠就随虚线显示 */
const MIN_TICK_LABEL_GAP = 22;
/** 标准视图里每年占用的行高：每年刚好一行 */
const YEAR_ROW = 32;
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

/** 时间线自身加上它的各级父时间线，用于把事件汇总到大时间线 */
function laneChain(lane: LaneId): LaneId[] {
  const chain = [lane];
  let parent = laneParent(lane);
  while (parent !== null) {
    chain.push(parent);
    parent = laneParent(parent);
  }
  return chain;
}

interface AxisEvent {
  id: number;
  day: number;
  year: number;
  lane: LaneId;
  lvl: 1 | 2 | 3;
  startStamp: string;
  tag: string;
  title: string;
  desc: string;
}

const events: AxisEvent[] = LANES.flatMap((lane) =>
  lane.events.map((event: TimelineEvent) => {
    const start: Stamp = event.date
      ? parseStamp(event.date)
      : { day: utcDay(event.y, 7, 1), year: event.y, precision: "year" };

    return {
      id: 0,
      day: start.day,
      year: start.year,
      lane: lane.id,
      lvl: event.lvl ?? 2,
      startStamp: stampText(start),
      tag: event.tag,
      title: event.title,
      desc: event.desc,
    };
  }),
).map((event, id) => ({ ...event, id }));

const eventDays = events.map((event) => event.day);
/** 时间线自己声明的起止也算进数据范围：区间时间线可能没有事件 */
const laneEdgeDays = LANES.flatMap((lane) => [
  lane.start ? parseLaneEdge(lane.start, "start") : null,
  lane.end ? parseLaneEdge(lane.end, "end") : null,
]).filter((day): day is number => day !== null);
/** 数据范围：历史端留一点余量，未来端止于今天 */
const DATA_MIN =
  Math.min(...eventDays, ...laneEdgeDays) - Math.round(YEAR_DAYS * 3);
const DATA_MAX = Math.max(...eventDays, ...laneEdgeDays, todayDay);
/** 线性平移/缩放的安全边界，避免拖到数据之外的空白 */
const SAFE_MIN = DATA_MIN - Math.round(YEAR_DAYS * 2500);
const SAFE_MAX = DATA_MAX + Math.round(YEAR_DAYS * 2);

/** 面板上的时间线：名称与起止都能就地修改，缺省沿用 dataset 里的配置 */
const lanes = reactive(
  LANES.map((lane) => ({
    id: lane.id,
    label: lane.label,
    depth: lane.depth,
    color: laneColor(lane.id),
    /** 有子时间线的是父轴，其余是叶子轴，轴线粗细据此区分 */
    isParent: LANES.some((other) => laneParent(other.id) === lane.id),
    start: lane.start ?? "",
    end: lane.end ?? "",
    tag: lane.tag ?? "",
    desc: lane.desc ?? "",
  })),
);

const laneConfig = (lane: LaneId) => lanes.find((item) => item.id === lane);

/** 时间线的当前名称：优先取页面上改过的名字 */
const laneName = (lane: LaneId) =>
  laneConfig(lane)?.label ?? laneLabel(lane);

/** 区间时间线：自带起止，本身就是一段区间，气泡上直接标出起止 */
const isInterval = (lane: LaneId): boolean => {
  const conf = laneConfig(lane);
  return Boolean(conf?.start && conf.end);
};

/** 区间时间线气泡上的起止：只写年份时只显示年份，与事件标签同一套写法 */
const laneStamp = (lane: LaneId): string => {
  const conf = laneConfig(lane);
  if (!conf?.start || !conf.end) return "";
  const from = parseLaneEdge(conf.start, "start");
  const to = parseLaneEdge(conf.end, "end");
  if (from === null || to === null) return `${conf.start}–${conf.end}`;
  const a = yearOf(from);
  const b = yearOf(to);
  return a === b ? String(a) : `${a}–${b}`;
};

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

/**
 * 每条时间线覆盖的日期范围：自身起止优先，其次取自身与子时间线的事件范围。
 * 区间时间线没有事件，起止就是它的全部内容。
 */
const laneDefaults = computed<Record<LaneId, { from: number; to: number }>>(() => {
  const out = byLane(() => ({ from: DATA_MAX, to: DATA_MIN }));
  const seen: Record<LaneId, boolean> = byLane(() => false);
  for (const event of events) {
    // 事件同时计入自身时间线与它的各级父时间线
    for (const lane of laneChain(event.lane)) {
      const range = out[lane];
      range.from = Math.min(range.from, event.day);
      range.to = Math.max(range.to, event.day);
      seen[lane] = true;
    }
  }
  // 时间线自己声明的起止（区间时间线只有起止）同样计入自身与各级父级
  for (const lane of LANES) {
    const from = lane.start ? parseLaneEdge(lane.start, "start") : null;
    const to = lane.end ? parseLaneEdge(lane.end, "end") : null;
    if (from === null && to === null) continue;
    for (const id of laneChain(lane.id)) {
      const range = out[id];
      if (from !== null) range.from = Math.min(range.from, from);
      if (to !== null) range.to = Math.max(range.to, to);
      seen[id] = true;
    }
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

/** 事件是否落在时间线的起止范围内 */
function inLane(lane: LaneId, event: AxisEvent): boolean {
  const { from, to } = laneBounds.value[lane];
  return event.day >= from && event.day <= to;
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
const center = ref(0);
const span = ref(1);
/** 每条轴线相对父轴的横向偏移，可分别左右拖动；根轴的偏移就是画布横坐标 */
const axisOffset = reactive<Record<LaneId, number>>(
  Object.fromEntries(LANE_IDS.map((lane) => [lane, 0])),
);
const selected = ref<number | null>(null);
const hover = ref<{ y: number; day: number; lane: LaneId } | null>(null);
const dragging = ref(false);
/** 正在编辑起止的时间线：点开的标题气泡切换成可编辑的大气泡 */
const editingLane = ref<LaneId | null>(null);
const query = ref("");
const searchOpen = ref(false);
const activeResult = ref(0);
const searchWrap = ref<HTMLElement | null>(null);

/** 画布右侧留给最右一条时间线标签的宽度 */
const LABEL_GUTTER = 190;
/** 标签在相邻轴该高度没有标签时，可以借用的额外宽度 */
const LABEL_BORROW = 130;

/**
 * 根轴默认位置：顶层时间线在可用宽度内均匀铺开。
 * 子轴的初始偏移为 0，与父轴同列，之后可以单独拖开。
 */
function defaultRoots(): Record<LaneId, number> {
  const roots = LANE_IDS.filter((lane) => laneParent(lane) === null);
  const usable = Math.max(1, width.value - LABEL_GUTTER);
  const step = usable / Math.max(1, roots.length);
  return Object.fromEntries(
    roots.map((lane, index) => [lane, step * (index + 0.5)]),
  );
}

/** 每条轴的初始偏移：根轴取铺开位置，子轴相对父轴为 0 */
const offsetDefault = (lane: LaneId): number =>
  laneParent(lane) === null
    ? (defaultRoots()[lane] ?? width.value / 2)
    : 0;

/** 画布整体的横向平移：拖动空白处时整棵轴线树一起左右移动 */
const panX = ref(0);

/**
 * 轴线的画布横坐标：根轴取画布平移量加自己的偏移，子轴沿父级链累加。
 * LANES 是深度优先的先序序列，父轴总排在子轴之前，可以一趟算完。
 */
const axisAbs = computed<Record<LaneId, number>>(() => {
  const out: Record<LaneId, number> = {};
  for (const { id } of LANES) {
    const parent = laneParent(id);
    out[id] =
      (parent === null ? panX.value : (out[parent] ?? 0)) + axisOffset[id];
  }
  return out;
});

/** 轴线在画布上的横坐标 */
const axisAt = (lane: LaneId): number => axisAbs.value[lane] ?? 0;

/**
 * 标签统一排在轴线右侧：每条轴的标签只用到下一条轴之前的空隙，
 * 下一条轴的标签从它自己的轴线之后开始，因此互不侵占。
 * 最右一条轴的标签空间由布局预留的右侧留白提供。
 */
const labelSide = (_lane: LaneId): "left" | "right" => "right";

/** 轴线可移动的左右边界，保证标签与时间读数都还有落脚处 */
const axisMargin = computed(() =>
  Math.min(120, Math.max(40, width.value * 0.04)),
);

/** 绘图区高度：整块画布都用于绘制 */
const plotArea = computed(() => Math.max(1, height.value));

/** 绘图区上下留白：面板变矮时同步收窄，避免留白吃掉可视高度 */
const plotPad = computed(() => Math.min(PLOT_PAD, plotArea.value * 0.18));

const plotHeight = computed(() =>
  Math.max(1, plotArea.value - plotPad.value * 2),
);

/** 纵向映射在整块画布里统一进行，所有时间线共用；历史在上、今天在下 */
const yOfDay = (day: number) =>
  plotPad.value +
  ((day - center.value + span.value / 2) / span.value) * plotHeight.value;

const dayOfY = (y: number) =>
  center.value + ((y - plotPad.value) / plotHeight.value - 0.5) * span.value;

/**
 * 纵向坐标的绘制边界：画布上下各留一屏，越界部分由 .axis 的 overflow 裁掉。
 * 放大到极深时日期换算出的像素会到上千万，超过浏览器图层上限后元素不再绘制；
 * 先收到边界内，元素的可见部分与原来一致。
 */
const clipYValue = (y: number): number =>
  clamp(y, -plotArea.value, plotArea.value * 2);

/** 把一段纵向跨度夹到绘制边界内 */
function clipY(a: number, b: number): { top: number; height: number } {
  const top = clipYValue(Math.min(a, b));
  const bottom = clipYValue(Math.max(a, b));
  return { top, height: Math.max(0, bottom - top) };
}

const dayStart = computed(() => center.value - span.value / 2);
const dayEnd = computed(() => center.value + span.value / 2);
const visibleDays = computed(() => Math.max(1, dayEnd.value - dayStart.value));

const minSpan = 2;
const maxSpan = (DATA_MAX - DATA_MIN) * 2.5;

function clampView() {
  span.value = clamp(span.value, minSpan, maxSpan);

  const half = span.value / 2;
  if (span.value >= SAFE_MAX - SAFE_MIN) {
    center.value = (SAFE_MIN + SAFE_MAX) / 2;
  } else {
    center.value = clamp(center.value, SAFE_MIN + half, SAFE_MAX - half);
  }
}

/**
 * 一条轴连同它整棵子树的相对偏移范围：拖父轴时以整个子树为边界，
 * 子轴的偏移保持原样，不会被边界悄悄改写。
 */
function subtreeSpan(lane: LaneId, base = 0): { min: number; max: number } {
  let min = base;
  let max = base;
  for (const child of LANES.filter((item) => laneParent(item.id) === lane)) {
    const next = base + axisOffset[child.id];
    const inner = subtreeSpan(child.id, next);
    min = Math.min(min, inner.min);
    max = Math.max(max, inner.max);
  }
  return { min, max };
}

/** 轴的偏移只受画布边界约束：整棵子树都留在边界内 */
function clampAxis(lane: LaneId) {
  const parent = laneParent(lane);
  const base = parent === null ? panX.value : axisAt(parent);
  const { min, max } = subtreeSpan(lane);
  const low = axisMargin.value - base - min;
  const high = Math.max(low, width.value - axisMargin.value - base - max);
  axisOffset[lane] = clamp(axisOffset[lane], low, high);
}

/** 画布平移的边界：至少让最左或最右一条轴线留在画布内 */
function clampPan() {
  const xs = LANE_IDS.map(axisAt);
  const min = Math.min(...xs);
  const max = Math.max(...xs);
  const margin = axisMargin.value;
  if (max < margin) panX.value += margin - max;
  else if (min > width.value - margin) panX.value += width.value - margin - min;
}

function fitAll() {
  // 全览只调整视野
  const low = DATA_MIN;
  const high = DATA_MAX;
  span.value = Math.max(minSpan, high - low);
  center.value = (low + high) / 2;
  // 全览同时把所有轴线放回初始偏移：根轴铺开，子轴回到父轴上
  panX.value = 0;
  for (const lane of LANE_IDS) axisOffset[lane] = offsetDefault(lane);
  selected.value = null;
  clampView();
}

/** 标准视图：每年固定占一行，顶端对齐到整数年，纵横都对得上刻度 */
function standardView() {
  span.value = clamp((plotHeight.value / YEAR_ROW) * YEAR_DAYS, minSpan, maxSpan);
  const half = span.value / 2;
  // 顶端年取当前视野所在年，并把结果夹在可停放范围内，重复点击不再漂移
  const low = Math.ceil(yearOf(SAFE_MIN) + 1);
  const high = Math.floor(yearOf(SAFE_MAX) - 1);
  const topYear = clamp(Math.round(yearOf(center.value - half)), low, high);
  center.value = utcDay(topYear) + half;
  selected.value = null;
  clampView();
}

/** 时间线自身区段在当前分布下的跨度，用来判断它是否已经铺满画布 */
function laneSpan(lane: LaneId): number {
  const { from, to } = laneBounds.value[lane];
  return Math.abs(to - from);
}

/** 全览判定留出的像素容差：区段铺满画布后差几像素也算已到全览 */
const LANE_FIT_SLACK = 4;

/** 这条时间线是否已经放大到全览：它的区段已经铺满画布高度 */
const laneFitted = (lane: LaneId): boolean =>
  (laneSpan(lane) / span.value) * plotHeight.value >=
  plotHeight.value - LANE_FIT_SLACK;

function fitLane(lane: LaneId) {
  const { from, to } = laneBounds.value[lane];
  span.value = Math.max(minSpan, Math.abs(to - from));
  center.value = (from + to) / 2;
  selected.value = null;
  clampView();
}

/**
 * 双击轴段逐级放大：子轴默认与父轴同列、热区互相重叠，
 * 因此先放大命中的最外层时间线，它已经铺满画布时才落到下一层子轴。
 */
function onCanvasDblClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null;
  if (target?.closest("button, a, input, label, .lane-node")) {
    return;
  }
  // LANES 是先序序列，父轴总排在子轴之前
  const hits = LANES.map((item) => item.id).filter((id) =>
    inAxisBand(id, event.clientX, event.clientY),
  );
  if (hits.length === 0) return;
  // 父轴区段包含子轴，命中列表的跨度天然由大到小：
  // 先放大还没到全览的最外层时间线，父轴已经铺满时才落到下一层子轴；
  // 命中的轴都已铺满时停在最深的子轴，重复双击不再改变视野
  const next = hits.find((id) => !laneFitted(id)) ?? hits[hits.length - 1];
  fitLane(next);
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
    Math.abs(axisAt(lane) - x) < Math.abs(axisAt(best) - x) ? lane : best,
  );
}

/** 把视口坐标换算成画布内的纵向坐标 */
function localY(clientY: number): number {
  const rect = viewport.value?.getBoundingClientRect();
  return clientY - (rect?.top ?? 0);
}

function zoomAt(factor: number, y: number) {
  const next = clamp(span.value / factor, minSpan, maxSpan);
  const ratio = (y - plotPad.value) / plotHeight.value;
  // 锚点日期保持不动
  const anchorDay = dayOfY(y);
  center.value = anchorDay - (ratio - 0.5) * next;
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
  const shift = (event.deltaY * scaleBy * span.value) / plotHeight.value;

  center.value += shift;
  clampView();
}

/** 只把视野移到指定日期 */
function centerOn(day: number) {
  center.value = day;
  clampView();
  selected.value = null;
}

let drag: {
  x: number;
  y: number;
  top: number;
  center: number;
  span: number;
  lane: LaneId;
  /** 手势开始时那条轴的偏移，拖动按起点偏移累加 */
  offset: number;
  /** 手势开始时画布的整体平移量 */
  pan: number;
  /** 手势是否起于轴线热区：只有轴上横向拖动才移动轴线 */
  canAxis: boolean;
  /** 手势是否起于标题气泡：气泡只用来拖轴，纵向拖动不改时间 */
  fromNode: boolean;
  mode: "axis" | "pan" | "time" | "none" | null;
} | null = null;
let moved = false;

function onPointerMove(event: PointerEvent) {
  if (!drag) return;

  const dx = event.clientX - drag.x;
  const dy = event.clientY - drag.y;

  if (drag.mode === null && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
    // 横向手势在轴段热区或标题气泡上拖轴，其余横向手势平移整块画布
    if (Math.abs(dx) > Math.abs(dy)) {
      drag.mode = drag.canAxis ? "axis" : "pan";
    }
    // 起于气泡的纵向手势不做任何事，避免拖标题时误平移时间
    else drag.mode = drag.fromNode ? "none" : "time";
  }
  if (drag.mode === null || drag.mode === "none") return;

  moved = true;
  if (drag.mode === "axis") {
    // 只改指针所在那条轴的偏移：子轴移动时它自己的子轴跟着走，父轴不动
    axisOffset[drag.lane] = drag.offset + dx;
    clampAxis(drag.lane);
  } else if (drag.mode === "pan") {
    // 平移整块画布：所有轴线一起左右移动，相对位置不变
    panX.value = drag.pan + dx;
    clampPan();
  } else {
    // 平移时间：只移动视野
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
  // 每次重新按下都是一次新手势，避免上一次拖拽的 moved 标记吞掉气泡点击
  moved = false;
  const target = event.target as HTMLElement | null;
  if (target?.closest("button, a, input, label, .lane-node")) return;
  // 指针落在哪条时间线上，就只拖动那条线的轴线
  const lane = laneAt(target, event.clientX, event.clientY);

  selected.value = null;
  drag = {
    x: event.clientX,
    y: event.clientY,
    top: viewport.value?.getBoundingClientRect().top ?? 0,
    center: center.value,
    span: span.value,
    lane,
    offset: axisOffset[lane],
    pan: panX.value,
    // 轴线只在自身区段内可拖，其余位置横拖平移整块画布
    canAxis: inAxisBand(lane, event.clientX, event.clientY),
    fromNode: false,
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

/**
 * 标题气泡按住即拖动轴线：直接进入 axis 手势，不必先落在轴段热区。
 * 没有拖动时 click 才打开起止编辑，因此拖动过程不会误触展开。
 */
function onNodePointerDown(lane: LaneId, event: PointerEvent) {
  if (event.button !== 0) return;
  moved = false;
  dragging.value = true;
  drag = {
    x: event.clientX,
    y: event.clientY,
    top: viewport.value?.getBoundingClientRect().top ?? 0,
    center: center.value,
    span: span.value,
    lane,
    offset: axisOffset[lane],
    pan: panX.value,
    canAxis: true,
    fromNode: true,
    // 与画布手势一致：超过阈值才判定为拖动，避免抖动吞掉点击
    mode: null,
  };
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
}

/** 点击气泡展开成大气泡，用来编辑名称与起止 */
async function onNodeActivate(lane: LaneId) {
  if (moved) return;
  editingLane.value = lane;
  await nextTick();
  viewport.value
    ?.querySelector<HTMLInputElement>(".lane-node.is-open .lane-node__edge")
    ?.focus({ preventScroll: true });
}

function closeCard() {
  selected.value = null;
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  // Esc 先收起展开的起止编辑，再收起事件卡片
  if (editingLane.value !== null) editingLane.value = null;
  else closeCard();
}

/** 点画布空白处收起展开的起止编辑 */
function onGlobalPointerDown(event: PointerEvent) {
  const target = event.target as HTMLElement | null;
  if (editingLane.value !== null && !target?.closest(".lane-node")) {
    editingLane.value = null;
  }
  if (!searchOpen.value) return;
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
    // 每 26px 至少一个年份刻度：标准视图每年一行时正好逐年标注
    const rawStep = (spanYears * 26) / px;
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
    const y = yOfDay(tick.day);
    // 虚线全部保留，只对重叠文字做筛选
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
      const x1 = axisAt(lane);
      const x2 = x1 + (labelSide(lane) === "left" ? -AXIS_GAP : AXIS_GAP);
      for (const event of placed.value[lane]) {
        out[lane].push({ id: event.id, y: clipYValue(event.anchor), x1, x2 });
      }
    }

    return out;
  },
);

/** 统一绘图区里的连线：所有时间线的坐标已经落在同一套画布坐标系 */
const allLinks = computed(() =>
  LANE_IDS.flatMap((lane) =>
    links.value[lane].map((link) => ({ ...link, lane })),
  ),
);

/** 父轴到子轴的横向连接：从父轴起点画到子轴起点，标出包含关系 */
const branches = computed(() => {
  const out: { id: string; x1: number; x2: number; y: number }[] = [];
  for (const lane of LANES) {
    const parent = laneParent(lane.id);
    if (parent === null) continue;
    out.push({
      id: lane.id,
      x1: axisAt(parent),
      x2: axisAt(lane.id),
      y: clipYValue(yOfDay(laneBounds.value[lane.id].from)),
    });
  }
  return out;
});

/** 每条时间线的事件总数：父时间线把子时间线的事件一并计入 */
const totals = computed<Record<LaneId, number>>(() => {
  const out = byLane(() => 0);
  for (const event of events) {
    if (!inLane(event.lane, event)) continue;
    for (const lane of laneChain(event.lane)) out[lane] += 1;
  }
  return out;
});

/** 气泡与轴线之间的横向距离，和事件标签一致，留给连接线 */
const NODE_OFFSET = AXIS_GAP;

/** 气泡的估算高度（收起 / 展开）、估算宽度与错开间距，只用于判断气泡是否叠在一起 */
const NODE_HEIGHT = 30;
const NODE_OPEN_HEIGHT = 48;
const NODE_WIDTH_ESTIMATE = 130;
/** 展开态气泡的宽度：要放下起止输入与说明文字 */
const NODE_OPEN_WIDTH = 260;

/** 气泡当前估算高度：展开态多了起止输入那一行 */
const nodeHeight = (lane: LaneId): number =>
  editingLane.value === lane ? NODE_OPEN_HEIGHT : NODE_HEIGHT;

/** 气泡实测宽度：避让按真实宽度算，气泡之间与气泡到轴线保持同一距离 */
const nodeWidths = reactive<Record<LaneId, number>>({});
const nodeEls = new Map<LaneId, HTMLElement>();
const nodeLaneOf = new WeakMap<HTMLElement, LaneId>();
let nodeObserver: ResizeObserver | undefined;

const nodeWidth = (lane: LaneId): number =>
  nodeWidths[lane] || NODE_WIDTH_ESTIMATE;

/** 记录气泡元素并跟随其尺寸变化，改名或展开时宽度会变 */
function setNodeEl(lane: LaneId, el: unknown) {
  const next = el instanceof HTMLElement ? el : null;
  const prev = nodeEls.get(lane);
  if (prev === next) return;
  if (prev) nodeObserver?.unobserve(prev);
  if (!next) {
    nodeEls.delete(lane);
    return;
  }
  nodeEls.set(lane, next);
  nodeLaneOf.set(next, lane);
  nodeWidths[lane] = next.offsetWidth;
  nodeObserver ??= new ResizeObserver((entries) => {
    for (const entry of entries) {
      const target = entry.target as HTMLElement;
      const id = nodeLaneOf.get(target);
      if (id) nodeWidths[id] = target.offsetWidth;
    }
  });
  nodeObserver.observe(next);
}

/** 气泡的右边缘：贴在自己轴线左侧 */
const nodeRight = (lane: LaneId): number => axisAt(lane) - NODE_OFFSET;

/** 左侧相邻轴线的横坐标，没有则取画布左缘 */
function prevAxisX(lane: LaneId): number {
  const x = axisAt(lane);
  const prev = LANE_IDS.map((id) => axisAt(id))
    .filter((value) => value < x - 1)
    .sort((a, b) => b - a)[0];
  return prev ?? 0;
}

/**
 * 气泡的锚点：普通时间线骑在起始端上；区间时间线骑在区间中央，
 * 名字因此落在它那段区间的中间，读作「父轴上被标出的那一段」。
 */
const nodeAnchorY = (lane: LaneId): number => {
  const { from, to } = laneBounds.value[lane];
  return yOfDay(isInterval(lane) ? (from + to) / 2 : from);
};

/**
 * 气泡的遮挡筛选：气泡始终贴在自己轴线左侧、骑在锚点上，不做位移。
 * 同列气泡纵向挨得太近时只保留一个：父级优先于子级，同级保留锚点较早者。
 * 放大后重叠消失，名字自然全部回来。
 */
const nodeVisible = computed<Record<LaneId, boolean>>(() => {
  const out: Record<LaneId, boolean> = {};
  const columns = new Map<number, LaneId[]>();
  for (const { id } of LANES) {
    const x = Math.round(axisAt(id));
    columns.set(x, [...(columns.get(x) ?? []), id]);
  }
  const depthOf = (id: LaneId): number => laneConfig(id)?.depth ?? 0;
  for (const ids of columns.values()) {
    const order = [...ids].sort(
      (a, b) => depthOf(a) - depthOf(b) || nodeAnchorY(a) - nodeAnchorY(b),
    );
    const kept: { y: number; h: number }[] = [];
    for (const id of order) {
      const y = nodeAnchorY(id);
      const h = nodeHeight(id);
      const clash = kept.some((other) => Math.abs(other.y - y) < (other.h + h) / 2);
      out[id] = !clash;
      if (!clash) kept.push({ y, h });
    }
  }
  return out;
});

/** 气泡在画布上的纵向中心：骑在锚点上，随轴线一起滚出画布，越界部分交给裁剪 */
function nodeCenterY(lane: LaneId): number {
  return clipYValue(nodeAnchorY(lane));
}

/** 气泡右边缘的画布横坐标：跟着轴线走，移出画布时交给裁剪 */
const nodeRightX = (lane: LaneId): number => nodeRight(lane);

/** 气泡可用的横向空间：从本轴向左一直用到相邻轴线或画布边缘 */
function nodeRoom(lane: LaneId): number {
  return axisAt(lane) - prevAxisX(lane) - AXIS_GAP - 4;
}

/**
 * 标题气泡垂直居中骑在起始端上，宽度不越过左侧相邻轴线：
 * 每条时间线各占一列，气泡因此不会压到别的时间线上。
 */
function nodeStyle(lane: LaneId): Record<string, string> {
  // 展开态是编辑面板，要放下起止输入与说明：轴线左侧放不下就改到右侧，
  // 面板因此不会压住轴线，也不会被挤成一条竖线
  if (editingLane.value === lane) {
    const room = Math.min(NODE_OPEN_WIDTH, width.value - 2 * AXIS_GAP);
    if (nodeRoom(lane) >= room) {
      return {
        right: `${width.value - nodeRightX(lane)}px`,
        top: `${nodeCenterY(lane)}px`,
        width: `${room}px`,
      };
    }
    const left = Math.min(axisAt(lane) + AXIS_GAP, width.value - room - AXIS_GAP);
    return {
      left: `${Math.max(AXIS_GAP, left)}px`,
      top: `${nodeCenterY(lane)}px`,
      width: `${room}px`,
    };
  }
  return {
    right: `${width.value - nodeRightX(lane)}px`,
    top: `${nodeCenterY(lane)}px`,
    maxWidth: `${Math.max(80, nodeRoom(lane))}px`,
  };
}

/** 标题气泡与轴线的连接线：与事件标签的连线同一种画法，展开态改到轴线右侧 */
const nodeLinks = computed(() =>
  LANES.map(({ id }) => {
    const open = editingLane.value === id && nodeRoom(id) < NODE_OPEN_WIDTH;
    const x = axisAt(id);
    return {
      id,
      x1: open ? x + AXIS_GAP : nodeRightX(id),
      x2: x,
      y1: nodeCenterY(id),
      y2: nodeCenterY(id),
    };
  }),
);

/** 轴线热区的纵向范围：与轴线等长，只覆盖这条时间线的起止区段 */
function axisBand(lane: LaneId): { top: number; height: number } {
  const { from, to } = laneBounds.value[lane];
  const a = yOfDay(from);
  const b = yOfDay(to);
  const span = Math.abs(b - a);
  // 轴段被视野压得比最小热区还短时，围绕轴段中心向外补足
  const height = Math.max(AXIS_BAND_MIN, span);
  const top = Math.min(a, b) - (height - span) / 2;
  return clipY(top, top + height);
}

/** 指针是否落在某条轴线的热区内：横向贴轴、纵向落在轴段上 */
function inAxisBand(lane: LaneId, clientX: number, clientY: number): boolean {
  const rect = viewport.value?.getBoundingClientRect();
  if (!rect) return false;
  const { top, height } = axisBand(lane);
  const y = clientY - rect.top;
  return (
    Math.abs(clientX - rect.left - axisAt(lane)) <= AXIS_BAND / 2 &&
    y >= top &&
    y <= top + height
  );
}

/** 轴线只画在时间线的起止范围内，两端实心结束 */
function spineStyle(lane: LaneId) {
  const { from, to } = laneBounds.value[lane];
  const { top, height } = clipY(yOfDay(from), yOfDay(to));
  return {
    left: `${axisAt(lane)}px`,
    top: `${top}px`,
    height: `${height}px`,
  };
}

/** 缩放热区与轴线等长，滚轮只在轴段上生效 */
function bandStyle(lane: LaneId) {
  const { top, height } = axisBand(lane);
  return {
    left: `${axisAt(lane) - AXIS_BAND / 2}px`,
    top: `${top}px`,
    height: `${height}px`,
  };
}

/** 右侧相邻轴线的横坐标，没有则取画布边缘 */
function nextAxisX(lane: LaneId): number {
  const x = axisAt(lane);
  const next = LANE_IDS.map((id) => axisAt(id))
    .filter((value) => value > x + 1)
    .sort((a, b) => a - b)[0];
  return next ?? width.value;
}

/** 标签可用的横向空间：从本轴一直用到相邻轴线或画布边缘 */
function labelRoom(lane: LaneId): number {
  return nextAxisX(lane) - axisAt(lane) - AXIS_GAP - 4;
}

/**
 * 标签实际可用的宽度：相邻轴在该高度没有标签时，可以越过它继续向右延伸，
 * 直到再下一条轴为止。密集处仍按原宽度省略，稀疏处则能显示完整标题。
 */
function labelWidth(event: Placed): number {
  const base = labelRoom(event.lane);
  const next = nextAxisX(event.lane);
  const nextLane = LANE_IDS.find((id) => Math.abs(axisAt(id) - next) < 1);
  if (nextLane === undefined) return base;

  const blocked = placed.value[nextLane].some(
    (other) => Math.abs(other.anchor - event.anchor) < LABEL_HEIGHT[other.lvl] + 4,
  );
  if (blocked) return base;

  const after = nextAxisX(nextLane);
  return Math.max(base, Math.min(after - axisAt(event.lane) - AXIS_GAP - 4, base + LABEL_BORROW));
}

/** 标签与卡片都只写书写粒度内的日期，不补月份与日 */
const labelStamp = (event: AxisEvent) => event.startStamp;

/** 搜索结果：事件与区间时间线都能被搜到，区间时间线定位到它自己的起止 */
interface SearchHit {
  key: string;
  day: number;
  stamp: string;
  title: string;
  lane: LaneId;
  event?: AxisEvent;
}

const results = computed<SearchHit[]>(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return [];
  const hits: SearchHit[] = events
    // 已被时间线起止裁掉的事件搜不到，避免定位到一个不会出现的气泡
    .filter((event) => inLane(event.lane, event))
    .filter((event) =>
      [
        event.title,
        event.tag,
        event.desc,
        laneName(event.lane),
        labelStamp(event),
      ].some((field) => field.toLowerCase().includes(q)),
    )
    .map((event) => ({
      key: `event-${event.id}`,
      day: event.day,
      stamp: labelStamp(event),
      title: event.title,
      lane: event.lane,
      event,
    }));

  // 区间时间线本身就是一段区间，按名称、起止与说明参与搜索
  for (const lane of lanes) {
    if (!isInterval(lane.id)) continue;
    const { from } = laneBounds.value[lane.id];
    if (
      ![lane.label, lane.tag, lane.desc, laneStamp(lane.id)].some((field) =>
        field.toLowerCase().includes(q),
      )
    ) {
      continue;
    }
    hits.push({
      key: `lane-${lane.id}`,
      day: from,
      stamp: laneStamp(lane.id),
      title: lane.label,
      lane: lane.id,
    });
  }

  return hits.sort((a, b) => a.day - b.day);
});

const shownResults = computed(() => results.value.slice(0, 8));
const searchVisible = computed(
  () => searchOpen.value && query.value.trim().length > 0,
);
const activeDescendant = computed(() => {
  const item = shownResults.value[activeResult.value];
  return searchVisible.value && item ? `search-option-${item.key}` : undefined;
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

/** 定位到搜索结果：事件居中并展开卡片，区间时间线铺满它自己的起止 */
function locate(hit: SearchHit) {
  searchOpen.value = false;
  if (!hit.event) {
    fitLane(hit.lane);
    editingLane.value = hit.lane;
    return;
  }
  const event = hit.event;
  const target = YEAR_DAYS * LOCATE_SPAN_YEARS[event.lvl];
  if (target > 0 && visibleDays.value > target) {
    span.value = clamp(target, minSpan, maxSpan);
  }
  centerOn(event.day);
  fromSearch = true;
  selected.value = event.id;
}

/** 卡片取代气泡出现在同一位置：排在轴线外侧，并保证整体留在画布内 */
function cardStyle(event: Placed) {
  const x = axisAt(event.lane);
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
  const x = axisAt(event.lane);
  const left = labelSide(event.lane) === "left";
  return {
    ...(left
      ? { right: `${width.value - x + AXIS_GAP}px` }
      : { left: `${x + AXIS_GAP}px` }),
    top: `${clipYValue(event.labelTop)}px`,
    maxWidth: `${Math.max(80, labelWidth(event))}px`,
  };
}

const todayY = computed(() => clipYValue(yOfDay(todayDay)));

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
  const x = axisAt(hover.value.lane);
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
  const wasDefault =
    Math.abs(panX.value) < 2 &&
    LANE_IDS.every(
      (lane) => Math.abs(axisOffset[lane] - offsetDefault(lane)) < 2,
    );
  width.value = Math.max(320, el.clientWidth);
  height.value = Math.max(120, el.clientHeight);
  // 尺寸变化后轴线仍停在初始位置时，跟着新的画布宽度重新对齐
  if (wasDefault) {
    panX.value = 0;
    for (const lane of LANE_IDS) axisOffset[lane] = offsetDefault(lane);
  }
  for (const lane of LANE_IDS) clampAxis(lane);
  clampPan();
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
  nodeObserver?.disconnect();
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
      @dblclick="onCanvasDblClick"
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
            v-for="branch in branches"
            :key="`branch-${branch.id}`"
            class="axis__branch"
            :style="{ stroke: laneColor(branch.id) }"
            :x1="branch.x1"
            :x2="branch.x2"
            :y1="branch.y"
            :y2="branch.y"
          ></line>
          <line
            v-for="node in nodeLinks"
            :key="`node-link-${node.id}`"
            class="axis__link"
            :style="{ stroke: laneColor(node.id) }"
            :x1="node.x1"
            :x2="node.x2"
            :y1="node.y1"
            :y2="node.y2"
          ></line>
          <line
            v-for="link in allLinks"
            :key="`${link.lane}-${link.id}`"
            class="axis__link"
            :style="{ stroke: laneColor(link.lane) }"
            :x1="link.x1"
            :x2="link.x2"
            :y1="link.y"
            :y2="link.y"
          ></line>
        </svg>

        <div class="axis__today" :style="{ top: `${todayY}px` }">
          <span>今天</span>
        </div>

        <template v-for="lane in lanes" :key="lane.id">
          <div
            class="lane-group"
            :class="[
              lane.isParent ? 'is-parent' : 'is-child',
              { 'is-interval': isInterval(lane.id) },
            ]"
            :style="{ '--lane': lane.color }"
            :data-lane="lane.id"
          >
            <div class="axis__spine" :style="spineStyle(lane.id)"></div>

            <div
              v-if="editingLane === lane.id || nodeVisible[lane.id] !== false"
              class="lane-node"
              :class="editingLane === lane.id ? 'is-open' : 'is-collapsed'"
              :style="nodeStyle(lane.id)"
              :ref="(el) => setNodeEl(lane.id, el)"
              @pointerdown.stop
            >
              <button
                v-if="editingLane !== lane.id"
                class="lane-node__bubble"
                type="button"
                :aria-label="`${lane.label}：拖动可移动轴线，点击可编辑起止`"
                :title="`${lane.label} · ${totals[lane.id]} 个事件（拖动移动轴线，点击编辑起止）`"
                @pointerdown="onNodePointerDown(lane.id, $event)"
                @click="onNodeActivate(lane.id)"
              >
                <b v-if="isInterval(lane.id)" class="lane-node__stamp">{{
                  laneStamp(lane.id)
                }}</b>
                <span class="lane-node__name">{{ lane.label }}</span>
                <span v-if="totals[lane.id] > 0" class="lane-node__count">{{
                  totals[lane.id]
                }}</span>
              </button>
              <template v-else-if="editingLane === lane.id">
                <div class="lane-node__head">
                  <input
                    class="lane-node__name-input"
                    :value="lane.label"
                    aria-label="时间线名称"
                    spellcheck="false"
                    @change="renameLane(lane.id, $event)"
                    @keydown.enter.prevent="commitInput"
                    @wheel.stop
                  />
                  <span class="lane-node__count">{{ totals[lane.id] }}</span>
                  <button
                    class="lane-node__done"
                    type="button"
                    aria-label="收起起止编辑"
                    title="收起"
                    @click="editingLane = null"
                  >
                    ×
                  </button>
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
                    @wheel.stop
                  />
                </div>
                <p v-if="lane.tag || lane.desc" class="lane-node__note">
                  <b v-if="lane.tag">{{ lane.tag }}</b>
                  <span v-if="lane.desc">{{ lane.desc }}</span>
                </p>
              </template>
            </div>

            <template v-for="event in placed[lane.id]" :key="event.id">
              <span
                class="axis-event__dot"
                :class="{ 'is-l1': event.lvl === 1 }"
                :style="{ left: `${axisAt(lane.id)}px`, top: `${clipYValue(event.anchor)}px` }"
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
                <p class="axis-event__meta">
                  <b>{{ labelStamp(event) }}</b> · {{ lane.label }} ·
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
              title="滚轮缩放，双击放大到这条时间线的全览"
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
          <li v-for="(item, index) in shownResults" :key="item.key">
            <button
              :id="`search-option-${item.key}`"
              class="search__result"
              :class="{ 'is-active': index === activeResult }"
              type="button"
              role="option"
              :aria-selected="index === activeResult"
              @click="locate(item)"
            >
              <b>{{ item.stamp }}</b>
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
      <button class="btn" type="button" @click="standardView">标准</button>
      <button class="btn" type="button" @click="centerOn(todayDay)">今天</button>
    </div>
  </section>
</template>
