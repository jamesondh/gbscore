import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const text = readFileSync('src/app/demo/halt_bug.gbscore.json', 'utf8');

async function openFile(page: Page, current: string, name: string) {
  await page.getByRole('button', { name: new RegExp(`^${current}(?: Unsaved edits)?$`) }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Open a song file…', exact: true }).click();
  await (await chooser).setFiles({ name: `${name}.gbscore.json`, mimeType: 'application/json', buffer: Buffer.from(text) });
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
}

async function picker(page: Page, current: string) {
  await page.getByRole('button', { name: new RegExp(`^${current}(?: Unsaved edits)?$`) }).click();
  await page.getByRole('menuitem', { name: 'Recent files', exact: true }).hover();
  await expect(page.getByText('Stored copies · saving downloads a file')).toBeVisible();
}

test('recent copies persist, reopen, move to the front, and clear without closing the song', async ({ page }) => {
  await page.goto('/');
  await openFile(page, 'halt_bug', 'first');
  await openFile(page, 'first', 'second');
  await page.reload();
  await picker(page, 'second');
  const entries = page.getByRole('menuitem').filter({ hasText: /\.gbscore\.json$/ });
  await expect(entries).toHaveText(['second.gbscore.json', 'first.gbscore.json']);
  await page.getByRole('menuitem', { name: 'first.gbscore.json', exact: true }).click();
  await expect(page.getByRole('button', { name: 'first', exact: true })).toBeVisible();
  await picker(page, 'first');
  await expect(entries).toHaveText(['first.gbscore.json', 'second.gbscore.json']);
  await page.getByRole('menuitem', { name: 'Clear recent files', exact: true }).click();
  await expect(page.getByRole('button', { name: 'first', exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'first', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Recent files', exact: true })).toBeDisabled();
});

test('recent file switching asks before discarding edits and retains downloaded changes', async ({ page }) => {
  await page.goto('/');
  await openFile(page, 'halt_bug', 'first');
  await openFile(page, 'first', 'second');
  await page.getByRole('button', { name: 'second', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Song settings…' }).click();
  await page.getByLabel('Title', { exact: true }).fill('Edited second');
  await page.getByRole('button', { name: 'Set', exact: true }).click();
  await expect(page.getByLabel('Unsaved edits')).toBeVisible();
  await picker(page, 'second');
  page.once('dialog', (dialog) => void dialog.dismiss());
  await page.getByRole('menuitem', { name: 'first.gbscore.json', exact: true }).click();
  await expect(page.getByLabel('Unsaved edits')).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'second Unsaved edits', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Download' }).click();
  await download;
  await picker(page, 'second');
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('menuitem', { name: 'first.gbscore.json', exact: true }).click();
  await picker(page, 'first');
  await page.getByRole('menuitem', { name: 'second.gbscore.json', exact: true }).click();
  await page.getByRole('button', { name: 'second', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Song settings…' }).click();
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Edited second');
});

test('history bounds and deduplicates entries, and tolerates corrupt storage', async ({ page }) => {
  await page.goto('/');
  await page.evaluate((text) => {
    localStorage.setItem('gbscore.recentFiles', JSON.stringify([
      ...Array.from({ length: 12 }, (_, i) => ({ name: `song${i}.gbscore.json`, text })),
      { name: 'song0.gbscore.json', text }, null, { name: 123 },
    ]));
  }, text);
  await page.reload();
  await picker(page, 'halt_bug');
  await expect(page.getByRole('menuitem').filter({ hasText: /\.gbscore\.json$/ })).toHaveCount(10);
  await page.evaluate(() => localStorage.setItem('gbscore.recentFiles', '{broken'));
  await page.reload();
  await page.getByRole('button', { name: 'halt_bug' }).click();
  await expect(page.getByRole('menuitem', { name: 'Recent files', exact: true })).toBeDisabled();
});

test('opening files still works when history storage is full', async ({ page }) => {
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    localStorage.setItem('gbscore.recentFiles', JSON.stringify([{ name: 'stale.gbscore.json', text: '{}' }]));
    Storage.prototype.setItem = function (key, value) {
      if (key === 'gbscore.recentFiles' || (key === 'gbscore.file' && this.getItem('gbscore.recentFiles'))) throw new DOMException('Full', 'QuotaExceededError');
      return setItem.call(this, key, value);
    };
  });
  await page.goto('/');
  await openFile(page, 'halt_bug', 'first');
  await openFile(page, 'first', 'second');
  await picker(page, 'second');
  await page.getByRole('menuitem', { name: 'first.gbscore.json', exact: true }).click();
  await expect(page.getByRole('button', { name: 'first', exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('gbscore.recentFiles'))).toBeNull();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('gbscore.file')!).name)).toBe('first.gbscore.json');
});


test('new songs and the demo do not replace previously opened files', async ({ page }) => {
  await page.goto('/');
  await openFile(page, 'halt_bug', 'untitled');
  await page.getByRole('button', { name: 'untitled', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New song', exact: true }).click();
  await expect(page.getByRole('button', { name: 'untitled', exact: true })).toBeVisible();
  const copies = await page.evaluate(() => JSON.parse(localStorage.getItem('gbscore.recentFiles')!));
  expect(copies).toEqual([{ name: 'untitled.gbscore.json', text }]);
  await page.getByRole('button', { name: 'untitled', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open the demo song', exact: true }).click();
  await expect(page.getByRole('button', { name: 'halt_bug', exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('gbscore.recentFiles')!))).toEqual(copies);
});
