import type { DriverSong, Walk } from '../src/core/driver.ts';

/** Ticks each played row lasts on the patched driver (Fxx sets all four groove steps, and the groove steps by the
 * row's place in its pattern), through the song and once more from the loop, since tempo changes carry over. */
export function expectedTicks(s: DriverSong, w: Walk): number[] {
  let groove = [...s.groove];
  const out: number[] = [];
  const pass = (from: number) => {
    for (let t = from; t < w.rows.length; t++) {
      const { order, row } = w.rows[t]!;
      for (const o of s.orders) {
        const c = s.patterns[o[order]!]![row]!;
        if (c.code === 0xf) groove = [c.param, c.param, c.param, c.param];
      }
      out.push(groove[row & 3]!);
    }
  };
  pass(0);
  pass(w.loop);
  return out;
}
