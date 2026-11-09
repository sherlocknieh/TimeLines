export interface LabelBox {
  anchor: number;
  height: number;
  level: 1 | 2 | 3;
}

/**
 * 同一侧标签的遮挡筛选：标签保持在真实日期的锚点上，互不遮挡的全部显示；
 * 发生遮挡时优先保留级别高的事件，同级保留较早者。
 * 返回与输入顺序一致的可见标记。
 */
export function pickVisible(items: readonly LabelBox[]): boolean[] {
  const keep = new Array<boolean>(items.length).fill(false);
  const order = items
    .map((_, index) => index)
    .sort(
      (a, b) =>
        items[a].level - items[b].level || items[a].anchor - items[b].anchor,
    );

  const kept: number[] = [];
  for (const index of order) {
    const box = items[index];
    const collides = kept.some(
      (other) =>
        Math.abs(items[other].anchor - box.anchor) <
        (items[other].height + box.height) / 2,
    );
    if (collides) continue;
    keep[index] = true;
    kept.push(index);
  }

  return keep;
}
