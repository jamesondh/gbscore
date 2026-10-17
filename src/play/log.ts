import type { Tick } from './player.ts';

const NAMES: Record<number, string> = {};
[
  [0xff10, 'NR10', 'NR11', 'NR12', 'NR13', 'NR14'],
  [0xff16, 'NR21', 'NR22', 'NR23', 'NR24'],
  [0xff1a, 'NR30', 'NR31', 'NR32', 'NR33', 'NR34'],
  [0xff20, 'NR41', 'NR42', 'NR43', 'NR44', 'NR50', 'NR51', 'NR52'],
].forEach(([base, ...names]) => names.forEach((n, i) => (NAMES[(base as number) + i] = n as string)));

const hex = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');

export function formatWrites(writes: [number, number][]): string {
  return writes.map(([addr, value]) => `${NAMES[addr] ?? hex(addr >> 8) + hex(addr & 0xff)}=${hex(value)}`).join(' ');
}

/** One line per tick that wrote to the sound registers or changed the wave: the tick's number, the driver's
 * order:row.tick, and the writes in the order the driver made them. */
export function formatLog(startWrites: [number, number][], ticks: Tick[]): string {
  const lines = [`start ${formatWrites(startWrites)}`];
  let wave = -1;
  ticks.forEach((t, i) => {
    const parts = [];
    if (t.writes.length) parts.push(formatWrites(t.writes));
    if (t.wave !== wave) parts.push(`wave ${t.wave}`);
    wave = t.wave;
    if (parts.length) lines.push(`${i} ${t.order}:${t.row}.${t.tick} ${parts.join(' ')}`);
  });
  return lines.join('\n') + '\n';
}
