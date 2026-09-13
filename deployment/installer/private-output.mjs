import { openSync, writeSync, closeSync } from 'node:fs';
import { OnboardingError } from './google-client.mjs';

/** Keep pairing codes out of redirected installer output. */
export function privateTerminalOutput(line) {
  let terminal;
  try {
    terminal = openSync('/dev/tty', 'w');
    writeSync(terminal, `${line}\n`);
  } catch {
    throw new OnboardingError(
      'Open an interactive terminal and resume the installer to receive the private pairing code.',
    );
  } finally {
    if (terminal !== undefined) closeSync(terminal);
  }
}
