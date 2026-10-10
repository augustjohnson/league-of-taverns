/**
 * Events: the schema, reducers and replay for the append-only league log.
 * See ./types.ts for the event union and docs/schema.md § Events.
 */
export type * from './types';
export type * from './state';
export { InvalidEventError, applyEvent, initialState } from './reducers';
export { lineHash, parseLog, replay, serializeEvent, verifyResolutions } from './replay';
export type { ResolutionMismatch } from './replay';
