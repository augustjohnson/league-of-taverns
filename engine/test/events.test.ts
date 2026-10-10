import { describe, it } from 'vitest';

// T2.3 to T2.5.
describe('events', () => {
  it.todo('parseLog(serializeEvent(e)) round-trips every event type');
  it.todo('replay rejects a gap in seq');
  it.todo('replay rejects a broken prev hash chain');
  it.todo('replaying the same log twice yields deeply equal state');
  it.todo('verifyResolutions reports no mismatch for an honest log and flags an edited d20');
  it.todo('derived state is invariant to edits in character chrome (chrome never reaches the engine)');
});
