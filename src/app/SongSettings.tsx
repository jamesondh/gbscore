import { useState } from 'react';
import { position } from '../core/location.ts';
import type { Song } from '../core/schema.ts';
import { TICK_RATE } from '../play/player.ts';
import { Button } from './components/ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './components/ui/dialog.tsx';
import { bpm } from './effects.ts';
import { grooveError, setInfo, useApp } from './store.ts';

// The song settings dialog, from the song menu (docs/editor/, "Song settings"): the title, artist and comment the
// file keeps for people, the grid the roll, the ruler and the note lengths follow, and the groove the song plays at
// until its first tempo change.

export function SongSettings({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const song = useApp((s) => s.open?.song);
  return (
    <Dialog open={open && !!song} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md text-xs" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DialogTitle>Song settings</DialogTitle>
        <DialogDescription className="text-xs">
          The grid is for display only and never changes the sound; the groove does. Right-click the ruler to set the
          length and loop.
        </DialogDescription>
        {/* Fresh fields each time it opens, from the song as it is then. */}
        {open && song && <Fields song={song} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

/** Every field, set together by Set or Enter as one step of undo. */
function Fields({ song, onDone }: { song: Song; onDone: () => void }) {
  const [title, setTitle] = useState(song.title ?? '');
  const [artist, setArtist] = useState(song.artist ?? '');
  const [comment, setComment] = useState(song.comment ?? '');
  const [rowsPerBeat, setRowsPerBeat] = useState(String(song.grid.rowsPerBeat));
  const [beatsPerBar, setBeatsPerBar] = useState(String(song.grid.beatsPerBar));
  const [groove, setGroove] = useState(song.groove.map(String));
  const grid = { rowsPerBeat: Number(rowsPerBeat), beatsPerBar: Number(beatsPerBar) };
  const steps = groove.map(Number) as Song['groove'];
  const field = 'rounded border bg-background px-1.5 py-1';
  const number = `${field} w-14 tabular-nums`;
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (setInfo({ title, artist, comment, grid, groove: steps })) onDone();
      }}
    >
      <div className="grid grid-cols-[5.5rem_1fr] items-center gap-x-3 gap-y-2">
        <label htmlFor="song-title" className="text-muted-foreground">Title</label>
        <input id="song-title" className={field} value={title} onChange={(e) => setTitle(e.target.value)} />
        <label htmlFor="song-artist" className="text-muted-foreground">Artist</label>
        <input id="song-artist" className={field} value={artist} onChange={(e) => setArtist(e.target.value)} />
        <label htmlFor="song-comment" className="self-start pt-1 text-muted-foreground">Comment</label>
        <textarea id="song-comment" rows={4} className={`${field} resize-y`} value={comment} onChange={(e) => setComment(e.target.value)} />
        <span className="text-muted-foreground">Grid</span>
        <span className="flex items-center gap-1.5">
          <input aria-label="Rows per beat" inputMode="numeric" className={number} value={rowsPerBeat} onChange={(e) => setRowsPerBeat(e.target.value)} />
          <span className="text-muted-foreground">rows a beat,</span>
          <input aria-label="Beats per bar" inputMode="numeric" className={number} value={beatsPerBar} onChange={(e) => setBeatsPerBar(e.target.value)} />
          <span className="text-muted-foreground">beats a bar</span>
        </span>
        <span className="text-muted-foreground">Groove</span>
        <span className="flex items-center gap-1.5">
          {groove.map((t, i) => (
            <input
              key={i}
              aria-label={`Groove step ${i + 1}`}
              inputMode="numeric"
              className={`${field} w-11 tabular-nums`}
              value={t}
              onChange={(e) => setGroove(groove.with(i, e.target.value))}
            />
          ))}
          <span className="text-muted-foreground">ticks a row</span>
        </span>
        <GrooveNote song={song} groove={steps} rowsPerBeat={grid.rowsPerBeat} />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm">
          Set
        </Button>
      </div>
    </form>
  );
}

/** Under the groove: the BPM it averages to and how long it lasts, or why it can't be set. */
function GrooveNote({ song, groove, rowsPerBeat }: { song: Song; groove: Song['groove']; rowsPerBeat: number }) {
  const why = groove.some((n, i) => n !== song.groove[i]) && grooveError(song, groove);
  if (why) return <p className="col-start-2 text-destructive">Can't: {why}.</p>;
  const perBeat = Number.isInteger(rowsPerBeat) && rowsPerBeat >= 1 ? rowsPerBeat : song.grid.rowsPerBeat;
  const beats = bpm(groove.reduce((a, b) => a + b) / 4, perBeat, TICK_RATE);
  const tempo = Math.min(...song.global.filter((g) => g.tempo !== undefined).map((g) => g.row));
  const until =
    tempo === Infinity ? 'through the song, which has no tempo changes' : `until the first tempo change, at ${position(song.grid, tempo)}`;
  return (
    <p className="col-start-2 text-muted-foreground">
      Cycling every 4 rows: {beats.toFixed(beats < 100 ? 1 : 0)} BPM on average at {perBeat} rows a beat, {until}.
    </p>
  );
}
