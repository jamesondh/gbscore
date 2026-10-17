import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { parseSong } from '../../src/core/compile.ts';
import { formatSong } from '../../src/core/format.ts';

// Share links (docs/editor/, "Share links"): the song menu copies a link with the song in it, and the link opens
// the song in another browser, as if from a file.

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

test('copies a link that opens the song somewhere else', async ({ page, context, browser }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'halt_bug' }).click();
  await page.getByRole('menuitem', { name: /Open a song file/ }).click();
  await (await chooser).setFiles({ name: 'tune.gbscore.json', mimeType: 'application/json', buffer: Buffer.from(tune) });
  await page.getByRole('button', { name: 'tune' }).click();
  await page.getByRole('menuitem', { name: 'Copy share link' }).click();
  await expect(page.getByText(/^Copied a link to tune \(\d+ characters\)\.$/)).toBeVisible();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(/^http:\/\/localhost:4173\/#v=1&name=tune&song=[\w-]+$/);

  // Someone else opens it: the song opens as if from a file, and leaves the address.
  const other = await browser.newContext();
  const theirs = await other.newPage();
  await theirs.goto(link);
  await expect(theirs.getByRole('button', { name: 'tune' })).toBeVisible();
  await expect(theirs.getByLabel('Unsaved edits')).toHaveCount(0);
  expect(new URL(theirs.url()).hash).toBe('');
  const downloading = theirs.waitForEvent('download');
  await theirs.keyboard.press('Control+s');
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('tune.gbscore.json');
  expect(readFileSync((await download.path())!, 'utf8')).toBe(tune);

  // Reloading reopens it, as it would a song opened from a file.
  await theirs.reload();
  await expect(theirs.getByRole('button', { name: 'tune' })).toBeVisible();
  await other.close();
});

test('a link pasted into a tab already open opens the song', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'halt_bug' })).toBeVisible();
  const hash = await page.evaluate(async (text) => {
    const data = new Blob([JSON.stringify(JSON.parse(text))]).stream().pipeThrough(new CompressionStream('deflate'));
    const bytes = new Uint8Array(await new Response(data).arrayBuffer());
    const song = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `#${new URLSearchParams({ v: '1', name: 'pasted', song })}`;
  }, tune);
  await page.evaluate(() => ((window as unknown as { same: boolean }).same = true));
  await page.goto(`/${hash}`);
  await expect(page.getByRole('button', { name: 'pasted' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { same?: boolean }).same)).toBe(true); // no reload: the app saw the hash change
});

test('a damaged link says so', async ({ page }) => {
  await page.goto('/#v=1&name=cut&song=AAAA');
  await expect(page.getByText(/This share link is damaged/)).toBeVisible();
});

test('declining to throw away edits for a pasted link takes the link out of the address', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'halt_bug' })).toBeVisible();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('KeyM');
  await page.keyboard.press('ArrowUp');
  await expect(page.getByLabel('Unsaved edits')).toBeVisible();
  page.once('dialog', (d) => void d.dismiss());
  await page.goto('/#v=1&name=cut&song=AAAA');
  await expect.poll(() => new URL(page.url()).hash).toBe('');
  await expect(page.getByRole('button', { name: /halt_bug/ })).toBeVisible();
  await expect(page.getByText(/damaged/)).toHaveCount(0);
});
