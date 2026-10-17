import type { Song } from '../core/schema.ts';
import { editSong, endGesture, songGestureTo, startGesture, tryInstrument, useApp } from './store.ts';

// The instrument panel's controls, and how their changes reach the song.

let holding = false;

/** A pointer pressed on a control: until it's let go, or the window loses focus, changes from the control are one
 * gesture, a single step of undo that compiles when it ends. A slider then gives up focus, so the arrow keys go
 * back to the notes. */
export function hold(e: React.PointerEvent<Element>) {
  if (!startGesture()) return;
  holding = true;
  const el = e.currentTarget;
  const events = ['pointerup', 'pointercancel', 'blur'] as const;
  const up = () => {
    holding = false;
    endGesture();
    if (el instanceof HTMLInputElement) el.blur();
    for (const name of events) window.removeEventListener(name, up);
  };
  for (const name of events) window.addEventListener(name, up);
}

let hearing: ReturnType<typeof setTimeout> | undefined;

/** Changes the song, as part of a gesture if a control is held and the gesture is still under way, and hears the
 * instrument once the changes stop, unless another lane or song is showing by then. */
export function apply(change: (song: Song) => Song | string, inst: number) {
  const inGesture =
    holding &&
    songGestureTo((song) => {
      const r = change(song);
      return typeof r === 'string' ? song : r;
    });
  if (!inGesture && !editSong(change)) return;
  const { view, open } = useApp.getState();
  clearTimeout(hearing);
  hearing = setTimeout(() => {
    const now = useApp.getState();
    if (now.view.expanded === view.expanded && now.open?.name === open?.name) tryInstrument(inst, false);
  }, 150);
}

export function Label({ children }: { children: React.ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

export function Choice<T extends string | number>({
  label,
  options,
  names,
  value,
  onChange,
}: {
  label: string;
  options: readonly T[];
  names?: Partial<Record<T, string>>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex w-fit gap-0.5 rounded-md bg-background p-0.5">
      {options.map((o) => (
        <button
          key={o}
          role="radio"
          aria-checked={o === value}
          onClick={() => o !== value && onChange(o)}
          className="rounded px-2 py-0.5 text-muted-foreground hover:text-foreground aria-checked:bg-secondary aria-checked:text-foreground"
        >
          {names?.[o] ?? o}
        </button>
      ))}
    </div>
  );
}

export function Range({
  label,
  caption,
  min,
  max,
  value,
  disabled,
  onChange,
  text = String(value),
}: {
  label: string;
  caption?: string; // shown before the slider, where the row's label doesn't say what it is
  min: number;
  max: number;
  value: number;
  disabled?: boolean;
  onChange: (value: number) => void;
  text?: string;
}) {
  return (
    <span className="flex items-center gap-2">
      {caption && <span className="text-muted-foreground">{caption}</span>}
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onPointerDown={hold}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-28 accent-primary disabled:opacity-40"
      />
      <span className="min-w-6 tabular-nums text-muted-foreground">{text}</span>
    </span>
  );
}

