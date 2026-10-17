import { expect, test, type Page } from '@playwright/test';
import { parseSong } from '../../src/core/compile.ts';
import { formatSong } from '../../src/core/format.ts';
import { TABLE_PRESETS, WAVE_PRESETS } from '../../src/app/instruments.ts';
import { GUTTER, laneBoxes } from '../../src/app/roll/geometry.ts';

// Step 4a of pass 4 in a real browser: the instrument panel edits instruments and draws waves. The folder is the
// origin-private file system.

const parsed = parseSong({
  version: 1,
  grid: { rowsPerBeat: 4, beatsPerBar: 4 },
  groove: [6, 6, 6, 6],
  length: 64,
  instruments: { duty: [{ id: 1, duty: '50%', volume: 15 }] },
  lanes: { pulse1: [{ row: 0, len: 4, note: 'C5', inst: 1 }] },
});
if (parsed.errors) throw new Error(JSON.stringify(parsed.errors));
const NAME = 'tune.gbscore.json';

async function onDisk(page: Page): Promise<string> {
  return page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    return (await (await root.getFileHandle(name)).getFile()).text();
  }, NAME);
}

test('edits instruments and draws waves', async ({ page }) => {
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
  await expect(page.getByRole('button', { name: 'tune' })).toBeVisible();

  await page.keyboard.press('KeyI');
  const panel = page.getByRole('region', { name: 'Instruments' });
  await expect(panel).toContainText('Duty instruments');
  await expect(panel.getByRole('option')).toHaveCount(1);

  // Duty, volume by the keys, and a name.
  await panel.getByRole('radio', { name: '25%' }).click();
  const volume = panel.getByLabel('Volume', { exact: true });
  await volume.focus();
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowLeft');
  await expect(volume).toHaveValue('9');
  await panel.getByLabel('Name').fill('Lead');
  await page.keyboard.press('Enter');
  await expect(panel.getByRole('option', { selected: true })).toContainText('Lead');

  // A second instrument, picked for new notes, and one that notes use can't go.
  await panel.getByRole('button', { name: 'New instrument' }).click();
  await expect(panel.getByRole('option')).toHaveCount(2);
  await expect(panel.getByRole('option', { selected: true })).toContainText('2');
  await panel.getByRole('option', { name: /Lead/ }).click();
  await panel.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText(/1 note uses it/)).toBeVisible();

  // The wave lane: a new instrument makes a wave to draw.
  const canvas = (await page.locator('canvas').boundingBox())!;
  const wave = laneBoxes(canvas.height, 'pulse1')[2]!;
  await page.mouse.click(canvas.x + GUTTER + 40, canvas.y + wave.top + 10);
  await expect(panel).toContainText('Wave instruments');
  await panel.getByRole('button', { name: 'New instrument' }).click();
  await panel.getByRole('button', { name: 'Square' }).click();
  await expect(panel.getByText(WAVE_PRESETS.Square!)).toBeVisible();

  // A stroke along the bottom draws zeros, as one step of undo.
  const shape = (await panel.getByRole('img', { name: 'Wave shape' }).boundingBox())!;
  await page.mouse.move(shape.x + 2, shape.y + shape.height - 2);
  await page.mouse.down();
  await page.mouse.move(shape.x + shape.width / 2, shape.y + shape.height - 2, { steps: 5 });
  await page.mouse.move(shape.x + shape.width / 4, shape.y + 2, { steps: 5 });
  await page.mouse.up();
  await expect(panel.getByLabel('Samples')).toHaveText(/^0{8}F{8}0{16}$|^0{8}/);
  await page.keyboard.press('Control+z');
  await expect(panel.getByText(WAVE_PRESETS.Square!)).toBeVisible();

  // Issue #9: a wave is renamed, and can't be deleted while a wave instrument plays it.
  await panel.getByLabel('Wave name').fill('Box');
  await page.keyboard.press('Enter');
  await expect(panel.getByRole('radio', { name: 'Wave 0' })).toHaveAttribute('title', '0 Box');
  await panel.getByRole('button', { name: 'New instrument' }).click(); // instrument 2, playing wave 0
  await panel.getByRole('option').first().click();
  await panel.getByRole('button', { name: 'New wave' }).click(); // instrument 1 now plays wave 1
  await expect(panel.getByRole('radio', { name: 'Wave 1' })).toBeChecked();
  await expect(panel.getByRole('button', { name: 'Delete wave 1' })).toHaveCount(0);
  await panel.getByRole('radio', { name: 'Wave 0' }).hover();
  await panel.getByRole('button', { name: 'Delete wave 0' }).click();
  await expect(page.getByText(/wave 0 is used by wave instrument 2/)).toBeVisible();
  await panel.getByRole('option').nth(1).click();
  await panel.getByRole('button', { name: 'Delete', exact: true }).click();
  await panel.getByRole('button', { name: 'Delete wave 0' }).click();
  await expect(panel.getByRole('radio', { name: 'Wave 0' })).toHaveCount(0);

  await page.keyboard.press('Control+s');
  await expect.poll(() => onDisk(page)).toContain('"name": "Lead"');
  const saved = JSON.parse(await onDisk(page));
  expect(saved.instruments.duty).toMatchObject([
    { id: 1, name: 'Lead', duty: '25%', volume: 9 },
    { id: 2, duty: '50%', volume: 15 },
  ]);
  expect(saved.instruments.wave).toMatchObject([{ id: 1, wave: 1, level: '100%' }]);
  expect(saved.waves).toEqual([{ id: 1, data: WAVE_PRESETS.Square }]);

  // With no wave instruments left, the waves they played can still be deleted.
  await panel.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(panel).toContainText('No wave instruments yet');
  await panel.getByRole('listitem').hover();
  await panel.getByRole('button', { name: 'Delete wave 1' }).click();
  await expect(panel.getByRole('listitem')).toHaveCount(0);

  // Shown or hidden, the panel is remembered.
  await page.keyboard.press('KeyI');
  await expect(panel).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('gbscore.panel'))).toBe('off');
});

// Issue #2: a song with no noise instruments, and the panel closed, had no way to make one: the toolbar's picker was
// disabled with none to pick.
test('makes the first instrument of a kind from the toolbar, with the panel closed', async ({ page }) => {
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
  await expect(page.getByRole('button', { name: 'tune' })).toBeVisible();
  const panel = page.getByRole('region', { name: 'Instruments' });
  await expect(panel).toBeHidden();

  const canvas = (await page.locator('canvas').boundingBox())!;
  const noise = laneBoxes(canvas.height, 'pulse1')[3]!;
  await page.mouse.click(canvas.x + GUTTER + 40, canvas.y + noise.top + 10);
  await page.getByRole('button', { name: 'Instrument: none' }).click();
  await page.getByRole('menuitem', { name: 'New instrument' }).click();

  await expect(panel).toContainText('Noise instruments');
  await expect(panel.getByRole('option', { selected: true })).toContainText('1');
  await expect(page.getByRole('button', { name: 'Instrument: 1' })).toBeVisible();
  await page.keyboard.press('Control+s');
  await expect.poll(async () => JSON.parse(await onDisk(page)).instruments.noise).toMatchObject([{ id: 1, bits: 15 }]);
});

test('edits an instrument table: presets, drawn pitches, effects and jumps', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).showDirectoryPicker = () => navigator.storage.getDirectory();
    localStorage.setItem('gbscore.panel', 'on');
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
  const panel = page.getByRole('region', { name: 'Instruments' });
  await panel.getByRole('radio', { name: 'Table' }).click();

  await panel.getByRole('button', { name: 'Major' }).click();
  await expect(panel.getByRole('radio', { name: 'Table · 3 rows' })).toBeVisible();

  // A stroke across rows 3 to 5 near the top of the ±12 range draws +11 or so on each.
  const pitch = (await panel.getByRole('img', { name: 'Table pitches' }).boundingBox())!;
  const x = (row: number) => pitch.x + (row + 0.5) * (pitch.width / 32);
  await page.mouse.move(x(3), pitch.y + 4);
  await page.mouse.down();
  await page.mouse.move(x(5), pitch.y + 4, { steps: 4 });
  await page.mouse.up();
  await expect(panel.getByRole('radio', { name: 'Table · 6 rows' })).toBeVisible();
  // One step of undo takes the stroke away.
  await page.keyboard.press('Control+z');
  await expect(panel.getByRole('radio', { name: 'Table · 3 rows' })).toBeVisible();

  // Row 1 sets the duty; the jump on row 2 goes, and row 2 holds instead.
  await panel.getByRole('button', { name: 'Row 1 effect' }).click();
  await page.getByLabel('Effect', { exact: true }).selectOption('duty');
  await page.getByRole('radio', { name: '25%' }).last().click();
  await page.keyboard.press('Escape');
  await panel.getByRole('button', { name: 'Row 2 jump' }).click();
  await page.getByLabel('Then', { exact: true }).selectOption('2');
  await page.keyboard.press('Escape');
  // Glide can't run in a table, so it isn't offered.
  await panel.getByRole('button', { name: 'Row 0 effect' }).click();
  await expect(page.getByLabel('Effect', { exact: true }).locator('option', { hasText: 'Glide' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Keys go to a popover until it has faded out.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.press('Control+s');
  await expect.poll(async () => JSON.parse(await onDisk(page)).instruments.duty[0].table).toEqual([
    TABLE_PRESETS.Major![0],
    { ...TABLE_PRESETS.Major![1], fx: { duty: '25%' } },
    { note: 7, jump: 2 },
  ]);

  // A pitch typed in exactly, and Hex picked then None leaves no effect and no hex field.
  await panel.getByRole('button', { name: 'Row 3 pitch' }).click();
  await page.getByLabel('Semitones').fill('-17');
  await page.keyboard.press('Escape');
  await expect(panel.getByRole('button', { name: 'Row 3 pitch' })).toHaveText('-17');
  await panel.getByRole('button', { name: 'Row 3 effect' }).click();
  await page.getByLabel('Effect', { exact: true }).selectOption('raw');
  await page.getByLabel('Effect', { exact: true }).selectOption('');
  await expect(page.getByLabel('Hex')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Clear takes the table away.
  await panel.getByRole('button', { name: 'Clear' }).click();
  await expect(panel.getByRole('radio', { name: 'Table', exact: true })).toBeVisible();
});
