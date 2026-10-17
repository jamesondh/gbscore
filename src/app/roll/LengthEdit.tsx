import { useState } from 'react';
import { position, rowsPerBar } from '../../core/location.ts';
import type { Song } from '../../core/schema.ts';
import { Button } from '../components/ui/button.tsx';
import { Popover, PopoverAnchor, PopoverContent } from '../components/ui/popover.tsx';
import { setRange, useApp } from '../store.ts';
import { RULER, rowToX } from './geometry.ts';

// The popover a right-click on the ruler opens (docs/editor/, "Length and loop"): end the song or loop back at the
// beat clicked, or set the length in bars and rows and the loop's row by number.

export function LengthEdit({ row, onClose }: { row: number | undefined; onClose: () => void }) {
  const view = useApp((s) => s.view);
  const song = useApp((s) => s.open?.song);
  if (row === undefined || !song) return null;
  const done = (ok: boolean) => ok && onClose();
  return (
    <Popover open onOpenChange={(o) => !o && onClose()}>
      <PopoverAnchor asChild>
        <div className="pointer-events-none absolute size-0" style={{ left: rowToX(view, row), top: RULER }} />
      </PopoverAnchor>
      <PopoverContent
        side="bottom"
        className="w-80 space-y-3 text-xs"
        // A press on the roll closes this, or opens it at another row, itself.
        onPointerDownOutside={(e) => (e.target as Element).tagName === 'CANVAS' && e.preventDefault()}
      >
        <p className="font-medium">
          Song · {position(song.grid, row)} (row {row})
        </p>
        <div className="flex gap-1">
          <Button size="xs" variant="secondary" disabled={row === 0 || row === song.length} onClick={() => done(setRange(row))}>
            End the song here
          </Button>
          <Button size="xs" variant="secondary" disabled={row === song.loop} onClick={() => done(setRange(song.length, row))}>
            Loop back to here
          </Button>
        </div>
        <RangeForm key={`${song.length}:${song.loop}`} song={song} onDone={onClose} />
      </PopoverContent>
    </Popover>
  );
}

/** The length in bars and rows and the loop's row, set together by Enter or Set: set field by field, a length typed
 * a digit at a time would cut the song short on the way. */
function RangeForm({ song, onDone }: { song: Song; onDone: () => void }) {
  const bar = rowsPerBar(song.grid);
  const [bars, setBars] = useState(String(Math.floor(song.length / bar)));
  const [rows, setRows] = useState(String(song.length % bar));
  const [loop, setLoop] = useState(String(song.loop));
  const number = (text: string) => (text.trim() === '' ? 0 : Number(text));
  const length = number(bars) * bar + number(rows);
  const loopRow = number(loop);
  const field = 'w-14 rounded border bg-background px-1.5 py-0.5 tabular-nums';
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        // An unchanged loop goes back to the start if the new end is before it, as ending the song there does.
        if (setRange(length, loopRow === song.loop ? undefined : loopRow)) onDone();
      }}
    >
      <label className="flex items-center gap-1.5">
        <span className="w-12 text-muted-foreground">Length</span>
        <input aria-label="Length in bars" inputMode="numeric" className={field} value={bars} onChange={(e) => setBars(e.target.value)} />
        <span className="text-muted-foreground">bars</span>
        <input aria-label="And rows" inputMode="numeric" className={field} value={rows} onChange={(e) => setRows(e.target.value)} />
        <span className="text-muted-foreground">rows</span>
      </label>
      <label className="flex items-center gap-1.5">
        <span className="w-12 text-muted-foreground">Loop</span>
        <input aria-label="Loop back to row" inputMode="numeric" className={field} value={loop} onChange={(e) => setLoop(e.target.value)} />
        <span className="text-muted-foreground">
          row{Number.isInteger(loopRow) && loopRow >= 0 && `, at ${position(song.grid, loopRow)}`}
        </span>
      </label>
      <div className="flex items-center gap-2">
        <span className="flex-1 text-muted-foreground">
          {Number.isInteger(length) && `${length} rows`}
          {length < song.length && ", cutting what's past it"}
        </span>
        <Button type="submit" size="xs" disabled={length === song.length && loopRow === song.loop}>
          Set
        </Button>
      </div>
    </form>
  );
}
