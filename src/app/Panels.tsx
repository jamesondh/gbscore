import { ClipboardPaste, Copy, FileMusic, FolderOpen, Redo2, Trash2, Undo2 } from 'lucide-react';
import { BANK_SIZE } from '../core/compile.ts';
import { formatError } from '../core/location.ts';
import { LANES, type LaneName } from '../core/schema.ts';
import { Button } from './components/ui/button.tsx';
import { canOpenFolders, PROBE_FILE } from './files.ts';
import {
  chooseFile,
  chooseFolder,
  copySelection,
  deleteSelection,
  endProbe,
  keepMine,
  loadTheirs,
  paste,
  redo,
  regainAccess,
  removePlacement,
  reopenRemembered,
  setStartRow,
  setView,
  startProbe,
  undo,
  useApp,
} from './store.ts';

/** Shown until a folder or a song is open. */
export function Welcome() {
  const remembered = useApp((s) => s.remembered);
  const message = useApp((s) => s.message);
  const folders = canOpenFolders();
  return (
    <Centered>
      <p className="text-muted-foreground">
        {folders ? 'Open the folder your .gbscore.json files are in, or one song.' : 'Open a .gbscore.json file.'}
      </p>
      <div className="flex gap-2">
        {folders && remembered && <Button onClick={() => void reopenRemembered()}>Reopen {remembered.name}</Button>}
        {folders && (
          <Button variant={remembered ? 'outline' : 'default'} onClick={() => void chooseFolder()}>
            <FolderOpen />
            Open a folder…
          </Button>
        )}
        <Button variant={folders ? 'outline' : 'default'} onClick={() => void chooseFile()}>
          <FileMusic />
          Open a song file…
        </Button>
      </div>
      {!folders && (
        <p className="max-w-md text-center text-xs text-muted-foreground">
          This browser can't open folders, so saving downloads the song, and the app won't see changes made to it
          outside the app. Chrome and Edge can. In Brave, turn on <code>brave://flags/#file-system-access-api</code>.
        </p>
      )}
      {message?.error && <p className="text-destructive text-xs">{message.text}</p>}
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-1 flex-col items-center justify-center gap-4">{children}</div>;
}

/** The song's errors. Clicking one goes to where it is. */
export function Errors() {
  const open = useApp((s) => s.open);
  if (!open?.errors.length) return null;
  const grid = open.song?.grid;
  const go = (lane: string | undefined, row: number | undefined) => {
    if (row === undefined) return;
    const { view } = useApp.getState();
    setView({
      scrollRow: Math.max(0, row - 8),
      ...((LANES as readonly string[]).includes(lane ?? '') && { expanded: lane as LaneName }),
    });
    setStartRow(row);
  };
  return (
    <div className="max-h-40 shrink-0 overflow-y-auto border-t bg-card px-3 py-2 text-xs select-text">
      <p className="mb-1 font-medium text-destructive">
        {open.playable
          ? `This version doesn't compile, so Play plays the last one that did.`
          : `The song doesn't compile, so it can't play.`}
      </p>
      <ul className="space-y-0.5">
        {open.errors.map((e, i) => (
          <li key={i}>
            <button
              className="text-left hover:underline disabled:no-underline"
              disabled={e.row === undefined}
              onClick={() => go(e.lane, e.row)}
            >
              {formatError(grid, e)}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The folder check: does a file the app writes reach the disk, and do changes made outside the app reach it? */
export function FolderCheck() {
  const probe = useApp((s) => s.probe);
  const folder = useApp((s) => s.folder);
  if (!probe) return null;
  const same = probe.reads === probe.wrote;
  return (
    <div className="shrink-0 space-y-2 border-b bg-card px-3 py-2 text-xs select-text">
      <p className="font-medium">Folder check</p>
      <p>
        The app wrote <code>{PROBE_FILE}</code> in {folder?.name}:{' '}
        <code className="text-muted-foreground">{probe.wrote}</code>
      </p>
      <p>
        It reads there now{probe.readAt && ` (at ${new Date(probe.readAt).toLocaleTimeString()})`}:{' '}
        <code className={same ? 'text-muted-foreground' : 'text-[#7cf29a]'}>{probe.reads ?? '…'}</code>
      </p>
      {probe.error && <p className="text-destructive">{probe.error}</p>}
      <p className="text-muted-foreground">
        Check the file says the same outside the app (on the other machine, if the folder is a network share), then
        change it there, once in place and once by replacing it. Each change should show up here within a couple of
        seconds.
      </p>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => void startProbe()}>
          Write it again
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void endProbe()}>
          Done (deletes the file)
        </Button>
      </div>
    </div>
  );
}

/** The file changed on disk while there were unsaved edits. Either choice keeps the other version as a copy. */
export function Conflict() {
  const open = useApp((s) => s.open);
  if (!open?.conflict) return null;
  return (
    <div className="flex shrink-0 items-center gap-3 border-b bg-card px-3 py-2 text-xs">
      <p className="flex-1">
        <span className="font-medium">{open.name} changed on disk</span>, and you have unsaved edits. Which do you
        want to keep editing? The other is written next to it as a copy.
      </p>
      <Button size="sm" onClick={() => void keepMine()}>
        Keep mine
      </Button>
      <Button size="sm" variant="outline" onClick={() => void loadTheirs()}>
        Load the one on disk
      </Button>
    </div>
  );
}

/** On a touch screen, with no keys or right-click, the edit keys as buttons: each calls what its key does
 * (keys.ts). A strip of its own, above the status line, so it hides none of the roll; a mouse never sees it. */
export function EditBar() {
  const past = useApp((s) => !!s.open?.past.length);
  const future = useApp((s) => !!s.open?.future.length);
  const selected = useApp((s) => s.selection.length > 0 || s.fxSelection.length > 0);
  const placement = useApp((s) => !!s.placement);
  const button = (label: string, icon: React.ReactNode, run: () => unknown, disabled = false) => (
    <Button
      size="icon-lg"
      variant="ghost"
      className="size-10"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => void run()}
    >
      {icon}
    </Button>
  );
  return (
    <div className="hidden h-11 shrink-0 items-center justify-center gap-2 border-t pointer-coarse:flex">
      {button('Undo (Cmd-Z)', <Undo2 />, undo, !past)}
      {button('Redo (Cmd-Shift-Z)', <Redo2 />, redo, !future)}
      {button('Delete (Delete)', <Trash2 />, placement ? removePlacement : deleteSelection, !selected && !placement)}
      {button('Copy (Cmd-C)', <Copy />, copySelection, !selected)}
      {button('Paste at the flag (Cmd-V)', <ClipboardPaste />, paste)}
    </div>
  );
}

/** The line under everything: what the app has to say, and how playback is going. Always there, so the roll
 * doesn't jump when a message comes or goes. */
export function StatusLine() {
  const message = useApp((s) => s.message);
  const seekMs = useApp((s) => s.seekMs);
  const underruns = useApp((s) => s.underruns);
  const reloadedAt = useApp((s) => s.reloadedAt);
  const lost = useApp((s) => s.lostAccess);
  const folder = useApp((s) => s.folder);
  const open = useApp((s) => s.open);
  const size = open && !open.errors.length ? open.playable?.size : undefined;
  const parts: string[] = [];
  if (seekMs !== undefined) parts.push(`started in ${seekMs} ms`);
  if (underruns) parts.push(`${underruns} audio gaps`);
  if (reloadedAt) parts.push(`reloaded from disk at ${new Date(reloadedAt).toLocaleTimeString()}`);
  return (
    <div className="flex h-7 shrink-0 items-center gap-3 border-t px-3 text-xs select-text">
      {lost && (
        <Button size="xs" variant="destructive" className="max-w-96 shrink-0" onClick={() => void regainAccess()}>
          <span className="truncate">Allow access to {folder?.name || 'the folder'} again</span>
        </Button>
      )}
      {message && (
        <span className={message.error ? 'min-w-0 truncate text-destructive' : 'min-w-0 truncate text-muted-foreground'}>
          {message.text}
        </span>
      )}
      {parts.length > 0 && <span className="ml-auto shrink-0 text-muted-foreground">{parts.join(' · ')}</span>}
      {size !== undefined && (
        <span
          title="The compiled song's size in the game's ROM"
          className={`shrink-0 ${parts.length ? '' : 'ml-auto '}${size > BANK_SIZE ? 'text-destructive' : 'text-muted-foreground'}`}
        >
          {size.toLocaleString('en-US')} bytes{size > BANK_SIZE && `, over one ${BANK_SIZE / 1024} KB bank`}
        </span>
      )}
    </div>
  );
}
