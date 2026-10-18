import { render } from '../../play/render.ts';
import { encodeWav } from '../../play/wav.ts';
import { loadAssets } from './assets.ts';
import type { RenderRequest, RenderResult } from './render.ts';

// Renders one song to a WAV, as `gbscore render` does with no options, apart from the worker that plays songs, so
// playback carries on meanwhile.

self.onmessage = async (e: MessageEvent<RenderRequest>) => {
  let result: RenderResult;
  try {
    const r = render(await loadAssets(), e.data.song, e.data.timeline);
    const wav = encodeWav(r.audio, r.sampleRate);
    result = { wav, seconds: r.audio.length / 2 / r.sampleRate };
    self.postMessage(result, { transfer: [wav.buffer] });
  } catch (err) {
    result = { error: err instanceof Error ? err.message : String(err) };
    self.postMessage(result);
  }
};
