import type { Side } from "../data/events";
import { EVENTS } from "../data/events";

export interface Lane {
  id: Side;
  label: string;
  short: string;
}

export const LANES: Lane[] = [
  { id: "uk", label: "英国", short: "UK" },
  { id: "us", label: "美国", short: "US" },
];

const years = EVENTS.map((event) => event.y);

/** 由数据推导的年份范围，两端留白后对齐到十年 */
export const YEAR_MIN = Math.floor((Math.min(...years) - 15) / 10) * 10;
export const YEAR_MAX = Math.ceil((Math.max(...years) + 6) / 10) * 10;

export const TAGS: string[] = [...new Set(EVENTS.map((event) => event.tag))];

export const laneOf = (event: { s?: Side }): Side => event.s ?? "us";

export const laneLabel = (side: Side): string =>
  LANES.find((lane) => lane.id === side)?.label ?? side;

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** 选取一个刻度间隔，使相邻刻度至少相隔 minGap 像素 */
export const tickStep = (pxPerYear: number, minGap = 64): number =>
  [10, 20, 25, 50, 100, 200].find((step) => step * pxPerYear >= minGap) ?? 250;

export const ticksBetween = (pxPerYear: number, minGap = 64): number[] => {
  const step = tickStep(pxPerYear, minGap);
  const out: number[] = [];
  for (let year = Math.ceil(YEAR_MIN / step) * step; year <= YEAR_MAX; year += step) {
    out.push(year);
  }
  return out;
};
