import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSong } from '../src/core/compile.ts';
import type { Song } from '../src/core/schema.ts';
import { readShare, shareLink } from '../src/app/share.ts';

// Share links (docs/editor/, "Share links"): the song, compressed, in the address's fragment.

const demo = parseSong(JSON.parse(readFileSync('src/app/demo/halt_bug.gbscore.json', 'utf8'))).song as Song;
const BASE = 'https://www.gbscore.com/';

describe('share links', () => {
  it('give back the song and its name', async () => {
    const link = await shareLink(BASE, 'halt bug & co.gbscore.json', demo);
    expect(link.startsWith(`${BASE}#v=1&`)).toBe(true);
    const shared = await readShare(new URL(link).hash);
    if (!shared || 'error' in shared) throw new Error(JSON.stringify(shared));
    expect(shared.name).toBe('halt bug & co.gbscore.json');
    expect(JSON.parse(shared.text)).toEqual(demo);
  });

  it('keep the demo song, 85 KB of JSON, to a few thousand characters', async () => {
    expect((await shareLink(BASE, 'halt_bug.gbscore.json', demo)).length).toBeLessThan(8000);
  });

  it("aren't read from an address without one", async () => {
    expect(await readShare('')).toBeUndefined();
    expect(await readShare('#somewhere')).toBeUndefined();
  });

  it('say so when cut short, garbled, or in a format the app can\'t read', async () => {
    const hash = new URL(await shareLink(BASE, 'a.gbscore.json', demo)).hash;
    expect(await readShare(hash.slice(0, hash.length / 2))).toEqual({ error: expect.stringMatching(/damaged/) });
    expect(await readShare('#v=1&song=not*base64')).toEqual({ error: expect.stringMatching(/damaged/) });
    expect(await readShare(hash.replace('v=1', 'v=2'))).toEqual({ error: expect.stringMatching(/v=2/) });
    expect(await readShare(hash.replace('v=1&', ''))).toEqual({ error: expect.stringMatching(/v=null/) });
    expect(await readShare('#v=1&name=cut&so')).toEqual({ error: expect.stringMatching(/damaged/) }); // cut before the song
    // A letter changed in the middle: the zlib checksum catches what decompresses anyway.
    const at = Math.floor(hash.length * 0.6);
    const garbled = hash.slice(0, at) + (hash[at] === 'A' ? 'B' : 'A') + hash.slice(at + 1);
    expect(await readShare(garbled)).toEqual({ error: expect.stringMatching(/damaged/) });
  });

  it("say so when what's in them isn't a song", async () => {
    const hash = new URL(await shareLink(BASE, 'a.gbscore.json', { ...demo, version: 2 } as unknown as Song)).hash;
    expect(await readShare(hash)).toEqual({ error: expect.stringMatching(/^The song in this share link can't be opened: /) });
  });
});
