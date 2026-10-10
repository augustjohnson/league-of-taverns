import { describe, it } from 'vitest';

// T5.2.
describe('mission validator', () => {
  it.todo('accepts seasons/season-01/missions/candidates/example-drowned-toll.yaml');
  it.todo('rejects an edge that does not increase rank');
  it.todo('rejects a check node without both pass and fail (or always) edges');
  it.todo('rejects a path from start to an end with zero checks');
  it.todo('rejects an encounter ref missing from the pinned snapshot');
  it.todo('rejects a DC outside the season band');
  it.todo('reports every violation, not just the first');
});
