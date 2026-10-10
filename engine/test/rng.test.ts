import { describe, it } from 'vitest';

// T2.1, T2.2. Replace each todo with a real test when the stub is implemented.
describe('rng', () => {
  it.todo('cyrb128 + sfc32 match published golden values for fixed inputs');
  it.todo('rngFor(seed, key) is stable across calls and processes');
  it.todo('different keys under one seed produce uncorrelated streams');
  it.todo('rollD20 is uniform on 1..20 (chi-square over 100k rolls)');
  it.todo('weekSeed formats (season, week, tavern[, salt]) canonically');
});
