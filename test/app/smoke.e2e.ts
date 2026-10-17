import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Step 1 of pass 4 in a real browser: open a folder, play, reload on outside changes, and the folder check. The
// folder is the origin-private file system, standing in for the one the picker would return.

// The demo song, 784 rows, under other names, so its button isn't the demo's.
const haltBug = readFileSync(new URL('../../src/app/demo/halt_bug.gbscore.json', import.meta.url), 'utf8');

async function writeFiles(page: Page, files: Record<string, string>) {
  await page.evaluate(async (files) => {
    const root = await navigator.storage.getDirectory();
    for (const [name, text] of Object.entries(files)) {
      const w = await (await root.getFileHandle(name, { create: true })).createWritable();
      await w.write(text);
      await w.close();
    }
  }, files);
}

async function readFile(page: Page, name: string): Promise<string | null> {
  return page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    try {
      return await (await (await root.getFileHandle(name)).getFile()).text();
    } catch {
      return null;
    }
  }, name);
}

async function openFolder(page: Page, files: Record<string, string>) {
  await page.addInitScript(() => {
    (window as unknown as { showDirectoryPicker: () => unknown }).showDirectoryPicker = () =>
      navigator.storage.getDirectory();
  });
  await page.goto('/');
  await writeFiles(page, files);
  await page.getByRole('button', { name: 'halt_bug' }).click(); // the demo song is open
  await page.getByRole('menuitem', { name: /Open a folder/ }).click();
}

test('plays a song, and reloads it when it changes on disk', async ({ page }) => {
  // overture sorts first, so it's the one that opens.
  await openFolder(page, { 'overture.gbscore.json': haltBug, 'tune.gbscore.json': haltBug });
  await expect(page.getByRole('button', { name: 'overture' })).toBeVisible();

  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByText(/started in \d+ ms/)).toBeVisible();
  await expect.poll(() => page.getByLabel('Position').textContent(), { timeout: 5000 }).not.toBe('1.1.1');
  await page.keyboard.press(' ');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();

  // Space on a focused menu button opens the menu and doesn't play; once the menu closes, Space plays again.
  await page.getByRole('button', { name: 'overture' }).focus();
  await page.keyboard.press(' ');
  await expect(page.getByRole('menuitem', { name: 'Check folder access' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play', exact: true, includeHidden: true })).toBeVisible(); // hidden: the menu is modal
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menuitem', { name: 'Check folder access' })).toBeHidden(); // it takes keys while it closes
  await page.keyboard.press(' ');
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
  await page.keyboard.press(' ');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();

  await writeFiles(page, { 'overture.gbscore.json': haltBug.replace('Math chiptune in D minor.', 'x') });
  await expect(page.getByText(/reloaded from disk/)).toBeVisible({ timeout: 4000 });

  // A broken file is reported, and Play keeps the last version that compiled.
  await writeFiles(page, { 'overture.gbscore.json': '{"version": 1' });
  await expect(page.getByText(/isn't valid JSON/)).toBeVisible({ timeout: 4000 });
  await expect(page.getByText(/Play plays the last one that did/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
});

test('starts late in a long song', async ({ page }) => {
  await openFolder(page, { 'halt-bug.gbscore.json': haltBug });
  await expect(page.getByRole('button', { name: 'halt-bug' })).toBeVisible();
  const canvas = page.locator('canvas');
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down('Control'); // zoom out
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 200);
  await page.keyboard.up('Control');
  for (let i = 0; i < 20; i++) await page.mouse.wheel(5000, 0); // to the end
  const position = page.getByLabel('Position');
  const started = page.getByText(/started in \d+ ms/);
  const playFrom = async (fraction: number) => {
    const before = await position.textContent();
    await page.mouse.click(box.x + box.width * fraction, box.y + 10); // the ruler
    await expect.poll(() => position.textContent()).not.toBe(before);
    const at = await position.textContent();
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(started).toBeVisible({ timeout: 15000 });
    const ms = Number(/(\d+) ms/.exec((await started.textContent())!)![1]);
    await page.keyboard.press(' ');
    return { at, ms };
  };
  // Right after opening, before the background pass has made snapshots: it plays the song up to there.
  const cold = await playFrom(0.1);
  // Later still, once the background pass has had time to finish: it starts from the nearest snapshot.
  await page.waitForTimeout(8000);
  const warm = await playFrom(0.45);
  console.log(`cold start at ${cold.at}: ${cold.ms} ms; prepared start at ${warm.at}: ${warm.ms} ms`);
  expect(warm.ms).toBeLessThan(500);
});

test('checks the folder both ways', async ({ page }) => {
  await openFolder(page, { 'overture.gbscore.json': haltBug });
  await page.getByRole('button', { name: 'overture' }).click();
  await page.getByRole('menuitem', { name: 'Check folder access' }).click();
  await expect(page.getByText('Folder check')).toBeVisible();
  const wrote = (await readFile(page, 'gbscore-probe.txt'))!.trim();
  expect(wrote).toMatch(/^gbscore wrote this at /);
  await expect(page.getByText(wrote).nth(1)).toBeVisible(); // what it wrote, and what it reads

  await writeFiles(page, { 'gbscore-probe.txt': 'changed on the other side\n' });
  await expect(page.getByText('changed on the other side')).toBeVisible({ timeout: 4000 });

  await page.getByRole('button', { name: /Done/ }).click();
  await expect.poll(() => readFile(page, 'gbscore-probe.txt')).toBeNull();
});
