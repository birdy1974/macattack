/** Move one item to the position occupied by another item. */
export function moveItem<T>(items: readonly T[], item: T, target: T): T[] {
  const fromIndex = items.indexOf(item);
  const targetIndex = items.indexOf(target);
  if (fromIndex < 0 || targetIndex < 0 || fromIndex === targetIndex) {
    return [...items];
  }

  const reordered = [...items];
  reordered.splice(fromIndex, 1);
  reordered.splice(targetIndex, 0, item);
  return reordered;
}
