import { Boxes, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { expand } from '../core/patterns.ts';
import { LANE_KIND } from '../core/schema.ts';
import { patternOf } from './arrange.ts';
import { Button } from './components/ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './components/ui/dropdown-menu.tsx';
import { makePattern, makeUnique, removePlacement, renamePattern, setBrush, setPlacement, unpackPlacement, useApp } from './store.ts';

// Patterns in the editor (docs/patterns/, "The editor"): the toolbar's menu for making them and picking the one the
// strip places, and the bar for the selected placement.

/** Makes a pattern of the selected notes, or picks the current pattern, the one clicking the strip places. */
export function PatternMenu() {
  const song = useApp((s) => s.open?.song);
  const lane = useApp((s) => s.view.expanded);
  const selected = useApp((s) => s.selection.length > 0);
  const current = useApp((s) => s.brush);
  if (!song) return null;
  const kind = LANE_KIND[lane];
  const patterns = (song.patterns ?? []).filter((p) => p.kind === kind);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="Pattern" title="Patterns (Cmd-G makes one)">
          <Boxes />
          <span className="hidden xl:inline">Pattern</span>
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-96 w-auto" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DropdownMenuItem disabled={!selected} onSelect={makePattern}>
          Make a pattern of the selected notes (Cmd-G)
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Click the strip above the notes to place</DropdownMenuLabel>
        {patterns.length ? (
          patterns.map((p) => (
            <DropdownMenuCheckboxItem key={p.id} checked={p.id === current} onSelect={() => setBrush(p.id)}>
              {p.id}
              <span className="ml-auto pl-4 text-xs text-muted-foreground">{p.length} rows</span>
            </DropdownMenuCheckboxItem>
          ))
        ) : (
          <DropdownMenuItem disabled>No {kind} patterns yet</DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The selected placement's pattern, transpose, repeat and instrument, and what can be done with it. */
export function PatternBar() {
  const song = useApp((s) => s.open?.song);
  const placement = useApp((s) => s.placement);
  const id = placement?.pattern;
  if (!song || !placement || !id || !patternOf(song, id)) return null;
  const places = expand(song).occurrences.filter((o) => o.pattern.id === id).length;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-sky-950/30 px-3 py-1.5 text-xs">
      <span className="text-muted-foreground">Pattern</span>
      <Name id={id} />
      <span className="text-muted-foreground">
        plays in {places} place{places === 1 ? '' : 's'}
      </span>
      <NumberField label="Transpose" value={placement.transpose ?? 0} min={-71} max={71} onChange={(transpose) => setPlacement({ transpose })} />
      <NumberField label="Repeat" value={placement.repeat ?? 1} min={1} max={song.length} onChange={(repeat) => setPlacement({ repeat })} />
      <label className="flex items-center gap-1.5">
        <span className="text-muted-foreground">Instrument</span>
        <select
          aria-label="Instrument"
          className="rounded border bg-background px-1 py-0.5"
          value={placement.inst ?? ''}
          onChange={(e) => setPlacement({ inst: e.target.value ? Number(e.target.value) : undefined })}
        >
          <option value="">pattern's own</option>
          {song.instruments[patternOf(song, id)!.kind].map((i) => (
            <option key={i.id} value={i.id}>
              {i.id}
              {i.name ? ` ${i.name}` : ''}
            </option>
          ))}
        </select>
      </label>
      <div className="ml-auto flex gap-1">
        <Button size="xs" variant="ghost" onClick={makeUnique} title="Copy the pattern for this place only">
          Make unique
        </Button>
        <Button size="xs" variant="ghost" onClick={unpackPlacement} title="Turn this place into notes">
          Unpack
        </Button>
        <Button size="xs" variant="ghost" onClick={removePlacement} title="Take it out of the lane (Delete)">
          Remove
        </Button>
      </div>
    </div>
  );
}

/** The pattern's name, renamed when Enter is pressed or the field is left; Esc puts it back. */
function Name({ id }: { id: string }) {
  const [text, setText] = useState(id);
  const cancelled = useRef(false);
  useEffect(() => setText(id), [id]);
  const commit = () => {
    if (cancelled.current) cancelled.current = false;
    else if (text !== id && !renamePattern(id, text)) setText(id);
  };
  return (
    <input
      aria-label="Pattern name"
      className="w-36 rounded border bg-background px-1.5 py-0.5 font-medium"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          cancelled.current = true; // the blur that follows mustn't rename it
          setText(id);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function NumberField(props: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-muted-foreground">{props.label}</span>
      <input
        type="number"
        aria-label={props.label}
        className="w-14 rounded border bg-background px-1.5 py-0.5"
        value={props.value}
        min={props.min}
        max={props.max}
        onChange={(e) => {
          const v = e.target.valueAsNumber;
          if (Number.isInteger(v) && v >= props.min && v <= props.max && v !== props.value) props.onChange(v);
        }}
      />
    </label>
  );
}
