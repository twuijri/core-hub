package hub.core.android.chat

import android.icu.text.DateFormat
import hub.core.android.Digits
import java.time.OffsetDateTime
import java.time.ZonedDateTime
import java.time.temporal.ChronoUnit
import java.util.Date
import java.util.Locale

/**
 * When a message was said, shown under it after a light tap (tester feedback from the Google Play
 * closed test, 2026-10-05: «when did this message arrive?»). The rule is the web's `messageTime`
 * and iOS's MessageTime.swift: the clock time today, «Yesterday» and the time yesterday, the
 * short date and the time before that (the year only when it is not this year). Words in the
 * reading language, digits always Latin (DECISIONS §113).
 */
object MessageTime {
    fun text(
        time: OffsetDateTime,
        now: ZonedDateTime = ZonedDateTime.now(),
        locale: Locale = Locale.getDefault(),
        yesterday: (String) -> String,
    ): String {
        val local = time.atZoneSameInstant(now.zone)
        val days = ChronoUnit.DAYS.between(local.toLocalDate(), now.toLocalDate())
        val clock = format("jmm", local, locale)
        return when {
            days <= 0L -> clock
            days == 1L -> yesterday(clock)
            else -> format(if (local.year == now.year) "dMMMjmm" else "dMMMyjmm", local, locale)
        }
    }

    private fun format(skeleton: String, at: ZonedDateTime, locale: Locale): String {
        val formatter = DateFormat.getInstanceForSkeleton(skeleton, Digits.latin(locale))
        formatter.timeZone = android.icu.util.TimeZone.getTimeZone(java.util.TimeZone.getTimeZone(at.zone).id)
        return formatter.format(Date.from(at.toInstant()))
    }
}
