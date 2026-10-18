import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { loadAssets } from '../../src/cli/assets.ts';
import { compile, parseSong } from '../../src/core/compile.ts';
import { exportGbdk } from '../../src/core/export.ts';
import { formatSong } from '../../src/core/format.ts';
import type { Song } from '../../src/core/schema.ts';
import { render } from '../../src/play/render.ts';
import { encodeWav } from '../../src/play/wav.ts';

// Exports from the song menu: the app's WAV and C are the bytes the command line writes for the same song.

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

async function exportFrom(page: Page, title: string, item: string) {
  await page.getByRole('button', { name: title }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: item }).click();
  return downloading;
}

test('exports the song as the command line does', async ({ page }) => {
  await openFile(page, 'tune.gbscore.json', tune);
  const compiled = compile(tune);
  if (!compiled.ok) throw new Error('tune should compile');

  const c = await exportFrom(page, 'tune', 'Export GBDK C');
  expect(c.suggestedFilename()).toBe('tune.c');
  expect(readFileSync((await c.path())!, 'utf8')).toBe(
    exportGbdk(compiled.data, { name: 'tune_uge', bank: 255, source: 'tune.gbscore.json' }),
  );

  const wav = await exportFrom(page, 'tune', 'Export WAV');
  expect(wav.suggestedFilename()).toBe('tune.wav');
  const r = render(await loadAssets(), compiled.data, tune);
  expect(readFileSync((await wav.path())!).equals(encodeWav(r.audio, r.sampleRate))).toBe(true);
  await expect(page.getByText(/^Downloaded tune\.wav \(\d+\.\d s\)\.$/)).toBeVisible();
});

test("a song that doesn't compile can't be exported", async ({ page }) => {
  const broken = { ...tune, lanes: { ...tune.lanes, pulse1: [{ row: 0, len: 4, note: 'C5', inst: 9 }] } };
  await openFile(page, 'broken.gbscore.json', broken);
  await page.getByRole('button', { name: 'broken' }).click();
  await page.getByRole('menuitem', { name: 'Export GBDK C' }).click();
  await expect(page.getByText("The song doesn't compile, so it can't be exported. See the errors below.")).toBeVisible();
});
