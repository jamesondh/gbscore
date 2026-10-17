import { PIANO, press, release, toggleEntry, togglePlayKeys } from './entry.ts';
import {
  clearTarget,
  copySelection,
  cutSelection,
  deleteSelection,
  duplicateSelection,
  lengths,
  makePattern,
  moveSelection,
  movePlacement,
  removePlacement,
  duplicatePlacement,
  transposePlacement,
  selectPlacement,
  paste,
  redo,
  save,
  select,
  selectAll,
  setHelp,
  setPanel,
  setPen,
  setStartRow,
  setView,
  shiftOctave,
  stepFlag,
  toggleLegato,
  togglePlay,
  undo,
  unsaved,
  useApp,
} from './store.ts';

// The app's keys. They go to the piano roll unless a text field, menu or dialog has focus.

/** Asks before leaving with unsaved edits. */
export function onLeave(e: BeforeUnloadEvent) {
  if (unsaved(useApp.getState().open)) e.preventDefault();
}

/** The keys, as the app lists them, in sections. Cmd on a Mac is Ctrl elsewhere. */
export const KEYS: { title: string; keys: [string, string][] }[] = [
  {
    title: 'Play',
    keys: [
      ['Space', 'Play or stop'],
      ['Home', 'Go to the start'],
      ['Click the ruler', 'Move the flag, where Play starts'],
      ['Drag along the ruler', 'Loop those beats; the Loop button turns looping off and on'],
      ['Right-click the ruler', "End the song there, or loop back to there; or set the song's length and loop by number"],
    ],
  },
  {
    title: 'Draw',
    keys: [
      ['Click', 'Draw a note; drag to set its length'],
      ['Alt-drag (Option)', "Paint notes of the pen's length along the drag, each at the pitch under the pointer"],
      ['Right-click, right-drag', 'Delete a note, or every note the drag passes over'],
      ['Click the effects or Song lane', "Edit that row's effect, or its tempo, pan and master volume; right-click clears"],
      ['Drag along the effects', 'Draw volume on the notes, and on the volumes already there'],
    ],
  },
  {
    title: 'Select and edit',
    keys: [
      ['Drag a note', 'Move the selection; drag its end to resize'],
      ['Shift-click, Shift-drag', 'Add to the selection'],
      ['Shift-click, Shift-drag the effects', 'Select effects apart from their notes; drag a selected one to move them'],
      ['↑ ↓', 'Transpose a semitone; with Shift, an octave'],
      ['← →', 'Move a row; with Shift, a bar'],
      ['Delete', 'Delete the selection'],
      ['L', 'Make the selected notes legato, or not: a new pitch without a new attack. Not on the wave lane, or with note entry or Play keys on'],
      ['Esc', 'Select nothing'],
      ['Cmd-A', 'Select all in the lane'],
      ['Cmd-C, Cmd-X', 'Copy, cut'],
      ['Cmd-V', 'Paste at the flag'],
      ['Cmd-D', 'Duplicate after the selection'],
      ['Cmd-Z, Cmd-Shift-Z', 'Undo, redo'],
      ['Cmd-S', 'Save'],
    ],
  },
  {
    title: 'Patterns',
    keys: [
      ['Cmd-G', 'Make a pattern of the beats the selected notes span'],
      ['In a pattern\'s band', 'Draw, select and edit its notes as any others; every place it plays changes'],
      ['Click a pattern in the strip', 'Select it; drag to move it by beats, Shift-drag by rows, Alt-drag to copy it; right-click removes it'],
      ['Drag its right edge', 'Play it longer, repeating, or shorter, cut short'],
      ['Click empty strip', 'Place the current pattern: the one last selected, made or picked in the Pattern menu'],
      ['With a pattern selected', '← → move it, ↑ ↓ transpose it, Delete removes it, Cmd-D places it again after itself'],
    ],
  },
  {
    title: 'Note entry and Play keys',
    keys: [
      ['M', 'Note entry on or off'],
      ['Shift-M', 'Play keys on or off'],
      ['A S D F G H J K', 'With note entry on: play white notes into the lane at the flag; with Play keys, only play them'],
      ['W E T Y U', 'Black notes'],
      ['Z X', 'Octave down, up; the bar beside the roll\'s keyboard shows where the keys are'],
      ['1 2 3 4 5', "With note entry on: note length, the toolbar's length picker's choices from the shortest"],
      ['← →', 'With note entry on: move the flag a note length, for a rest; with Shift, a bar'],
    ],
  },
  {
    title: 'Panels',
    keys: [
      ['I', 'Instrument panel: show or hide'],
      ['?', 'These keys'],
    ],
  },
];

const placing = () => !!useApp.getState().placement;

/** Keys go to the piano roll unless something that takes typing, or a menu, has focus, or a control has already
 * handled them (a menu button opens its menu on Space). */
export function onKey(e: KeyboardEvent) {
  if (e.defaultPrevented || takesKeys(e.target) || e.altKey) return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (e.metaKey || e.ctrlKey) {
    const action: Record<string, () => unknown> = {
      z: e.shiftKey ? redo : undo,
      y: redo,
      s: save,
      a: selectAll,
      c: copySelection,
      x: cutSelection,
      v: paste,
      d: placing() ? duplicatePlacement : duplicateSelection,
      g: makePattern,
    };
    const run = action[key];
    if (!run) return;
    e.preventDefault();
    if (!e.repeat || 'zyvd'.includes(key)) void run();
    return;
  }
  const bar = () => {
    const grid = useApp.getState().open?.song?.grid;
    return grid ? grid.rowsPerBeat * grid.beatsPerBar : 16;
  };
  const { entry, playKeys, octave, open, view } = useApp.getState();
  if ((entry || playKeys) && handleEntry(e, entry, octave, open?.song?.grid, view.expanded, bar)) {
    e.preventDefault();
    return;
  }
  const bars = (by: number) => (e.shiftKey ? by * bar() : by);
  const placementAction: Record<string, () => unknown> = {
    ArrowUp: () => transposePlacement(e.shiftKey ? 12 : 1),
    ArrowDown: () => transposePlacement(e.shiftKey ? -12 : -1),
    ArrowLeft: () => movePlacement(bars(-1)),
    ArrowRight: () => movePlacement(bars(1)),
    Delete: removePlacement,
    Backspace: removePlacement,
    Escape: () => selectPlacement(undefined),
  };
  if (placing() && placementAction[key]) {
    e.preventDefault();
    placementAction[key]();
    return;
  }
  const action: Record<string, () => void> = {
    ' ': () => !e.repeat && togglePlay(),
    Home: () => {
      setStartRow(0);
      setView({ scrollRow: 0 });
    },
    ArrowUp: () => moveSelection(0, e.shiftKey ? 12 : 1),
    ArrowDown: () => moveSelection(0, e.shiftKey ? -12 : -1),
    ArrowLeft: () => moveSelection(e.shiftKey ? -bar() : -1, 0),
    ArrowRight: () => moveSelection(e.shiftKey ? bar() : 1, 0),
    Delete: deleteSelection,
    Backspace: deleteSelection,
    Escape: () => {
      const { opened, selection, fxSelection } = useApp.getState();
      if (opened && !selection.length && !fxSelection.length) clearTarget();
      else select([]);
    },
    m: () => !e.repeat && (e.shiftKey ? togglePlayKeys() : toggleEntry()),
    l: () => !e.repeat && toggleLegato(),
    i: () => !e.repeat && setPanel(!useApp.getState().panel),
    '?': () => setHelp(true),
  };
  const run = action[key];
  if (!run) return;
  e.preventDefault();
  run();
}

/** Space plays and stops even when a button has focus, so the button mustn't also act on it: buttons act on Space
 * when it comes back up. */
export function onKeyUp(e: KeyboardEvent) {
  release(e.code);
  if (e.key === ' ' && !takesKeys(e.target)) e.preventDefault();
}

/** The keys note entry takes over, or with only Play keys on, the piano and octave keys. Returns whether it took
 * this one. */
function handleEntry(
  e: KeyboardEvent,
  entering: boolean,
  octave: number,
  grid: { rowsPerBeat: number; beatsPerBar: number } | undefined,
  lane: Parameters<typeof setPen>[0],
  bar: () => number,
): boolean {
  const semitone = PIANO[e.code];
  if (semitone !== undefined) {
    if (!e.repeat) press(e.code, octave + semitone);
    return true;
  }
  if (!entering) {
    const shift = ({ KeyZ: -1, KeyX: 1 } as Record<string, number>)[e.code];
    if (shift) shiftOctave(shift);
    return !!shift;
  }
  const digit = /^Digit([1-5])$/.exec(e.code)?.[1];
  if (digit && grid) {
    setPen(lane, { len: lengths(grid)[Number(digit) - 1]! });
    return true;
  }
  const action: Record<string, () => void> = {
    KeyZ: () => shiftOctave(-1),
    KeyX: () => shiftOctave(1),
    ArrowLeft: () => (e.shiftKey ? setStartRow(useApp.getState().startRow - bar()) : stepFlag(-1)),
    ArrowRight: () => (e.shiftKey ? setStartRow(useApp.getState().startRow + bar()) : stepFlag(1)),
  };
  const run = action[e.code];
  run?.();
  return !!run;
}

function takesKeys(target: EventTarget | null): boolean {
  const t = target as HTMLElement | null;
  return !!t?.closest?.('input, textarea, select, [contenteditable], [role="menu"], [role="dialog"]');
}
