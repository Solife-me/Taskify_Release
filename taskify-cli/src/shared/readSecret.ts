import * as readline from "readline";

/**
 * A secret for a command that may also accept it as an argument.
 *
 * Arguments are saved in shell history and are visible to other local users in the process
 * list, so the preferred forms are: no value (a hidden prompt on a terminal), or `-` (read from
 * standard input, e.g. `pass show taskify | taskify config set nsec -`). A literal value still
 * works, with a warning.
 */
export async function readSecret(provided: string | undefined, prompt: string): Promise<string> {
  if (provided !== undefined && provided !== "-") {
    process.stderr.write(
      "\u001b[33mWarning: secrets passed as arguments are saved in shell history. " +
        "Omit the value to be prompted, or pass - to read it from standard input.\u001b[0m\n",
    );
    return provided.trim();
  }
  if (provided === "-" || !process.stdin.isTTY) return (await readAllStdin()).trim();
  return (await promptHidden(prompt)).trim();
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    let muted = false;
    // Echo the prompt, then nothing the user types.
    (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = (text: string) => {
      if (!muted) process.stderr.write(text);
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stderr.write("\n");
      resolve(answer);
    });
    muted = true;
  });
}
