import { expect, test } from '@playwright/test';
import { parseSong } from '../../src/core/compile.ts';
import { formatSong } from '../../src/core/format.ts';

// The toolbar fits on one row, every control on the screen, from 1024 px wide up, with long names in it, and on
// two rows on a tablet or a phone, with Play on the first (docs/editor/README.md, "Toolbar").

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

test('fits on one row from 1024 px wide up, and on two on a phone, with long names', async ({ page }) => {
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

  for (const width of [390, 768, 1024, 1280, 1920]) {
    await page.setViewportSize({ width, height: 800 });
    // The buttons' padding changes with the width, and they animate it (transition-all).
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
    const fit = await toolbar.evaluate((bar) => {
      const buttons = [...bar.querySelectorAll('button')];
      const box = bar.getBoundingClientRect();
      // A row is the buttons whose middles line up.
      const row = (b: Element) => Math.round(b.getBoundingClientRect().top + b.getBoundingClientRect().height / 2);
      const rows = [...new Set(buttons.map(row))].sort((a, b) => a - b);
      return {
        overflow: bar.scrollWidth - bar.clientWidth,
        off: buttons
          .filter((b) => {
            const r = b.getBoundingClientRect();
            return r.left < 0 || r.right > innerWidth || r.top < box.top || r.bottom > box.bottom;
          })
          .map((b) => b.getAttribute('aria-label') ?? b.textContent),
        rows: rows.length,
        playOnFirstRow: row(buttons.find((b) => b.textContent === 'Play')!) === rows[0],
      };
    });
    const { rows, ...rest } = fit;
    expect(rest, `at ${width} px`).toEqual({ overflow: 0, off: [], playOnFirstRow: true });
    expect(rows, `rows at ${width} px`).toBeLessThanOrEqual(width >= 1024 ? 1 : 2);
  }
});

test('the logo opens About, with the source and the commit the build is from', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'About gbscore' }).click();
  const about = page.getByRole('dialog', { name: 'gbscore' });
  await expect(about.getByRole('link', { name: 'Source on GitHub' })).toHaveAttribute('href', 'https://github.com/jamesondh/gbscore');
  await expect(about.getByRole('link', { name: /^[0-9a-f]{7}$/ })).toBeVisible();
});
