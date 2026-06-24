// paths.js — where Agency persists its regenerable caches + roster.
// A published / `npx` install runs from a read-only or ephemeral package dir,
// so state lives in the user's home (~/.agency) by default. Override with
// AGENCY_DATA_DIR (e.g. `AGENCY_DATA_DIR=./data` to keep it repo-local in dev).
// ponytail: one rule, no dev/prod heuristic — set the env var if you want local.

import path from 'node:path';
import os from 'node:os';

export const DATA_DIR = process.env.AGENCY_DATA_DIR
  ? path.resolve(process.env.AGENCY_DATA_DIR)
  : path.join(os.homedir(), '.agency');
