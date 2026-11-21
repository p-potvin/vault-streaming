import Foundation

public struct SubtitleCue: Identifiable, Hashable {
    public let id: Int
    public let startTime: Double
    public let endTime: Double
    public let text: String
}

/// Parses WebVTT (`.vtt`) text served by `/api/media?path=...` into timed cues.
public enum WebVTTParser {
    public static func parse(_ raw: String) -> [SubtitleCue] {
        var text = raw
        if text.hasPrefix("\u{FEFF}") {
            text.removeFirst()
        }
        let normalized = text
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")

        let blocks = normalized.components(separatedBy: "\n\n")
        var cues: [SubtitleCue] = []
        var nextId = 0

        for block in blocks {
            let lines = block
                .split(separator: "\n", omittingEmptySubsequences: false)
                .map { String($0) }
                .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }

            guard !lines.isEmpty else { continue }
            let firstUpper = lines[0].trimmingCharacters(in: .whitespaces).uppercased()
            if firstUpper.hasPrefix("WEBVTT") || firstUpper.hasPrefix("NOTE")
                || firstUpper.hasPrefix("STYLE") || firstUpper.hasPrefix("REGION") {
                continue
            }

            guard let timingIndex = lines.firstIndex(where: { $0.contains("-->") }) else {
                continue
            }

            guard let (start, end) = parseTimingLine(lines[timingIndex]) else {
                continue
            }

            let bodyLines = lines.dropFirst(timingIndex + 1)
            let joined = bodyLines.joined(separator: "\n")
            let cleaned = stripFormatting(joined).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !cleaned.isEmpty else { continue }

            cues.append(SubtitleCue(id: nextId, startTime: start, endTime: end, text: cleaned))
            nextId += 1
        }

        return cues.sorted { $0.startTime < $1.startTime }
    }

    /// Returns the cue text active at `playbackTime + syncOffset` (note positive offset shifts cues earlier/later:
    /// matching `js/player/subtitles.js` where `offset` shifts cue times by `+offset`, so at video time `t` we test `t - offset`).
    public static func activeCue(in cues: [SubtitleCue], at playbackTime: Double, offset: Double = 0) -> String? {
        guard !cues.isEmpty else { return nil }
        let queryTime = playbackTime - offset
        let matching = cues.filter { queryTime >= $0.startTime && queryTime <= $0.endTime }
        guard !matching.isEmpty else { return nil }
        return matching.map(\.text).joined(separator: "\n")
    }

    private static func parseTimingLine(_ line: String) -> (Double, Double)? {
        let parts = line.components(separatedBy: "-->")
        guard parts.count >= 2 else { return nil }
        let startToken = parts[0].trimmingCharacters(in: .whitespaces)
        let rightTokens = parts[1].trimmingCharacters(in: .whitespaces).split(whereSeparator: \.isWhitespace)
        guard let endTokenSub = rightTokens.first else { return nil }

        guard let start = parseTimestamp(startToken),
              let end = parseTimestamp(String(endTokenSub)) else {
            return nil
        }
        return (start, max(start, end))
    }

    private static func parseTimestamp(_ token: String) -> Double? {
        let normalized = token.replacingOccurrences(of: ",", with: ".")
        let components = normalized.split(separator: ":").map(String.init)
        switch components.count {
        case 3:
            guard let h = Double(components[0]),
                  let m = Double(components[1]),
                  let s = Double(components[2]) else { return nil }
            return h * 3600 + m * 60 + s
        case 2:
            guard let m = Double(components[0]),
                  let s = Double(components[1]) else { return nil }
            return m * 60 + s
        default:
            return nil
        }
    }

    private static func stripFormatting(_ raw: String) -> String {
        let withoutTags = raw.replacingOccurrences(of: #"<[^>]+>"#, with: "", options: .regularExpression)
        return withoutTags
            .replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&#39;", with: "'")
            .replacingOccurrences(of: "&apos;", with: "'")
            .replacingOccurrences(of: "&nbsp;", with: " ")
    }
}
