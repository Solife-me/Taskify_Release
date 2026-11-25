/**
 * The small formatting helpers the panel's views use.
 */
import { formatDueLabel, formatBytes, isOverdue, shortFileName, boardName } from "../src/ui/format.ts";

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name} ${detail}`); }
}

const now = new Date(2026, 9, 21, 12, 0, 0); // 21 October 2026, local time.

console.log("a due date reads the way a person would say it");
{
  const at = (days, hours = 0) => {
    const date = new Date(now);
    date.setDate(date.getDate() + days);
    date.setHours(hours);
    return date.toISOString();
  };
  check("today", formatDueLabel(at(0, 18), now) === "Today", formatDueLabel(at(0, 18), now));
  check("tomorrow", formatDueLabel(at(1), now) === "Tomorrow", formatDueLabel(at(1), now));
  check("yesterday", formatDueLabel(at(-1), now) === "Yesterday", formatDueLabel(at(-1), now));
  check("a weekday soon", /Friday|Saturday|Sunday|Monday|Tuesday|Wednesday|Thursday/.test(formatDueLabel(at(3), now)), formatDueLabel(at(3), now));
  check("further out is a date", /[A-Z][a-z]{2} \d+/.test(formatDueLabel(at(40), now)), formatDueLabel(at(40), now));
  check("no date reads as nothing", formatDueLabel(undefined, now) === "");
  check("a broken date reads as nothing", formatDueLabel("not a date", now) === "");
}

console.log("overdue is only true for an unfinished task that is past its date");
{
  const past = new Date(now.getTime() - 86_400_000).toISOString();
  const future = new Date(now.getTime() + 86_400_000).toISOString();
  check("a past task is overdue", isOverdue({ dueISO: past, completed: false }, now));
  check("a future task is not", !isOverdue({ dueISO: future, completed: false }, now));
  check("a completed task is not", !isOverdue({ dueISO: past, completed: true }, now));
  check("a task with no date is not", !isOverdue({ completed: false }, now));
}

console.log("file names are shortened without losing the extension");
{
  check("a short name is kept", shortFileName("page.md") === "page.md");
  const long = "a-very-long-file-name-that-goes-on-and-on-and-on-for-a-while.md";
  const short = shortFileName(long, 20);
  check("a long name is shortened", short.length <= 20, String(short.length));
  check("the extension is kept", short.endsWith(".md"), short);
  check("it is marked as shortened", short.includes("…"), short);
}

console.log("sizes read plainly");
{
  check("bytes", formatBytes(512) === "512 B");
  check("kilobytes", formatBytes(2048) === "2 KB");
  check("megabytes", formatBytes(3 * 1024 * 1024) === "3.0 MB");
  check("nothing", formatBytes(0) === "");
}

console.log("a board is named by its id");
{
  const boards = [{ id: "a", name: "Work" }, { id: "b", name: "Home" }];
  check("it finds the name", boardName("a", boards) === "Work");
  check("an unknown board is not named", boardName("z", boards) === "No board");
}

console.log(failures === 0 ? "\nAll format tests passed." : `\n${failures} format test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
