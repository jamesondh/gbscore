import { parseSong } from '../core/compile.ts';
import type { Song } from '../core/schema.ts';
import { SONG_SUFFIX, songTitle } from './files.ts';

// Share links carry the song itself, compressed, in the address's fragment: `#v=1&name=…&song=…`. The browser
// doesn't send the fragment to the server, so links need no storage and no server's limit on addresses applies.
// A link is a snapshot that can't be taken back, so every format `v` the app has written must stay readable.

const VERSION = '1'; // the song is its JSON, deflated (zlib, whose checksum catches a garbled link), in base64url without padding

/** Over this many characters, some chat apps cut a link (Discord at 2,000). */
export const LONG_LINK = 2000;

/** A link to `base` that opens the song, named as the file `name` is. */
export async function shareLink(base: string, name: string, song: Song): Promise<string> {
  const data = toBase64Url(await pipe(new TextEncoder().encode(JSON.stringify(song)), new CompressionStream('deflate')));
  return `${base}#${new URLSearchParams({ v: VERSION, name: songTitle(name), song: data })}`;
}

const DAMAGED = "This share link is damaged: the song in it can't be read. It may have been cut short.";

const params = (hash: string) => new URLSearchParams(hash.replace(/^#/, ''));

/** Whether an address's fragment is a share link, even one cut short. */
export const isShare = (hash: string) => params(hash).has('v') || params(hash).has('song');

/** The song file in a share link's fragment, an error if it isn't a valid song, or undefined if it isn't a share
 * link. The song may still not compile, as a file's may not. */
export async function readShare(hash: string): Promise<{ name: string; text: string } | { error: string } | undefined> {
  if (!isShare(hash)) return undefined;
  const p = params(hash);
  const v = p.get('v');
  if (v !== VERSION && p.has('song')) return { error: `This share link is in a format this version of gbscore can't read (v=${v}).` };
  const data = p.get('song');
  if (v !== VERSION || !data) return { error: DAMAGED };
  let text: string;
  let json: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(await pipe(fromBase64Url(data), new DecompressionStream('deflate')));
    json = JSON.parse(text);
  } catch {
    return { error: DAMAGED };
  }
  const { errors } = parseSong(json);
  if (errors) return { error: `The song in this share link can't be opened: ${errors[0]?.message ?? "it isn't a valid song"}.` };
  return { name: (p.get('name') || 'shared') + SONG_SUFFIX, text };
}

async function pipe(bytes: Uint8Array<ArrayBuffer>, through: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(through)).arrayBuffer());
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/')); // throws on other characters
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
