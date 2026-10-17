import type { DriverSong } from '../core/driver.ts';
import { Playback, TICK_RATE, type PlayerAssets, type Tick } from './player.ts';

/** A render holds its audio in memory, about 10 MB a minute at 44.1 kHz, so by default it stops at an hour. */
export const MAX_SECONDS = 3600;

export class RenderTooLong extends Error {}

export interface RenderOptions {
  /** Play the song this many times: once from the start, then from the loop. Default 1. */
  loops?: number;
  /** Or play for this long instead. */
  seconds?: number;
  /** Or play this many rows. */
  rows?: number;
  /** Throw RenderTooLong rather than play past this. Default MAX_SECONDS. */
  maxSeconds?: number;
  sampleRate?: number;
}

export interface Rendering {
  audio: Uint8Array; // unsigned 8-bit stereo, interleaved
  sampleRate: number;
  ticks: Tick[];
  startWrites: [number, number][];
}

/** Plays a compiled song from the start. With `loops`, stops just before the row where the next pass would start,
 * counting `length` rows for the first pass and `length − loop` for each one after. A row starts on its tick 0, so
 * counting rows doesn't depend on the song's layout. */
export function render(
  assets: PlayerAssets,
  data: DriverSong,
  timeline: { length: number; loop: number },
  options: RenderOptions = {},
): Rendering {
  const p = new Playback(assets, data, options);
  try {
    const ticks: Tick[] = [];
    const maxSeconds = options.maxSeconds ?? MAX_SECONDS;
    const push = () => {
      if (ticks.length >= maxSeconds * TICK_RATE) throw new RenderTooLong(`renders stop at ${maxSeconds} seconds`);
      ticks.push(p.tick());
    };
    if (options.seconds !== undefined) {
      const n = Math.round(options.seconds * TICK_RATE);
      while (ticks.length < n) push();
    } else {
      const loops = options.loops ?? 1;
      const rows = options.rows ?? timeline.length + (loops - 1) * (timeline.length - timeline.loop);
      let started = 0;
      for (;;) {
        if (p.upcoming.tick === 0 && started++ === rows) break;
        push();
      }
    }
    p.finish();
    return { audio: p.takeAudio(), sampleRate: p.sampleRate, ticks, startWrites: p.startWrites };
  } finally {
    p.delete();
  }
}
