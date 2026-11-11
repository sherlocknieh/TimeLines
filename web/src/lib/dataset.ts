import tree from "../data/timelines.json";

/** 一个事件就是一条记录，字段与时间轴渲染一一对应 */
export interface TimelineEvent {
  /** 年份；区间事件取起始年 */
  y: number;
  /**
   * 起始日期，可写 YYYY、YYYY-MM 或 YYYY-MM-DD；粒度决定展示精度。
   * 缺省时按该年 7 月 1 日定位，仅显示年份。
   */
  date?: string;
  /**
   * 区间终点，粒度与 `date` 相同；与 `date` 同时出现即表示区间事件。
   * 缺省表示单点事件。
   */
  end?: string;
  /**
   * 语义层级：1 主脉、2 通史、3 细节。
   * 缩放时间轴据此决定标签字号与重叠时的保留优先级，缺省为 2。
   */
  lvl?: 1 | 2 | 3;
  /** 分类标签 */
  tag: string;
  /** 标题 */
  title: string;
  /** 描述 */
  desc: string;
}

/** 一个文件夹就是一条时间线，可以装事件，也可以装子文件夹 */
export interface TimelineFolder {
  name: string;
  /** 这条时间线覆盖的起点，写法与事件 `date` 相同，缺省取自身事件范围 */
  start?: string;
  /** 这条时间线覆盖的终点，写法与事件 `end` 相同，缺省取自身事件范围 */
  end?: string;
  events?: TimelineEvent[];
  folders?: TimelineFolder[];
}

/** 根节点只是时间线集合，本身不成轴；每条时间线都是它的一个文件夹 */
export interface TimelineTree {
  name: string;
  folders: TimelineFolder[];
}

/** 铺平后的时间线：id 是文件夹路径，depth 是嵌套层级 */
export interface Lane {
  id: string;
  label: string;
  depth: number;
  start?: string;
  end?: string;
  events: TimelineEvent[];
}

/** 文件夹路径即时间线 id，同名文件夹挂在不同父级下也互不冲突 */
function flatten(folders: TimelineFolder[], parent = "", depth = 0): Lane[] {
  return folders.flatMap((folder) => {
    const id = parent ? `${parent}/${folder.name}` : folder.name;
    return [
      {
        id,
        label: folder.name,
        depth,
        start: folder.start,
        end: folder.end,
        events: folder.events ?? [],
      },
      ...flatten(folder.folders ?? [], id, depth + 1),
    ];
  });
}

export const TIMELINE = tree as TimelineTree;

/** 时间线清单：按文件夹树深度优先铺开，视图按数量平分面板宽度 */
export const LANES: Lane[] = flatten(TIMELINE.folders);

export const LANE_IDS: string[] = LANES.map((lane) => lane.id);

/** 主题里可用的时间线配色数量，超出后循环取用 */
const LANE_COLORS = 4;

export const laneOf = (id: string): Lane | undefined =>
  LANES.find((lane) => lane.id === id);

export const laneLabel = (id: string): string => laneOf(id)?.label ?? id;

export const laneIndex = (id: string): number =>
  Math.max(0, LANE_IDS.indexOf(id));

/** 父级时间线：id 以「父/」开头，根文件夹没有父级 */
export const laneParent = (id: string): string | null => {
  const cut = id.lastIndexOf("/");
  return cut < 0 ? null : id.slice(0, cut);
};

/** 顶层时间线：一条大时间线，可以包含若干子时间线 */
export const laneRoot = (id: string): string => {
  const cut = id.indexOf("/");
  return cut < 0 ? id : id.slice(0, cut);
};

/** 时间线配色：子级沿用所属顶层时间线的颜色，同一族一眼可辨 */
export const laneColor = (id: string): string => {
  const roots = LANE_IDS.filter((other) => laneParent(other) === null);
  const index = Math.max(0, roots.indexOf(laneRoot(id)));
  return `var(--lane-${(index % LANE_COLORS) + 1})`;
};

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));
