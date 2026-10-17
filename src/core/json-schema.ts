import { z } from 'zod';
import { songSchema } from './schema.ts';

/** The song schema as JSON Schema, for editors and other tools. Defaults make fields optional, as when reading. */
export function jsonSchema(): string {
  const schema = z.toJSONSchema(songSchema, { io: 'input', target: 'draft-2020-12' });
  return JSON.stringify({ ...schema, $id: 'gbscore.schema.json', title: 'gbscore song' }, null, 2) + '\n';
}
