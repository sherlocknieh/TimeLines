import type { Side } from "./data/events";

export interface TimelineItem {
  id: number;
  side: Side;
  year: number;
  tag: string;
  title: string;
  desc: string;
  /** 真实年份对应的轴线坐标 */
  anchor: number;
  /** 折叠状态下的气泡高度 */
  height: number;
  /** 避让后的顶部坐标（相对舞台） */
  top: number;
  /** 气泡相对锚点的偏移 */
  dy: number;
  /** 展开状态下的顶部坐标（相对舞台） */
  openTop: number;
  peerId: number | null;
}
