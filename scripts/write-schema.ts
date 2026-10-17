import { writeFileSync } from 'node:fs';
import { jsonSchema } from '../src/core/json-schema.ts';

// Writes schema/gbscore.schema.json from src/core/schema.ts. test/format.test.ts fails when it's out of date.
writeFileSync(new URL('../schema/gbscore.schema.json', import.meta.url), jsonSchema());
