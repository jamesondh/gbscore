import { expect, test, type Page } from '@playwright/test';
import { parseSong } from '../../src/core/compile.ts';
import { formatSong } from '../../src/core/format.ts';
import type { Song } from '../../src/core/schema.ts';
import { GUTTER, laneBoxes, songLaneTop, stripTop } from '../../src/app/roll/geometry.ts';

// Step 4b of pass 4 in a real browser: effects edited by row on the expanded lane's strip, the song lane, and
// compile errors on the roll. The folder is the origin-private file system.

const parsed = parseSong({
  version: 1,
  grid: { rowsPerBeat: 4, beatsPerBar: 4 },
  groove: [6, 6, 6, 6],
  length: 64,
  instruments: { duty: [{ id: 1, duty: '50%', volume: 15 }] },
  lanes: {
    pulse1: [
      { row: 0, len: 4, note: 'C5', inst: 1 },
      { row: 4, fx: { volume: 3 } }, // where the note's cut goes: a compile error
    ],
  },
});
if (parsed.errors) throw new Error(JSON.stringify(parsed.errors));
const NAME = 'tune.gbscore.json';
const ROW = 12; // pixels, the roll's starting zoom

async function onDisk(page: Page) {
  return JSON.parse(
    await page.evaluate(async (name) => {
      const root = await navigator.storage.getDirectory();
      // A read that meets the app's save mid-write fails with NotReadableError, or NotFoundError while the save
      // swaps the new file in; read again.
      for (let tries = 0; ; tries++) {
        try {
          return await (await (await root.getFileHandle(name)).getFile()).text();
        } catch (e) {
          if (tries >= 20 || !['NotReadableError', 'NotFoundError'].includes((e as DOMException).name)) throw e;
          await new Promise((r) => setTimeout(r, 20));
        }
      }
    }, NAME),
  );
}

/** Opens the song in the app, from the origin-private file system. */
async function openTune(page: Page, song: Song) {
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
    [NAME, formatSong(song)],
  );
  await page.getByRole('button', { name: 'halt_bug' }).click(); // the demo song is open
  await page.getByRole('menuitem', { name: /Open a folder/ }).click();
  await expect(page.getByRole('button', { name: 'tune' })).toBeVisible();
}

test('edits effects by row, the song lane, and shows errors where they are', async ({ page }) => {
  await openTune(page, parsed.song);

  const canvas = page.locator('canvas');
  let box = (await canvas.boundingBox())!;
  let boxes = laneBoxes(box.height, 'pulse1');
  const x = (row: number) => box.x + GUTTER + (row + 0.5) * ROW;
  let strip = box.y + stripTop(boxes[0]!) + 12;
  let song = box.y + songLaneTop(boxes) + 15;

  // The effect where the note's cut goes is an error, marked on its row.
  await expect(page.getByText(/the cut that ends the note at 1\.1\.1 needs this row's effect slot/)).toBeVisible();
  await page.mouse.move(x(4), strip);
  await expect(canvas).toHaveAttribute('title', /the cut that ends the note[^\n]*\nVolume 3\nC5's end/);
  // A click there says why it's taken; right-click takes the effect away, and the error with it.
  await page.mouse.click(x(4), strip);
  await expect(page.getByRole('dialog')).toContainText('C5 at 1.1.1 ends here');
  await page.keyboard.press('Escape');
  await page.mouse.click(x(4), strip, { button: 'right' });
  await expect(page.getByText(/needs this row's effect slot/)).toHaveCount(0);
  // The error list has gone, so the roll is taller, once its ResizeObserver has run: measured before that, the
  // clicks below miss the strip and the song lane.
  await expect.poll(async () => (await canvas.boundingBox())!.height).toBeGreaterThan(box.height);
  box = (await canvas.boundingBox())!;
  boxes = laneBoxes(box.height, 'pulse1');
  strip = box.y + stripTop(boxes[0]!) + 12;
  song = box.y + songLaneTop(boxes) + 15;

  // On the note's first row the effect is the note's; a row on, it's inside the note.
  await page.mouse.click(x(0), strip);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText("The first row of C5: the effect is the note's.");
  await dialog.getByLabel('Effect', { exact: true }).selectOption('volume');
  await dialog.getByLabel('value').fill('9');
  await dialog.getByRole('button', { name: 'Row after' }).click();
  await expect(dialog).toContainText('Inside C5 at 1.1.1');
  // No cut inside a note.
  await expect(dialog.getByLabel('Effect', { exact: true }).locator('option', { hasText: 'Cut' })).toHaveCount(0);
  await dialog.getByLabel('Effect', { exact: true }).selectOption('vibrato');
  await page.keyboard.press('Escape');

  // The song lane: tempo, pan and master volume on one row, each its own item.
  await page.mouse.click(x(8), song);
  await dialog.getByRole('checkbox', { name: 'Tempo' }).check();
  await dialog.getByLabel('Ticks a row').fill('3');
  await expect(dialog).toContainText('301 BPM');
  await dialog.getByRole('checkbox', { name: 'Pan' }).check();
  await dialog.getByRole('button', { name: 'Pulse 1 right' }).click();
  await dialog.getByRole('checkbox', { name: 'Master volume' }).check();
  await dialog.getByRole('radiogroup', { name: 'Master volume left' }).getByRole('radio', { name: '3' }).click();
  await page.keyboard.press('Escape');
  await page.mouse.move(x(8), song);
  await expect(canvas).toHaveAttribute('title', 'Tempo 3 ticks a row\nPan L LR LR LR\nMaster volume 3, 7');

  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.press('Control+s');
  await expect.poll(async () => (await onDisk(page)).global).toEqual([
    { row: 8, tempo: 3 },
    { row: 8, pan: ['L', 'LR', 'LR', 'LR'] },
    { row: 8, masterVolume: [3, 7] },
  ]);
  await expect.poll(async () => (await onDisk(page)).lanes.pulse1).toEqual([
    { row: 0, len: 4, note: 'C5', inst: 1, fx: { volume: 9 } },
    { row: 1, fx: { vibrato: [4, 2] } },
  ]);

  // An open editor left in Hex mode showed Hex, empty, after the file changed under it.
  await page.mouse.click(x(1), strip);
  await dialog.getByLabel('Effect', { exact: true }).selectOption('raw');
  await expect(dialog.getByLabel('Hex')).toBeVisible();
  const changed = await onDisk(page);
  changed.lanes.pulse1[1] = { row: 1, fx: { volume: 6 } };
  await page.evaluate(
    async ([name, text]) => {
      const w = await (await (await navigator.storage.getDirectory()).getFileHandle(name!)).createWritable();
      await w.write(text!);
      await w.close();
    },
    [NAME, JSON.stringify(changed, null, 2)],
  );
  await expect(dialog.getByLabel('Effect', { exact: true })).toHaveValue('volume', { timeout: 5000 });
  await expect(dialog.getByLabel('value')).toHaveValue('6');
  await page.keyboard.press('Escape');

  // Cut starts at tick 0, which every row has; a row of one tick has no tick to delay to.
  await page.mouse.click(x(20), strip);
  await dialog.getByLabel('Effect', { exact: true }).selectOption('cut');
  await expect(dialog.getByLabel('tick')).toHaveValue('0');
  await page.keyboard.press('Escape');
  await page.mouse.click(x(30), song);
  await dialog.getByRole('checkbox', { name: 'Tempo' }).check();
  await dialog.getByLabel('Ticks a row').fill('1');
  await page.keyboard.press('Escape');
  await page.mouse.click(x(30), strip);
  await expect(dialog.getByLabel('Effect', { exact: true }).locator('option', { hasText: 'Delay' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  // Row 21 has 3 ticks (the tempo at row 8): a delay of 1 or 2.
  await page.mouse.click(x(21), strip);
  await dialog.getByLabel('Effect', { exact: true }).selectOption('delay');
  await expect(dialog.getByLabel('tick')).toHaveAttribute('min', '1');
  await expect(dialog.getByLabel('tick')).toHaveAttribute('max', '2');
  await page.keyboard.press('Escape');
  // Without row 8's tempo, row 21 would have 1 tick and the delay couldn't play: it goes before that tempo does.
  await page.mouse.click(x(21), strip, { button: 'right' });

  // Right-click clears a song row; undo brings it back.
  await page.mouse.click(x(8), song, { button: 'right' });
  await page.mouse.move(x(8), song - 40); // the title changes as the pointer moves
  await page.mouse.move(x(8), song);
  await expect(canvas).toHaveAttribute('title', '');
  await page.keyboard.press('Control+z');
  await page.mouse.move(x(8), song + 1);
  await expect(canvas).toHaveAttribute('title', /Tempo 3/);
});

// Issue 8: a cutTick added to a note from the popover on its last row, which takes that row's effect slot.
test("adds a cutTick to a note on its last row, once the row's effect is gone", async ({ page }) => {
  const p = parseSong({
    ...parsed.song,
    lanes: { pulse1: [{ row: 0, len: 4, note: 'C5', inst: 1 }, { row: 3, fx: { volume: 5 } }] },
  });
  if (p.errors) throw new Error(JSON.stringify(p.errors));
  await openTune(page, p.song);
  const canvas = page.locator('canvas');
  const box = (await canvas.boundingBox())!;
  const x = (row: number) => box.x + GUTTER + (row + 0.5) * ROW;
  const strip = box.y + stripTop(laneBoxes(box.height, 'pulse1')[0]!) + 12;
  const dialog = page.getByRole('dialog');

  // The volume holds the slot: the popover says which, and offers no cut.
  await page.mouse.click(x(3), strip);
  await expect(dialog).toContainText('C5 at 1.1.1 ends on this row. To cut it at a tick of the row, remove the Volume 5 here');
  await expect(dialog.getByRole('button', { name: 'Cut at a tick' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.mouse.click(x(3), strip, { button: 'right' });

  // Now it can: at the middle tick of the row's 6, then changed within them.
  await page.mouse.click(x(3), strip);
  await dialog.getByRole('button', { name: 'Cut at a tick' }).click();
  await expect(dialog).toContainText('C5 at 1.1.1 ends here, at tick 3 of this row');
  await expect(dialog.getByLabel('Cut at tick')).toHaveAttribute('max', '5');
  await dialog.getByLabel('Cut at tick').fill('5');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+s');
  await expect.poll(async () => (await onDisk(page)).lanes.pulse1).toEqual([{ row: 0, len: 4, note: 'C5', inst: 1, cutTick: 5 }]);
  // The row after, where the driver cut it before, is free for an effect.
  await page.mouse.click(x(4), strip);
  await expect(dialog).toContainText('Outside any note.');
  await expect(dialog.getByLabel('Effect', { exact: true })).toBeVisible();
});

// Issue 7: volume drawn along the strip, and effects selected, moved, copied and pasted apart from their notes.
test('draws volume, and selects, moves and pastes effects apart from their notes', async ({ page }) => {
  const tune = parseSong({
    version: 1,
    grid: { rowsPerBeat: 4, beatsPerBar: 4 },
    groove: [6, 6, 6, 6],
    length: 64,
    instruments: { duty: [{ id: 1, duty: '50%', volume: 15 }] },
    lanes: {
      pulse1: [
        { row: 0, len: 4, note: 'C5', inst: 1, fx: { volume: 3 } },
        { row: 4, len: 2, note: 'D5', inst: 1 }, // cut at 6
        { row: 5, fx: { vibrato: [4, 2] } },
        { row: 8, len: 4, note: 'E5', inst: 1 }, // cut at 12
      ],
    },
  });
  if (tune.errors) throw new Error(JSON.stringify(tune.errors));
  await openTune(page, tune.song);
  const canvas = page.locator('canvas');
  const box = (await canvas.boundingBox())!;
  const lane = laneBoxes(box.height, 'pulse1')[0]!;
  const x = (row: number) => box.x + GUTTER + (row + 0.5) * ROW;
  const top = box.y + stripTop(lane) + 1; // volume 15
  const middle = box.y + stripTop(lane) + 12;
  // The file holds what the last save wrote, so wait for this one before reading it.
  const saved = async (pulse1: object[]) => {
    await page.keyboard.press('Control+s');
    await expect(page.getByLabel('Unsaved edits')).toBeHidden();
    expect((await onDisk(page)).lanes.pulse1).toEqual(pulse1);
  };

  // A drag along the top of the strip draws 15 where notes start; the vibrato and the empty rows stay as they were.
  await page.mouse.move(x(0), top);
  await page.mouse.down();
  await page.mouse.move(x(5), top, { steps: 5 });
  await page.mouse.move(x(9), top, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByRole('dialog')).toHaveCount(0); // a drag, not a click
  await saved([
    { row: 0, len: 4, note: 'C5', inst: 1, fx: { volume: 15 } },
    { row: 4, len: 2, note: 'D5', inst: 1, fx: { volume: 15 } },
    { row: 5, fx: { vibrato: [4, 2] } },
    { row: 8, len: 4, note: 'E5', inst: 1, fx: { volume: 15 } },
  ]);

  // Shift-click selects effects; dragging one moves them both two rows, off their notes.
  await page.keyboard.down('Shift');
  await page.mouse.click(x(5), middle);
  await page.mouse.click(x(8), middle);
  await page.keyboard.up('Shift');
  await page.mouse.move(x(8), middle);
  await expect(canvas).toHaveCSS('cursor', 'move');
  await page.mouse.down();
  await page.mouse.move(x(10), middle, { steps: 5 });
  await page.mouse.up();
  const moved = [
    { row: 0, len: 4, note: 'C5', inst: 1, fx: { volume: 15 } },
    { row: 4, len: 2, note: 'D5', inst: 1, fx: { volume: 15 } },
    { row: 7, fx: { vibrato: [4, 2] } },
    { row: 8, len: 4, note: 'E5', inst: 1 },
    { row: 10, fx: { volume: 15 } },
  ];
  await saved(moved);

  // A row back, the vibrato would land where D5's cut goes: refused, and nothing moves.
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByText(/the note at 1\.2\.1 ends here/)).toBeVisible();

  // Copied, they paste at the flag, effects only.
  await page.keyboard.press('Control+c');
  await page.mouse.click(x(16), box.y + 10); // the ruler: the flag
  await page.keyboard.press('Control+v');
  await saved([...moved, { row: 16, fx: { vibrato: [4, 2] } }, { row: 19, fx: { volume: 15 } }]);
  // They're selected, and Delete deletes them; their notes were never touched.
  await page.keyboard.press('Delete');
  await saved(moved);

  // Shift-drag selects the effects in the rows it covers, and only those: rows 0 to 7, not row 10.
  await page.keyboard.down('Shift');
  await page.mouse.move(x(0), middle);
  await page.mouse.down();
  await page.mouse.move(x(7), middle, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.keyboard.press('Delete');
  await saved([
    { row: 0, len: 4, note: 'C5', inst: 1 },
    { row: 4, len: 2, note: 'D5', inst: 1 },
    { row: 8, len: 4, note: 'E5', inst: 1 },
    { row: 10, fx: { volume: 15 } },
  ]);

  // A stroke over rows without notes changed nothing, but was a step of undo that lost the redo.
  await page.keyboard.press('Control+z');
  await page.mouse.move(x(20), top);
  await page.mouse.down();
  await page.mouse.move(x(30), top, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press('Control+Shift+z');
  await saved([
    { row: 0, len: 4, note: 'C5', inst: 1 },
    { row: 4, len: 2, note: 'D5', inst: 1 },
    { row: 8, len: 4, note: 'E5', inst: 1 },
    { row: 10, fx: { volume: 15 } },
  ]);
});
