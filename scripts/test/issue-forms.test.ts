import { describe, it } from 'vitest';

// T11.1, T8.2.
describe('issue forms', () => {
  it.todo('parses each form in .github/ISSUE_TEMPLATE from a GitHub-rendered body');
  it.todo('treats "_No response_" as an empty optional field');
  it.todo('never reads the tavern from the form body');
});

describe('chrome coverage', () => {
  it.todo('the example chrome fully covers the example mission');
  it.todo('flags a battle missing its lose beat');
  it.todo('flags {actor} on a battle node');
  it.todo('flags a literal "DC 14" in a beat');
});
