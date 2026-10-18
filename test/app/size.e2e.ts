import { expect, test, type Page } from '@playwright/test';
import { BANK_SIZE, compile, parseSong } from '../../src/core/compile.ts';
import { formatSong } from '../../src/core/format.ts';
import { noteName } from '../../src/core/notes.ts';
import type { Song } from '../../src/core/schema.ts';

// The compiled song's size in the status line, as `gbscore check` gives it.

function song(input: unknown): Song {
  const parsed = parseSong(input);
  if (parsed.errors) throw new Error(JSON.stringify(parsed.errors));
  return parsed.song;
}

const tune = song({
  version: 1,
  grid: { rowsPerBeat: 4, beatsPerBar: 4 },
  groove: [6, 6, 6, 6],
  length: 64,
  instruments: { duty: [{ id: 1, duty: '50%', volume: 15 }] },
  lanes: { pulse1: [{ row: 0, len: 4, note: 'C5', inst: 1 }, { row: 8, len: 4, note: 'G5', inst: 1 }] },
});

async function openFile(page: Page, name: string, s: Song) {
  await page.goto('/');
  await page.getByRole('button', { name: 'halt_bug' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: /Open a song file/ }).click();
  await (await chooser).setFiles({ name, mimeType: 'application/json', buffer: Buffer.from(formatSong(s)) });
  await expect(page.getByRole('button', { name: name.replace('.gbscore.json', '') })).toBeVisible();
}

test('shows the size of the song as it compiles', async ({ page }) => {
  await openFile(page, 'tune.gbscore.json', tune);
  const compiled = compile(tune);
  if (!compiled.ok) throw new Error('tune should compile');
  await expect(page.getByText(`${compiled.size} bytes`, { exact: true })).toBeVisible();
});

test("a song that doesn't compile has no size", async ({ page }) => {
  const broken = { ...tune, lanes: { ...tune.lanes, pulse1: [{ row: 0, len: 4, note: 'C5', inst: 9 }] } };
  await openFile(page, 'broken.gbscore.json', broken);
  await expect(page.getByText(/ bytes/)).toHaveCount(0);
});

test('a song over one bank says so', async ({ page }) => {
  // Random notes on every row of three lanes, so no two patterns are the same.
  const length = 64 * 32;
  let seed = 1;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % 72;
  const notes = () => Array.from({ length }, (_, row) => ({ row, len: 1, note: noteName(random()), inst: 1 }));
  const big = song({
    ...tune,
    length,
    instruments: { ...tune.instruments, noise: [{ id: 1, volume: 8 }] },
    lanes: { pulse1: notes(), pulse2: notes(), noise: notes() },
  });
  const compiled = compile(big);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors.slice(0, 3)));
  expect(compiled.size).toBeGreaterThan(BANK_SIZE);
  await openFile(page, 'big.gbscore.json', big);
  await expect(page.getByText(`${compiled.size.toLocaleString('en-US')} bytes, over one 16 KB bank`)).toBeVisible();
});
