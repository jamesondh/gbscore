import wasmUrl from '../../../emu/binjgb.wasm?url';
import romUrl from '../../../driver/player.gbc?url';
import symbolsUrl from '../../../driver/player.sym?url';
import { Wasm } from '../../play/emulator.ts';
import type { PlayerAssets } from '../../play/player.ts';

/** The emulator and player ROM, fetched from the site. */
export async function loadAssets(): Promise<PlayerAssets> {
  const get = async (url: string) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`couldn't load ${url}: ${r.status}`);
    return r;
  };
  const [wasm, rom, symbols] = await Promise.all([
    get(wasmUrl).then((r) => r.arrayBuffer()).then((b) => Wasm.load(b)),
    get(romUrl).then((r) => r.arrayBuffer()).then((b) => new Uint8Array(b)),
    get(symbolsUrl).then((r) => r.text()),
  ]);
  return { wasm, rom, symbols };
}
