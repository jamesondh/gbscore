// The folder the app works in, through the File System Access API (Chrome and Edge). The folder handle is kept in
// IndexedDB so the app can offer to reopen it on the next visit. Browsers without the API (Brave unless a flag is
// on, Firefox, Safari) can open one song with a file picker and save it as a download.

type Mode = { mode: 'read' | 'readwrite' };

declare global {
  interface Window {
    showDirectoryPicker(options?: { id?: string } & Mode): Promise<FileSystemDirectoryHandle>;
  }
  interface FileSystemHandle {
    queryPermission(options?: Mode): Promise<PermissionState>;
    requestPermission(options?: Mode): Promise<PermissionState>;
  }
}

const READWRITE: Mode = { mode: 'readwrite' };
export const SONG_SUFFIX = '.gbscore.json';
export const PROBE_FILE = 'gbscore-probe.txt';

/** A song's name without its file extension. */
export const songTitle = (file: string) => (file.endsWith(SONG_SUFFIX) ? file.slice(0, -SONG_SUFFIX.length) : file.replace(/\.json$/, ''));

export function canOpenFolders(): boolean {
  return typeof window.showDirectoryPicker === 'function';
}

/** Asks for a folder. Returns undefined if the person cancels. */
export async function pickFolder(): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    const dir = await window.showDirectoryPicker({ id: 'gbscore', ...READWRITE });
    await remember(dir);
    return dir;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return undefined;
    throw e;
  }
}

/** The folder from last time, and whether it can be used without asking again. */
export async function lastFolder(): Promise<{ dir: FileSystemDirectoryHandle; granted: boolean } | undefined> {
  const dir = await recall();
  if (!dir) return undefined;
  return { dir, granted: (await dir.queryPermission(READWRITE)) === 'granted' };
}

/** Asks again for permission to a remembered folder. Call from a click. */
export async function reopen(dir: FileSystemDirectoryHandle): Promise<boolean> {
  return (await dir.requestPermission(READWRITE)) === 'granted';
}

/** The songs in the folder, by file name. Skips the `._` files macOS can leave on network shares. */
export async function listSongs(dir: FileSystemDirectoryHandle): Promise<string[]> {
  const names: string[] = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'file' && name.endsWith(SONG_SUFFIX) && !name.startsWith('._')) names.push(name);
  }
  return names.sort((a, b) => a.localeCompare(b));
}

export async function readText(dir: FileSystemDirectoryHandle, name: string): Promise<string> {
  const file = await (await dir.getFileHandle(name)).getFile();
  return file.text();
}

export async function exists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'NotFoundError') return false;
    throw e;
  }
}

/** Writes a file, creating it if needed. Chrome writes to a temporary file and moves it into place on close, so
 * the write has happened only once this returns. */
export async function writeText(dir: FileSystemDirectoryHandle, name: string, text: string): Promise<void> {
  const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
  try {
    await writable.write(text);
  } catch (e) {
    await writable.abort();
    throw e;
  }
  await writable.close();
}

/** Asks for one song file. Returns undefined if the person cancels. */
export function pickFile(): Promise<File | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => resolve(input.files?.[0]);
    input.oncancel = () => resolve(undefined);
    input.click();
  });
}

/** Saves text or bytes as a download, where the browser puts downloads. */
export function download(name: string, data: string | Uint8Array<ArrayBuffer>, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** A short description of a failed file operation. */
export function describeError(e: unknown): string {
  if (e instanceof DOMException) {
    if (e.name === 'NotFoundError') return "it isn't there any more";
    if (e.name === 'NotAllowedError') return 'permission to the folder has lapsed';
    return `${e.name}: ${e.message}`;
  }
  return e instanceof Error ? e.message : String(e);
}

const DB = 'gbscore';
const STORE = 'folders';

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

async function remember(dir: FileSystemDirectoryHandle): Promise<void> {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(dir, 'last');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function recall(): Promise<FileSystemDirectoryHandle | undefined> {
  const db = await database();
  const dir = await new Promise<FileSystemDirectoryHandle | undefined>((resolve, reject) => {
    const get = db.transaction(STORE).objectStore(STORE).get('last');
    get.onsuccess = () => resolve(get.result as FileSystemDirectoryHandle | undefined);
    get.onerror = () => reject(get.error);
  });
  db.close();
  return dir;
}
