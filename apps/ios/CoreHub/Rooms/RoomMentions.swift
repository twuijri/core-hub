// Mentions in the room composer. The hub never reads `@name` out of a person's words (contract
// decision §23): the phone sends the seats it means as structured `mentions`. So this is where a
// name typed after `@` becomes a seat — the suggestions while typing, the text a pick leaves, and
// the mentions a finished message carries. Pure, so the rules are tested without a screen.
import CoreHubClient
import Foundation

enum RoomMentions {
    struct Seat: Equatable, Identifiable {
        let id: String
        let name: String
    }

    /// The `@…` being typed at the end of the text: where it starts (a character offset) and
    /// what was typed so far.
    struct Query: Equatable {
        let start: Int
        let query: String
    }

    static func isWord(_ c: Character) -> Bool { c.isLetter || c.isNumber || c == "_" }

    /// The `@…` being typed at the end of `text`. An `@` inside a word (an e-mail address) is
    /// not a mention; a mention ends at a line break or at two spaces.
    static func query(_ text: String) -> Query? {
        let chars = Array(text)
        guard let at = chars.lastIndex(of: "@") else { return nil }
        if at > 0, isWord(chars[at - 1]) { return nil }
        let typed = String(chars[(at + 1)...])
        if typed.contains("\n") || typed.contains("  ") || typed.count > 60 { return nil }
        return Query(start: at, query: typed)
    }

    /// Seats whose name starts with (or, failing that, contains) what was typed, ignoring case.
    static func suggest(_ seats: [Seat], _ query: String) -> [Seat] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        if needle.isEmpty { return seats }
        let starts = seats.filter { $0.name.lowercased().hasPrefix(needle) }
        let contains = seats.filter { seat in !starts.contains(seat) && seat.name.lowercased().contains(needle) }
        return starts + contains
    }

    /// The text after picking `name` for the `@…` that starts at `start` (the end of the text).
    static func insert(_ text: String, start: Int, name: String) -> String {
        String(Array(text).prefix(start)) + "@\(name) "
    }

    /// The mentions a message carries: every seat whose `@name` stands in the text as a whole
    /// name, longest names first (so `@Code Reviewer` is not also `@Code`), and `@all` first when
    /// the room allows it.
    static func mentions(in text: String, seats: [Seat], allowAll: Bool) -> [Mention] {
        let chars = Array(text)
        let lower = Array(text.lowercased())
        var taken: [Range<Int>] = []
        var found: [Mention] = []
        func standsAlone(_ index: Int, _ length: Int) -> Bool {
            let before: Character? = index > 0 ? chars[index - 1] : nil
            let after: Character? = index + length < chars.count ? chars[index + length] : nil
            return !(before.map(isWord) ?? false) && !(after.map(isWord) ?? false)
        }
        func occurrences(of needle: [Character]) -> [Int] {
            guard !needle.isEmpty, needle.count <= lower.count else { return [] }
            var out: [Int] = []
            var i = 0
            while i + needle.count <= lower.count {
                if Array(lower[i..<(i + needle.count)]) == needle {
                    out.append(i)
                    i += needle.count
                } else {
                    i += 1
                }
            }
            return out
        }
        // Lower-casing keeps the character count for the scripts names are written in.
        guard lower.count == chars.count else { return [] }
        for seat in seats.sorted(by: { $0.name.count > $1.name.count }) {
            let needle = Array("@\(seat.name)".lowercased())
            for index in occurrences(of: needle) {
                let range = index..<(index + needle.count)
                if taken.contains(where: { $0.overlaps(range) }) || !standsAlone(index, needle.count) { continue }
                taken.append(range)
                if !found.contains(where: { $0.seatId == seat.id }) { found.append(Mention(kind: .seat, seatId: seat.id)) }
            }
        }
        if allowAll, occurrences(of: Array("@all")).contains(where: { standsAlone($0, 4) }) {
            found.insert(Mention(kind: .all), at: 0)
        }
        return found
    }
}
