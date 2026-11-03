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
/** The review series id older native builds used. */
export const LEGACY_SCRIPTURE_MEMORY_SERIES_ID = "scripture-memory-series";
/**
 * Series cutoffs ("delete this and future") never end the Scripture Memory review series: its
 * settings start and stop it. Its id is the same on every device and every day, so a cutoff
 * recorded once dropped every later review, and only on the devices that had seen it. Native
 * `ScriptureMemoryAlgorithm.seriesIgnoresCutoffs` matches.
 */
export function seriesIgnoresCutoffs(seriesId) {
    return seriesId === SCRIPTURE_MEMORY_SERIES_ID || seriesId === LEGACY_SCRIPTURE_MEMORY_SERIES_ID;
}
export const FASTING_REMINDER_SERIES_ID = "fasting-reminder";
