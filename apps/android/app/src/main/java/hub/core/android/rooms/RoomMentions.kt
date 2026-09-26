package hub.core.android.rooms

import hub.core.client.model.Mention

/**
 * Mentions in the room composer. The hub never reads `@name` out of a person's words (contract
 * decision §23): the phone sends the seats it means as structured `mentions`. So this is where a
 * name typed after `@` becomes a seat — the suggestions while typing, the text a pick leaves, and
 * the mentions a finished message carries. Pure, so the rules are tested without a screen.
 */
object RoomMentions {
    data class Seat(val id: String, val name: String)

    /** The `@…` being typed at the end of [text]: where it starts and what was typed so far. */
    data class Query(val start: Int, val query: String)

    private fun isWord(c: Char): Boolean = c.isLetterOrDigit() || c == '_'

    /**
     * The `@…` being typed just before [caret], when there is one. An `@` inside a word (an
     * e-mail address) is not a mention; a mention ends at a line break or two spaces.
     */
    fun query(text: String, caret: Int = text.length): Query? {
        val before = text.substring(0, caret.coerceIn(0, text.length))
        val at = before.lastIndexOf('@')
        if (at < 0) return null
        if (at > 0 && isWord(before[at - 1])) return null
        val typed = before.substring(at + 1)
        if ('\n' in typed || "  " in typed || typed.length > 60) return null
        return Query(at, typed)
    }

    /** Seats whose name starts with (or, failing that, contains) what was typed, ignoring case. */
    fun suggest(seats: List<Seat>, query: String): List<Seat> {
        val needle = query.trim().lowercase()
        if (needle.isEmpty()) return seats
        val starts = seats.filter { it.name.lowercase().startsWith(needle) }
        val contains = seats.filter { it !in starts && needle in it.name.lowercase() }
        return starts + contains
    }

    /** The text after picking [name] for the `@…` at [start], and where the caret goes. */
    fun insert(text: String, start: Int, caret: Int, name: String): Pair<String, Int> {
        val inserted = "@$name "
        val end = caret.coerceIn(start, text.length)
        return (text.substring(0, start) + inserted + text.substring(end)) to (start + inserted.length)
    }

    /**
     * The mentions a message carries: every seat whose `@name` stands in the text as a whole
     * name, longest names first (so `@Code Reviewer` is not also `@Code`), and `@all` first when
     * the room allows it.
     */
    fun mentionsIn(text: String, seats: List<Seat>, allowAll: Boolean): List<Mention> {
        val lower = text.lowercase()
        val taken = mutableListOf<IntRange>()
        val found = mutableListOf<Mention>()
        fun standsAlone(index: Int, length: Int): Boolean {
            val before = if (index > 0) text[index - 1] else null
            val after = text.getOrNull(index + length)
            return (before == null || !isWord(before)) && (after == null || !isWord(after))
        }
        for (seat in seats.sortedByDescending { it.name.length }) {
            val needle = "@${seat.name}".lowercase()
            var from = 0
            while (true) {
                val index = lower.indexOf(needle, from)
                if (index < 0) break
                from = index + needle.length
                val range = index until index + needle.length
                if (taken.any { it.first < range.last + 1 && range.first < it.last + 1 } || !standsAlone(index, needle.length)) continue
                taken += range
                if (found.none { it.seatId == seat.id }) found += Mention(kind = Mention.Kind.SEAT, seatId = seat.id)
            }
        }
        if (allowAll) {
            val match = Regex("@all(?![\\p{L}\\p{N}_])", RegexOption.IGNORE_CASE).find(text)
            if (match != null && standsAlone(match.range.first, 4)) found.add(0, Mention(kind = Mention.Kind.ALL, seatId = null))
        }
        return found
    }
}
