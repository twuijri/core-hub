// When a message was said, shown under it after a light tap (tester feedback from the Google Play
// closed test, 2026-10-05: «when did this message arrive?»). The rule is the web's `messageTime`
// and Android's MessageTime.kt: the clock time today, «Yesterday» and the time yesterday, the
// short date and the time before that (the year only when it is not this year). Words in the
// reading language, digits always Latin (`AppLanguage.locale`, DECISIONS §113).
import Foundation

enum MessageTime {
    /// The text under a message created at `date`, read at `now`.
    static func text(
        _ date: Date,
        now: Date = Date(),
        locale: Locale,
        calendar: Calendar = .current,
        yesterday: (String) -> String
    ) -> String {
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.setLocalizedDateFormatFromTemplate("jmm")
        let time = formatter.string(from: date)
        let days = calendar.dateComponents(
            [.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)
        ).day ?? 0
        if days <= 0 { return time }
        if days == 1 { return yesterday(time) }
        let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
        formatter.setLocalizedDateFormatFromTemplate(sameYear ? "dMMMjmm" : "dMMMyjmm")
        return formatter.string(from: date)
    }

    /// The same, in the app's language and its words.
    static func text(_ date: Date, l10n: L10n, now: Date = Date()) -> String {
        text(date, now: now, locale: l10n.language.locale) { l10n("chat.time_yesterday", ["time": $0]) }
    }
}
