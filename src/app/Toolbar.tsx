import {
  ChevronDown,
  Eye,
  FileMusic,
  Keyboard,
  Music,
  Piano,
  Play,
  Plus,
  Repeat,
  Square,
  Volume2,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { position } from '../core/location.ts';
import { LANE_KIND, type Song } from '../core/schema.ts';
import { toggleEntry, togglePlayKeys } from './entry.ts';
import { Swatch } from './Instruments.tsx';
import { MAX_INSTRUMENTS } from './instruments.ts';
import { KEYS } from './keys.ts';
import { PatternMenu } from './Patterns.tsx';
import { SongSettings } from './SongSettings.tsx';
import { Button } from './components/ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './components/ui/dropdown-menu.tsx';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from './components/ui/dialog.tsx';
import { canOpenFolders, songTitle } from './files.ts';
import logo from './logo.svg';
import { bestRoot, ROOTS, SCALES, type ScaleKind, scaleName } from './scales.ts';
import {
  addInstrument,
  chooseDemo,
  chooseFile,
  chooseFolder,
  engine,
  exportC,
  exportWav,
  lengths,
  newSong,
  openSong,
  save,
  setGhosts,
  setHelp,
  setHear,
  setScale,
  share,
  setPanel,
  setPen,
  startProbe,
  toggleLooping,
  togglePlay,
  unsaved,
  useApp,
} from './store.ts';

/** The commit the app was built from, short, or empty when the build couldn't tell (vite.config.ts). */
declare const __COMMIT__: string;

const REPO = 'https://github.com/jamesondh/gbscore';

/** Asks before something would throw away unsaved edits. */
export function mayDiscard(): boolean {
  const open = useApp.getState().open;
  return !unsaved(open) || confirm(`${open!.name} has unsaved edits. Throw them away?`);
}

export function Toolbar() {
  const playing = useApp((s) => s.playing);
  const canPlay = !!useApp((s) => s.open?.playable);

  return (
    <div role="toolbar" aria-label="Toolbar" className="flex shrink-0 flex-wrap items-center gap-x-2 border-b px-2 max-sm:[&_button]:px-1.5 lg:gap-x-1">
      <Group>
        <About />
        <SongMenu />
      </Group>

      <Divider />
      <Group>
        <Button
          size="sm"
          variant={playing ? 'secondary' : 'default'}
          disabled={!canPlay && !playing}
          onClick={togglePlay}
          title={playing ? 'Stop (Space)' : 'Play (Space)'}
        >
          {playing ? <Square /> : <Play />}
          {playing ? 'Stop' : 'Play'}
        </Button>
        <LoopToggle />
        <Position />
      </Group>

      <Divider />
      <Group>
        <InstrumentPicker />
        <LengthPicker />
        <PatternMenu />
      </Group>

      <Divider />
      <Group>
        <Entry />
      </Group>

      <Divider />
      <Group>
        <ViewMenu />
      </Group>
      <Group className="ml-auto">
        <Keys />
      </Group>
    </div>
  );
}

/** One of the toolbar's groups, which wraps onto the next row whole on a narrow screen. */
function Group({ className = '', children }: { className?: string; children: ReactNode }) {
  return <div className={`flex h-10.75 shrink-0 items-center gap-1 ${className}`}>{children}</div>;
}

/** Between the toolbar's groups, on one row from 1024 px up. Below that the groups may wrap, and a gap divides them
 * instead, so no divider is left at a row's start or end. */
function Divider() {
  return <div className="mx-1 hidden h-5 w-px shrink-0 bg-border lg:block" />;
}

/** The song's name: saves it (or downloads it, with no folder open), copies a link to it, opens its settings,
 * exports it as a WAV or GBDK C, starts a new song, and opens a song file, a folder (listing its songs) or the demo song. */
function SongMenu() {
  const [settings, setSettings] = useState(false);
  const folder = useApp((s) => s.folder);
  const songs = useApp((s) => s.songs);
  const open = useApp((s) => s.open);
  const dirty = unsaved(open);
  const title = open ? songTitle(open.name) : 'No song';
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" title={folder?.name ? `${title} in ${folder.name}` : title} className="font-medium">
            <FileMusic />
            <span className="max-w-20 truncate sm:max-w-32 xl:max-w-48">{title}</span>
            {dirty && <span title="Unsaved edits" aria-label="Unsaved edits" className="size-1.5 shrink-0 rounded-full bg-primary" />}
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-96 w-56" onCloseAutoFocus={(e) => e.preventDefault()}>
          <DropdownMenuItem disabled={folder ? !dirty : !open?.song || open.broken} onSelect={() => void save()}>
            {folder ? 'Save' : 'Download'}
            <DropdownMenuShortcut>Cmd-S</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!open?.song || open.broken} onSelect={() => void share()}>
            Copy share link
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!open?.song} onSelect={() => setSettings(true)}>
            Song settings…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!open?.song} onSelect={() => void exportWav()}>
            Export WAV
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!open?.song} onSelect={() => exportC()}>
            Export GBDK C
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => mayDiscard() && void newSong()}>New song</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => mayDiscard() && void chooseFile()}>Open a song file…</DropdownMenuItem>
          <DropdownMenuItem disabled={!canOpenFolders()} onSelect={() => mayDiscard() && void chooseFolder()}>
            {folder ? 'Open another folder…' : 'Open a folder…'}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => mayDiscard() && void chooseDemo()}>Open the demo song</DropdownMenuItem>
          {folder && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Songs in {folder.name || 'the folder'}</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={open?.name} onValueChange={(name) => mayDiscard() && void openSong(name)}>
                {songs.map((name) => (
                  <DropdownMenuRadioItem key={name} value={name}>
                    {songTitle(name)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void startProbe()}>Check folder access</DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <SongSettings open={settings} onOpenChange={setSettings} />
    </>
  );
}

/** The instrument new notes in the expanded lane get. Clicking a note picks its instrument too. New instrument
 * adds one of the lane's kind, picks it, and opens the panel to edit it, so a song without any can get one. */
function InstrumentPicker() {
  const song = useApp((s) => s.open?.song);
  const lane = useApp((s) => s.view.expanded);
  const pen = useApp((s) => s.pen[lane]);
  if (!song) return null;
  const instruments = song.instruments[LANE_KIND[lane]];
  const label = (i: { id: number; name?: string }) => `${i.id}${i.name ? ` ${i.name}` : ''}`;
  const chosen = instruments.find((i) => i.id === pen.inst);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Instrument: ${chosen ? label(chosen) : 'none'}`}
          title="Instrument for new notes"
        >
          {chosen && <Swatch inst={chosen.id} />}
          <span className="max-w-8 truncate sm:max-w-24 xl:max-w-36">{chosen ? label(chosen) : instruments.length ? `${pen.inst} (none)` : 'none'}</span>
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-96 w-auto" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DropdownMenuLabel>{LANE_KIND[lane]} instruments</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={String(pen.inst)} onValueChange={(v) => setPen(lane, { inst: Number(v) })}>
          {instruments.map((i) => (
            <DropdownMenuRadioItem key={i.id} value={String(i.id)}>
              <Swatch inst={i.id} />
              {label(i)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {instruments.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem
          disabled={instruments.length >= MAX_INSTRUMENTS}
          onSelect={() => {
            addInstrument();
            setPanel(true);
          }}
        >
          <Plus />
          New instrument
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Turns looping the rows dragged along the ruler on or off. */
function LoopToggle() {
  const loop = useApp((s) => s.loop);
  const looping = useApp((s) => s.looping);
  return (
    <Button
      size="icon-sm"
      variant={looping ? 'secondary' : 'ghost'}
      aria-pressed={looping}
      aria-label="Loop"
      disabled={!loop}
      title={loop ? 'Loop' : 'Loop (drag along the ruler to choose one)'}
      onClick={toggleLooping}
    >
      <Repeat />
    </Button>
  );
}

/** Settings you change once a session: ghost notes, the instrument panel and the scale shaded. */
function ViewMenu() {
  const panel = useApp((s) => s.panel);
  const ghosts = useApp((s) => s.ghosts);
  const song = useApp((s) => s.open?.song);
  const scale = useApp((s) => (s.open ? s.scales[s.open.name] : undefined));
  const setKind = (v: string) =>
    song &&
    setScale(v === 'off' ? undefined : { kind: v as ScaleKind, root: scale?.root ?? bestRoot(song, v as ScaleKind) });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="View" title="View">
          <Eye />
          <span className="hidden xl:inline">View</span>
          <ChevronDown className="max-sm:hidden" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DropdownMenuCheckboxItem checked={ghosts} onCheckedChange={(on) => setGhosts(on)}>
          Ghost notes
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={panel} onCheckedChange={(on) => setPanel(on)}>
          Instrument panel
          <DropdownMenuShortcut>I</DropdownMenuShortcut>
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={!song}>Scale: {scale ? scaleName(scale) : 'off'}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={scale?.kind ?? 'off'} onValueChange={setKind}>
              <DropdownMenuRadioItem value="off">Off</DropdownMenuRadioItem>
              {Object.entries(SCALES).map(([kind, { name }]) => (
                <DropdownMenuRadioItem key={kind} value={kind}>
                  {name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            {scale && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>Root: {ROOTS[scale.root]}</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuRadioGroup
                      value={String(scale.root)}
                      onValueChange={(v) => setScale({ ...scale, root: Number(v) })}
                    >
                      {ROOTS.map((name, root) => (
                        <DropdownMenuRadioItem key={name} value={String(root)}>
                          {name}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </>
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A length in rows, in bars or beats where it's whole ones. */
function lengthName(rows: number, grid: Song['grid']): string {
  const plural = (n: number | string, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  const bar = grid.rowsPerBeat * grid.beatsPerBar;
  if (rows % bar === 0) return plural(rows / bar, 'bar');
  if (rows % grid.rowsPerBeat === 0) return plural(rows / grid.rowsPerBeat, 'beat');
  if (rows * 2 === grid.rowsPerBeat) return '½ beat';
  return plural(rows, 'row');
}

/** The length new notes get in the expanded lane, drawn, painted or entered. Clicking a note picks its length too. */
function LengthPicker() {
  const grid = useApp((s) => s.open?.song?.grid);
  const lane = useApp((s) => s.view.expanded);
  const len = useApp((s) => s.pen[lane].len);
  if (!grid) return null;
  const choices = lengths(grid);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={`Note length: ${lengthName(len, grid)}`}
          title="Note length (1 to 5 with note entry on)">
          <span className="whitespace-nowrap">{lengthName(len, grid)}</span>
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-40" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DropdownMenuRadioGroup value={String(len)} onValueChange={(v) => setPen(lane, { len: Number(v) })}>
          {[...new Set(choices)].map((rows) => (
            <DropdownMenuRadioItem key={rows} value={String(rows)}>
              {lengthName(rows, grid)}
              <DropdownMenuShortcut>{choices.indexOf(rows) + 1}</DropdownMenuShortcut>
            </DropdownMenuRadioItem>
          ))}
          {!choices.includes(len) && <DropdownMenuRadioItem value={String(len)}>{lengthName(len, grid)}</DropdownMenuRadioItem>}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Note entry and Play keys, and whether notes are heard as you edit. The roll's keyboard shows what the keys play. */
function Entry() {
  const entry = useApp((s) => s.entry);
  const playKeys = useApp((s) => s.playKeys);
  const hear = useApp((s) => s.hear);
  return (
    <>
      <Button
        size="icon-sm"
        variant={entry ? 'secondary' : 'ghost'}
        aria-pressed={entry}
        aria-label="Note entry"
        onClick={toggleEntry}
        title="Note entry (M)"
      >
        <Music />
      </Button>
      <Button
        size="icon-sm"
        variant={playKeys ? 'secondary' : 'ghost'}
        aria-pressed={playKeys}
        aria-label="Play keys"
        onClick={togglePlayKeys}
        title="Play keys (Shift-M)"
      >
        <Piano />
      </Button>
      <Button
        size="icon-sm"
        variant={hear ? 'secondary' : 'ghost'}
        aria-pressed={hear}
        aria-label="Hear notes"
        title="Hear notes as you edit"
        onClick={() => setHear(!hear)}
      >
        <Volume2 />
      </Button>
    </>
  );
}

/** The list of keys, in a dialog (?). */
/** The logo, which opens what gbscore is and who made it. */
function About() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label="About gbscore" title="About gbscore">
          <img src={logo} alt="" className="size-6" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md text-xs" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DialogTitle className="flex items-center gap-2">
          <img src={logo} alt="" className="size-6" />
          gbscore
        </DialogTitle>
        <DialogDescription className="text-xs text-foreground">
          A Game Boy music editor for people who'd rather use a piano roll than a tracker. Songs play on an emulator as
          you write them, and the same compiler turns them into hUGEDriver data for your own game.
        </DialogDescription>
        <p>
          Songs are plain JSON files, one per song, that diff well and that you can also edit by hand. Chrome and Edge
          can open a folder of songs; other browsers open one song file at a time, and saving downloads it. The command
          line also imports hUGETracker <code>.uge</code> songs and exports GBDK C.
        </p>
        <p>Playback runs hUGEDriver, by SuperDisk and contributors, on the binjgb emulator, by Ben Smith.</p>
        <div className="flex items-baseline gap-1.5 text-muted-foreground">
          <span>Made by Jameson Hodge</span>·
          <a href={REPO} target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-2">
            Source on GitHub
          </a>
          ·
          <a href={`${REPO}/blob/main/LICENSE`} target="_blank" rel="noreferrer" className="underline underline-offset-2">
            MIT license
          </a>
          {__COMMIT__ && (
            <a
              href={`${REPO}/commit/${__COMMIT__}`}
              target="_blank"
              rel="noreferrer"
              title="The build's commit"
              className="ml-auto font-mono text-[0.7rem] hover:underline"
            >
              {__COMMIT__}
            </a>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Keys() {
  const help = useApp((s) => s.help);
  return (
    <Dialog open={help} onOpenChange={setHelp}>
      <DialogTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label="Keys" title="Keys (?)">
          <Keyboard />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] max-w-5xl overflow-y-auto" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DialogTitle>Keys</DialogTitle>
        <DialogDescription className="sr-only">The keys and mouse actions the editor takes.</DialogDescription>
        <div className="gap-8 text-xs md:columns-2 xl:columns-3">
          {KEYS.map(({ title, keys }) => (
            <section key={title} className="mb-5 break-inside-avoid">
              <h3 className="mb-1.5 font-medium">{title}</h3>
              <table className="w-full">
                <tbody>
                  {keys.map(([key, what]) => (
                    <tr key={key + what} className="align-top">
                      <td className="w-28 py-0.5 pr-3 font-mono text-muted-foreground">{key}</td>
                      <td className="py-0.5">{what}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** bar.beat.row of the playhead while playing, or of the start point. Updated every frame without re-rendering. */
function Position() {
  const span = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = requestAnimationFrame(update);
      const s = useApp.getState();
      const song = s.open?.song;
      if (!song || !span.current) return;
      const row = (s.playing ? engine().now()?.row : undefined) ?? s.startRow;
      const text = position(song.grid, row);
      if (span.current.textContent !== text) span.current.textContent = text;
    };
    update();
    return () => cancelAnimationFrame(frame);
  }, []);
  return <span ref={span} aria-label="Position" className="w-16 font-mono text-xs tabular-nums text-muted-foreground" />;
}
