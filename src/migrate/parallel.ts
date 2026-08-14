/**
 * 決まった数だけ並行して走らせる。
 *
 * 移行は2,000枚を超える相手に対して、取得・投入・照合をそれぞれ1回ずつ行う。順番に
 * 回すと1件あたりの往復がそのまま総時間になり、全部並べると手元の回線と旧ホストの
 * 両方を叩きすぎる。**律速を手元に置いたまま、待ち時間だけを重ねる**のがちょうどいい
 * （design.md 決定7）。
 *
 * 結果は入力と同じ並びで返す。台帳の行と結果を突き合わせる側が、並びの入れ替わりを
 * 気にせずに済むようにする。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index] as T, index)
    }
  })

  await Promise.all(workers)
  return results
}
