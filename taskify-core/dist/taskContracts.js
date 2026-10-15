export const TASK_PRIORITY_MARKS = {
    1: "!",
    2: "!!",
    3: "!!!",
};
export function isExternalCalendarEvent(event) { return event.external === true; }
export function isListLikeBoard(board) {
    return !!board && (board.kind === "lists" || board.kind === "compound");
}
/** Ids every client gives the built-in Bible features (native `TaskifySnapshot`, `ScriptureMemory`). */
export const BIBLE_BOARD_ID = "bible-reading";
export const SCRIPTURE_MEMORY_SERIES_ID = "scripture-memory";
export const FASTING_REMINDER_SERIES_ID = "fasting-reminder";
