import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { parseSong } from '../../src/core/compile.ts';
import { formatSong } from '../../src/core/format.ts';
import { clampPitchTop, GUTTER, laneBoxes, noteToY } from '../../src/app/roll/geometry.ts';

// A browser without the File System Access API, as Brave is by default: open one song from a file, edit it, and
// save it as a download.

const parsed = parseSong({
  version: 1,
  grid: { rowsPerBeat: 4, beatsPerBar: 4 },
  groove: [6, 6, 6, 6],
  length: 64,
  instruments: { duty: [{ id: 1, duty: '50%', volume: 15 }] },
  lanes: { pulse1: [{ row: 0, len: 4, note: 'C5', inst: 1 }] },
});
if (parsed.errors) throw new Error(JSON.stringify(parsed.errors));
const tune = formatSong(parsed.song);
const C5 = 24;

test('opens a song from a file and saves it as a download, without folder access', async ({ page, context }) => {
  await page.addInitScript(() => delete (window as { showDirectoryPicker?: unknown }).showDirectoryPicker);
  await page.goto('/');
  // The first visit opens the demo song. Without folder access, the song menu can only open a file.
  await expect(page.getByRole('button', { name: 'halt_bug' })).toBeVisible();
  await page.getByRole('button', { name: 'halt_bug' }).click();
  await expect(page.getByRole('menuitem', { name: /Open a folder/ })).toBeDisabled();

  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: /Open a song file/ }).click();
  await (await chooser).setFiles({ name: 'tune.gbscore.json', mimeType: 'application/json', buffer: Buffer.from(tune) });
  await expect(page.getByRole('button', { name: 'tune' })).toBeVisible();

  // Draw a note a beat after the first, and save: the song downloads. It still counts as unsaved, since the
  // download could have been cancelled, and it can be downloaded again.
  const canvas = (await page.locator('canvas').boundingBox())!;
  const box = laneBoxes(canvas.height, 'pulse1')[0]!;
  const y = canvas.y + noteToY(box, clampPitchTop(box, C5 + 4), C5) + 6;
  await page.mouse.click(canvas.x + GUTTER + 8.5 * 12, y);
  await expect(page.getByLabel('Unsaved edits')).toBeVisible();
  const downloading = page.waitForEvent('download');
  await page.keyboard.press('Control+s');
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('tune.gbscore.json');
  const text = readFileSync((await download.path())!, 'utf8');
  expect(text).toContain('{ "row": 8, "len": 4, "note": "C5", "inst": 1 }');
  await expect(page.getByText('Downloaded tune.gbscore.json.')).toBeVisible();
  await expect(page.getByLabel('Unsaved edits')).toBeVisible();
  const again = page.waitForEvent('download');
  await page.getByRole('button', { name: 'tune' }).click();
  await page.getByRole('menuitem', { name: 'Download' }).click();
  expect((await again).suggestedFilename()).toBe('tune.gbscore.json');

  // The next visit reopens the song as it was last downloaded, with nothing unsaved.
  const next = await context.newPage();
  await next.goto('/');
  await expect(next.getByRole('button', { name: 'tune' })).toBeVisible();
  await expect(next.getByLabel('Unsaved edits')).toHaveCount(0);
  const kept = await next.evaluate(() => JSON.parse(localStorage.getItem('gbscore.file')!) as { text: string });
  expect(kept.text).toBe(text);
});

test('opening a folder forgets the song opened from a file', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { showDirectoryPicker: () => unknown }).showDirectoryPicker = () =>
      navigator.storage.getDirectory();
  });
  await page.goto('/');
  await page.evaluate(async (text) => {
    const dir = await navigator.storage.getDirectory();
    const writable = await (await dir.getFileHandle('folk.gbscore.json', { create: true })).createWritable();
    await writable.write(text);
    await writable.close();
  }, tune);

  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'halt_bug' }).click();
  await page.getByRole('menuitem', { name: /Open a song file/ }).click();
  await (await chooser).setFiles({ name: 'tune.gbscore.json', mimeType: 'application/json', buffer: Buffer.from(tune) });
  await expect(page.getByRole('button', { name: 'tune' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'tune' })).toBeVisible();

  await page.getByRole('button', { name: 'tune' }).click();
  await page.getByRole('menuitem', { name: /Open a folder/ }).click();
  await expect(page.getByRole('button', { name: 'folk' })).toBeVisible();
  // Reloading now would reopen the folder, but headless Chromium closes the page when it reads an OPFS folder
  // back from IndexedDB, so check that the song is forgotten instead.
  expect(await page.evaluate(() => localStorage.getItem('gbscore.file'))).toBeNull();
});
