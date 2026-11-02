import type { Side } from "../data/events";

export interface Lane {
  id: Side;
  label: string;
}

export const LANES: Lane[] = [
  { id: "uk", label: "英国" },
  { id: "us", label: "美国" },
];

export const laneOf = (event: { s?: Side }): Side => event.s ?? "us";

export const laneLabel = (side: Side): string =>
  LANES.find((lane) => lane.id === side)?.label ?? side;

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));
