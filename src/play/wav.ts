import { DcFilter } from './dc.ts';

/** A 16-bit stereo WAV file from the emulator's unsigned 8-bit samples, through the same DC filter as the app. */
export function encodeWav(audio: Uint8Array, sampleRate: number): Uint8Array {
  const frames = audio.length / 2;
  const out = new Uint8Array(44 + frames * 4);
  const view = new DataView(out.buffer);
  const text = (at: number, s: string) => [...s].forEach((c, i) => (out[at + i] = c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + frames * 4, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, frames * 4, true);

  for (let ch = 0; ch < 2; ch++) {
    const dc = new DcFilter(sampleRate);
    for (let i = 0; i < frames; i++) {
      const y = dc.next(audio[i * 2 + ch]!);
      view.setInt16(44 + i * 4 + ch * 2, Math.max(-32768, Math.min(32767, Math.round(y * 32767))), true);
    }
  }
  return out;
}
