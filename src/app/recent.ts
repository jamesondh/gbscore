/** Local copies, like the last standalone song: no file handles or access to the original files. */
export interface RecentFile {
  name: string;
  text: string;
}

const KEY = 'gbscore.recentFiles';
const LIMIT = 10;

export function readRecents(): RecentFile[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((file): file is RecentFile =>
      !!file && typeof file === 'object' && typeof file.name === 'string' && typeof file.text === 'string',
    ).filter((file, i, all) => all.findIndex((other) => other.name === file.name) === i).slice(0, LIMIT);
  } catch {
    return [];
  }
}

/** Storage may be full or disabled. Keep the list usable for this session either way. */
export function writeRecents(files: RecentFile[]): void {
  try {
    if (files.length) localStorage.setItem(KEY, JSON.stringify(files));
    else localStorage.removeItem(KEY);
  } catch {
    // Do not restore stale history next time after failing to persist the new list.
    try { localStorage.removeItem(KEY); } catch { /* Storage is disabled. */ }
  }
}

export function withRecent(files: RecentFile[], file: RecentFile): RecentFile[] {
  return [file, ...files.filter((other) => other.name !== file.name)].slice(0, LIMIT);
}
