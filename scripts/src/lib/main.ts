/**
 * Entry-point wrapper for scripts: run `main`, print errors, and set the exit
 * code CI relies on (0 ok, 1 validation failure, 2 crash or unimplemented).
 */
export class ValidationFailure extends Error {
  override name = 'ValidationFailure';
}

export function runMain(main: (argv: ReadonlyArray<string>) => Promise<void> | void): void {
  Promise.resolve()
    .then(() => main(process.argv.slice(2)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = error instanceof ValidationFailure ? 1 : 2;
    });
}
