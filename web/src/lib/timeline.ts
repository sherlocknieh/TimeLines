export const START = 1200;
export const END = 2030;
/** 每年对应的像素高度 */
export const K = 3.2;
export const TOP_PAD = 22;
export const BOTTOM_PAD = 60;
/** 轴线到气泡的距离（与 CSS --gap 保持一致） */
export const GAP = 22;
/** 气泡之间的最小垂直间距 */
export const VGAP = 9;

export const yOf = (year: number): number => TOP_PAD + (year - START) * K;

export const axisHeight = (END - START) * K;
export const baseStageHeight = TOP_PAD + axisHeight + BOTTOM_PAD;

export const JUMP_YEARS = [1215, 1588, 1776, 1861, 1914, 1945, 2001] as const;

export const TICKS: number[] = [];
for (let year = START + 25; year < END; year += 25) {
  if (year % 100 !== 0) TICKS.push(yOf(year));
}

export const GRID_YEARS: number[] = [];
for (let year = START; year <= 2000; year += 100) {
  GRID_YEARS.push(year);
}

export interface AnchorBox {
  anchor: number;
  height: number;
}

/**
 * 同一侧气泡的避让布局：以真实年份为锚点，重叠的事件聚成一簇后整体居中，
 * 返回与输入顺序一致的顶部坐标。保持原实现的行为，避免视觉跳动。
 */
export function avoidOverlap(items: readonly AnchorBox[]): number[] {
  const tops = new Array<number>(items.length).fill(0);
  const order = items
    .map((_, index) => index)
    .sort((a, b) => items[a].anchor - items[b].anchor);

  let cluster: number[] = [];
  let clusterBottom = -Infinity;
  let prevBottom = -Infinity;

  const flush = () => {
    if (cluster.length === 0) return;

    const total =
      cluster.reduce((sum, index) => sum + items[index].height, 0) +
      VGAP * (cluster.length - 1);
    const first = items[cluster[0]].anchor;
    const last = items[cluster[cluster.length - 1]].anchor;

    let top = (first + last) / 2 - total / 2;
    if (top < prevBottom + VGAP) top = prevBottom + VGAP;
    if (top < 0) top = 0;

    let y = top;
    for (const index of cluster) {
      tops[index] = y;
      y += items[index].height + VGAP;
    }
    prevBottom = y - VGAP;
    cluster = [];
  };

  for (const index of order) {
    const want = items[index].anchor - items[index].height / 2;
    if (cluster.length > 0 && want >= clusterBottom + VGAP) flush();
    clusterBottom =
      cluster.length === 0
        ? want + items[index].height
        : Math.max(clusterBottom, want + items[index].height);
    cluster.push(index);
  }
  flush();

  return tops;
}
