import { expect, test } from '@playwright/test';
import { parseSong } from '../../src/core/compile.ts';
import { formatSong } from '../../src/core/format.ts';

// The toolbar fits on one row, every control on the screen, from 1024 px wide up, with long names in it
// (docs/editor/README.md, "Toolbar").

const parsed = parseSong({
  version: 1,
  grid: { rowsPerBeat: 4, beatsPerBar: 4 },
  groove: [6, 6, 6, 6],
  length: 64,
  instruments: { duty: [{ id: 12, name: 'a very long instrument name indeed', duty: '50%', volume: 15 }] },
  lanes: { pulse1: [{ row: 0, len: 13, note: 'C5', inst: 12 }] },
});
if (parsed.errors) throw new Error(JSON.stringify(parsed.errors));
const NAME = 'the-longest-song-name-anyone-would-give-a-song.gbscore.json';

test('fits from 1024 px wide up, with long names', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).showDirectoryPicker = () => navigator.storage.getDirectory();
  });
  await page.goto('/');
  await page.evaluate(
    async ([name, text]) => {
      const w = await (await (await navigator.storage.getDirectory()).getFileHandle(name!, { create: true })).createWritable();
      await w.write(text!);
      await w.close();
    },
    [NAME, formatSong(parsed.song)],
  );
  await page.getByRole('button', { name: 'halt_bug' }).click(); // the demo song is open
  await page.getByRole('menuitem', { name: /Open a folder/ }).click();
  const toolbar = page.getByRole('toolbar');
  await expect(toolbar.getByRole('button', { name: /the-longest-song/ })).toBeVisible();
  // Note entry on, and an edit, so the unsaved dot shows. The pen has the long-named instrument.
  await page.keyboard.press('Control+a');
  await page.keyboard.press('KeyM');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByLabel('Unsaved edits')).toBeVisible();

  for (const width of [1024, 1280, 1920]) {
    await page.setViewportSize({ width, height: 800 });
    const fit = await toolbar.evaluate((bar) => ({
      overflow: bar.scrollWidth - bar.clientWidth,
      off: [...bar.querySelectorAll('button')]
        .filter((b) => b.getBoundingClientRect().right > innerWidth || b.getBoundingClientRect().height > bar.clientHeight)
        .map((b) => b.getAttribute('aria-label') ?? b.textContent),
    }));
    expect(fit, `at ${width} px`).toEqual({ overflow: 0, off: [] });
  }
});
