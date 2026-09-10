import { csvAdapter } from './csv.js';
import { jsonAdapter } from './json.js';
import type { Adapter, ImportSourceType } from '../types.js';

export { csvAdapter } from './csv.js';
export { jsonAdapter } from './json.js';

export const ADAPTERS: Record<ImportSourceType, Adapter> = {
  csv: csvAdapter,
  json: jsonAdapter,
  // Provider adapters are registered here as they land.
  workast: jsonAdapter,
  kanban: jsonAdapter,
};

export function adapterFor(sourceType: ImportSourceType): Adapter {
  const adapter = ADAPTERS[sourceType];
  if (!adapter) throw new Error(`no adapter for source type: ${sourceType}`);
  return adapter;
}
