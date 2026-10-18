import type { DriverSong } from '../../core/driver.ts';

export interface RenderRequest {
  song: DriverSong;
  timeline: { length: number; loop: number };
}

export type RenderResult = { wav: Uint8Array; seconds: number; error?: undefined } | { error: string };

/** A song played once through on the emulator, as a 16-bit stereo WAV at 44.1 kHz: the same bytes as `gbscore
 * render` writes. Each call has a worker of its own. */
export function renderWav(request: RenderRequest): Promise<{ wav: Uint8Array; seconds: number }> {
  const worker = new Worker(new URL('./render-worker.ts', import.meta.url), { type: 'module' });
  return new Promise<{ wav: Uint8Array; seconds: number }>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<RenderResult>) => {
      if (e.data.error === undefined) resolve(e.data);
      else reject(new Error(e.data.error));
    };
    worker.onerror = (e) => reject(new Error(e.message || "the render worker didn't start"));
    worker.postMessage(request);
  }).finally(() => worker.terminate());
}
