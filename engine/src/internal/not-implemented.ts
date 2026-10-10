/**
 * Scaffold helper. Every stub throws this until its TODO.md task replaces it,
 * so a half-built pipeline fails loudly instead of returning plausible zeros.
 */
export class NotImplementedError extends Error {
  constructor(what: string, task: string) {
    super(`${what} is not implemented yet (TODO.md ${task})`);
    this.name = 'NotImplementedError';
  }
}

export function notImplemented(what: string, task: string): never {
  throw new NotImplementedError(what, task);
}
