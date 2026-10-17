import { existsSync, readFileSync } from 'node:fs';
import { Wasm } from '../play/emulator.ts';
import type { PlayerAssets } from '../play/player.ts';

/** The emulator and player ROM from the repository: two levels up from src/cli/, one up from the dist/ bundle. */
export async function loadAssets(): Promise<PlayerAssets> {
  const root = ['../../', '../']
    .map((up) => new URL(up, import.meta.url))
    .find((dir) => existsSync(new URL('driver/player.gbc', dir)));
  if (!root) throw new Error("can't find driver/player.gbc next to the gbscore command");
  const file = (path: string) => readFileSync(new URL(path, root));
  return {
    wasm: await Wasm.load(file('emu/binjgb.wasm')),
    rom: file('driver/player.gbc'),
    symbols: file('driver/player.sym').toString('utf8'),
  };
}
