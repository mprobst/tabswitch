/** `N` elements of `T`, so that tests can destructure them without undefined checks. */
export type Tuple<T, N extends number, R extends T[] = []> = number extends N
  ? T[]
  : R['length'] extends N
    ? R
    : Tuple<T, N, [...R, T]>;

/** Returns `items` typed as a tuple of `n` elements, after checking its length. */
export function asTuple<T, N extends number>(items: T[], n: N): Tuple<T, N> {
  if (items.length !== n) throw new Error(`expected ${n} items, got ${items.length}`);
  return items as Tuple<T, N>;
}
