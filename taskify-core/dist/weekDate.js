import { startOfDay } from "./dateTime.js";
function addDaysLocal(date, days) {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
}
export function startOfWeekLocal(date, weekStart) {
    const sd = startOfDay(date);
    const current = sd.getDay();
    const ws = weekStart === 1 || weekStart === 6 ? weekStart : 0;
    let diff = current - ws;
    if (diff < 0)
        diff += 7;
    return startOfDay(addDaysLocal(sd, -diff));
}
export function isoForWeekdayLocal(target, options = {}) {
    const { base = new Date(), weekStart = 0 } = options;
    const anchor = startOfWeekLocal(base, weekStart);
    const anchorDay = anchor.getDay();
    const offset = ((target - anchorDay) % 7 + 7) % 7;
    const day = startOfDay(addDaysLocal(anchor, offset));
    return day.toISOString();
}
