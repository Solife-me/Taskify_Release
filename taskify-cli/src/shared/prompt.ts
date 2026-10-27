import { createInterface } from "node:readline";

/**
 * Asks one question on the terminal and returns the trimmed answer. Returns null, without asking,
 * when stdin isn't a terminal (a script, a pipe, an agent), and when input ends before an answer,
 * so a command never waits on input nobody will give it.
 */
export async function promptTerminal(question: string): Promise<string | null> {
  if (!process.stdin.isTTY) return null;
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer.trim());
    });
    rl.on("close", () => {
      if (!answered) resolve(null);
    });
  });
}
