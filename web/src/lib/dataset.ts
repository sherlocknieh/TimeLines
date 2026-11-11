import type { LaneId } from "../data/events";

export interface Lane {
  id: LaneId;
  /** 时间线名称，可在页面上直接改写 */
  label: string;
  /** 这条时间线覆盖的起点，写法与事件 `date` 相同，缺省取全部数据 */
  start?: string;
  /** 这条时间线覆盖的终点，写法与事件 `end` 相同，缺省取全部数据 */
  end?: string;
}

/** 时间线清单：增减条目即增减时间线，视图按数量平分面板宽度 */
export const LANES: Lane[] = [
  { id: "uk", label: "英国" },
  { id: "us", label: "美国" },
];

export const LANE_IDS: LaneId[] = LANES.map((lane) => lane.id);

export const laneOf = (event: { s?: LaneId }): LaneId =>
  event.s ?? LANE_IDS[0];

export const laneLabel = (id: LaneId): string =>
  LANES.find((lane) => lane.id === id)?.label ?? id;

export const laneIndex = (id: LaneId): number =>
  Math.max(0, LANE_IDS.indexOf(id));

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));
