import Foundation

/// Ported from `taskify-pwa/src/domains/calendar/holidayUtils.ts` — a fixed weekday each week,
/// or a deterministic pseudo-random spread of days per month (seeded, so recomputation is stable).
public enum FastingRemindersMode: String, Codable, Sendable {
    case weekday
    case random
}

public enum FastingReminders {
    /// Computes the due dates (each at local midnight) for one calendar month.
    /// - Parameters:
    ///   - monthIndex: 0-based month (0 = January), matching the PWA's JS `Date` convention.
    ///   - weekday: 0 = Sunday ... 6 = Saturday, matching JS `Date.getDay()`.
    public static func dueDates(
        year: Int,
        monthIndex: Int,
        mode: FastingRemindersMode,
        weekday: Int,
        perMonth: Int,
        seed: String,
        calendar: Calendar = .current
    ) -> [Date] {
        let totalDays = daysInMonth(year: year, monthIndex: monthIndex, calendar: calendar)
        guard totalDays > 0 else { return [] }
        let clampedPerMonth = max(1, perMonth)

        if mode == .weekday {
            var result: [Date] = []
            for day in 1...totalDays {
                guard let date = calendar.date(from: DateComponents(year: year, month: monthIndex + 1, day: day)) else {
                    continue
                }
                // Calendar's `.weekday` component is 1 = Sunday ... 7 = Saturday.
                let jsWeekday = calendar.component(.weekday, from: date) - 1
                guard jsWeekday == weekday else { continue }
                result.append(calendar.startOfDay(for: date))
                if result.count >= clampedPerMonth { break }
            }
            return result
        }

        var candidates = Array(1...totalDays)
        let monthKey = String(format: "%04d-%02d", year, monthIndex + 1)
        let rng = mulberry32(seed: hashStringToUint32("\(seed)|\(monthKey)"))
        shuffle(&candidates, rng: rng)
        let picked = candidates.prefix(min(clampedPerMonth, totalDays)).sorted()
        return picked.compactMap { day in
            calendar.date(from: DateComponents(year: year, month: monthIndex + 1, day: day))
                .map { calendar.startOfDay(for: $0) }
        }
    }

    private static func daysInMonth(year: Int, monthIndex: Int, calendar: Calendar) -> Int {
        guard let date = calendar.date(from: DateComponents(year: year, month: monthIndex + 1, day: 1)),
              let range = calendar.range(of: .day, in: .month, for: date) else {
            return 30
        }
        return range.count
    }

    /// FNV-1a-style string hash, ported bit-for-bit from `hashStringToUint32`.
    static func hashStringToUint32(_ input: String) -> UInt32 {
        var hash: UInt32 = 2166136261
        for unit in input.utf16 {
            hash ^= UInt32(unit)
            hash = hash &* 16777619
        }
        return hash
    }

    /// Mulberry32 PRNG, ported bit-for-bit from `mulberry32`.
    static func mulberry32(seed: UInt32) -> () -> Double {
        var t = seed
        return {
            t = t &+ 0x6D2B79F5
            var x = t
            x = (x ^ (x >> 15)) &* (x | 1)
            x ^= x &+ ((x ^ (x >> 7)) &* (x | 61))
            return Double(x ^ (x >> 14)) / 4294967296.0
        }
    }

    /// Fisher-Yates shuffle driven by the given RNG, ported from `shuffleInPlace`.
    static func shuffle(_ array: inout [Int], rng: () -> Double) {
        guard array.count > 1 else { return }
        var i = array.count - 1
        while i > 0 {
            let j = Int((rng() * Double(i + 1)).rounded(.down))
            if j != i { array.swapAt(i, j) }
            i -= 1
        }
    }
}
