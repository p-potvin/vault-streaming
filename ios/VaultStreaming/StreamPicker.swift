import Foundation

/// Ports the web client's stream ranking, filtering, and play-queue rules (`js/streaming/ranking.js`)
/// along with `rd-stream-torrent` + `deepbrid-stream` resolution (`js/streaming/rd-flow.js`).
public enum StreamPicker {
    public static let playQueueMax = 8
    public static let playQueueBudgetSeconds: TimeInterval = 120

    private static let badReleaseRegex = try! NSRegularExpression(
        pattern: #"\b(camrip|hdcam|hdts|hdtc|telesync|telecine|screener|workprint|r5|dvdscr|predvd)\b|\b(?:hd|hq|ts|uhd|new)?cam(?:rip|hd)?\b|\bts(?:rip)?\b"#,
        options: [.caseInsensitive]
    )

    private static let promoRegex = try! NSRegularExpression(
        pattern: #"\b(teaser|trailer|sample|featurette|promo|clip|behind[\s.\-]the[\s.\-]scenes|bts)\b"#,
        options: [.caseInsensitive]
    )

    private static let threeDRegex = try! NSRegularExpression(
        pattern: #"\b(3d|hsbs|sbs|half-?sbs|h-?sbs|hou|h-?ou)\b"#,
        options: [.caseInsensitive]
    )

    private static let foreignDubRegex = try! NSRegularExpression(
        pattern: #"\b(rus|russian|ita|italian|spanish|espanol|castellano|latino|hindi|tamil|telugu|korean|kor|german|deu|ger|dublado|dubbed|hun|hungarian|pol|polish|ukr|ukrainian|cz|czech|tur|turkish)\b"#,
        options: [.caseInsensitive]
    )

    private static func matches(_ regex: NSRegularExpression, in text: String) -> Bool {
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return regex.firstMatch(in: text, options: [], range: range) != nil
    }

    private static func matchesPattern(_ pattern: String, in text: String) -> Bool {
        text.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
    }

    public static func parseSizeBytes(_ sizeStr: String?) -> Double {
        guard let sizeStr, !sizeStr.isEmpty else { return 0 }
        let pattern = #"([\d.]+)\s*(B|KB|MB|GB|TB)"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return 0
        }
        let range = NSRange(sizeStr.startIndex..<sizeStr.endIndex, in: sizeStr)
        guard let m = regex.firstMatch(in: sizeStr, options: [], range: range),
              m.numberOfRanges >= 3,
              let r1 = Range(m.range(at: 1), in: sizeStr),
              let r2 = Range(m.range(at: 2), in: sizeStr),
              let num = Double(sizeStr[r1]) else {
            return 0
        }
        let unit = sizeStr[r2].uppercased()
        let mult: Double
        switch unit {
        case "TB": mult = pow(1024, 4)
        case "GB": mult = pow(1024, 3)
        case "MB": mult = pow(1024, 2)
        case "KB": mult = 1024
        default: mult = 1
        }
        return num * mult
    }

    private static func detectQualityRank(_ text: String) -> Int {
        if matchesPattern(#"\bremux\b"#, in: text) { return 5 }
        if matchesPattern(#"\b(2160p?|4k|uhd)\b"#, in: text) { return 4 }
        if matchesPattern(#"\b1080p?\b"#, in: text) { return 3 }
        if matchesPattern(#"\b720p?\b"#, in: text) { return 2 }
        if matchesPattern(#"\b480p?\b"#, in: text) { return 1 }
        return 0
    }

    public static func isRejectedForAutoPlay(_ torrent: TorrentStream) -> Bool {
        let text = "\(torrent.quality ?? "") \(torrent.desc ?? "") \(torrent.type ?? "") \(torrent.name)".lowercased()
        return matches(badReleaseRegex, in: text)
            || matches(threeDRegex, in: text)
            || matches(promoRegex, in: text)
    }

    public static func scoreTorrent(_ torrent: TorrentStream, preferredLang: String = AppConfig.preferredStreamLang) -> Double {
        var score: Double = 0
        let text = "\(torrent.quality ?? "") \(torrent.desc ?? "") \(torrent.type ?? "") \(torrent.name)".lowercased()

        // Cache priority
        if torrent.cached == true {
            score += 10000
        } else if torrent.isCached {
            score += 1000
        }

        // Bad / 3D / Promo penalties
        if matches(badReleaseRegex, in: text) { score -= 100000 }
        if matches(threeDRegex, in: text) { score -= 50000 }
        if matches(promoRegex, in: text) { score -= 20000 }

        let bytes = parseSizeBytes(torrent.size)
        if bytes > 0 && bytes < 300 * 1024 * 1024 && !matchesPattern(#"\bs\d{1,2}e\d{1,2}\b"#, in: text) {
            score -= 20000
        }

        // Quality
        let tq = detectQualityRank(text)
        if tq == 0 { score -= 5 } else { score += Double(tq) * 25 }

        // Source tier
        if matchesPattern(#"\bremux\b"#, in: text) { score += 18 }
        else if matchesPattern(#"\bblu-?ray\b"#, in: text) { score += 12 }
        else if matchesPattern(#"\bweb-?dl\b"#, in: text) { score += 9 }
        else if matchesPattern(#"\bwebrip\b"#, in: text) { score += 5 }
        else if matchesPattern(#"\bhdtv\b"#, in: text) { score += 2 }
        else if matchesPattern(#"\bdvdrip\b"#, in: text) { score -= 5 }

        // Codec
        if matchesPattern(#"\bav1\b"#, in: text) { score += 7 }
        else if matchesPattern(#"\b(x ?265|h\.?265|hevc)\b"#, in: text) { score += 6 }
        else if matchesPattern(#"\b(x ?264|h\.?264|avc)\b"#, in: text) { score += 2 }

        // HDR / DV
        if matchesPattern(#"\b(dolby[\s.\-]?vision|dovi)\b|\bdv\b"#, in: text) { score += 6 }
        if matchesPattern(#"\bhdr10\+"#, in: text) { score += 5 }
        else if matchesPattern(#"\bhdr\b"#, in: text) { score += 3 }

        // Premium audio
        if matchesPattern(#"\b(atmos|truehd|dts-?hd|dts-?x)\b"#, in: text) { score += 3 }

        // Language
        let isFR = matchesPattern(#"\b(vf|vff|vfq|vfi|french|truefrench)\b"#, in: text)
        let isMulti = matchesPattern(#"\b(multi|dual|vostfr)\b"#, in: text)

        if preferredLang == "fr" {
            if isFR { score += 40 }
            if isMulti { score += 20 }
            if !isFR && !isMulti { score -= 25 }
        } else if preferredLang == "multi" {
            if isMulti { score += 35 }
            if isFR { score += 10 }
        } else {
            if matchesPattern(#"\btruefrench\b"#, in: text) { score -= 30 }
            if isFR && !isMulti { score -= 20 }
            if matches(foreignDubRegex, in: text) && !isMulti && !isFR { score -= 60 }
        }

        // Episode fit
        if torrent.fit == "pack" {
            score -= (torrent.cached == true) ? 10 : 60
        } else if torrent.fit == "other" {
            score -= 100000
        }

        // Seeder health
        if let seedsStr = torrent.seeds?.trimmingCharacters(in: .whitespacesAndNewlines),
           !seedsStr.isEmpty,
           let seeds = Int(seedsStr),
           seedsStr.allSatisfy(\.isNumber) {
            if seeds == 0 { score -= 30 }
            else if seeds < 5 { score -= 10 }
            else { score += min(15, log2(Double(seeds + 1)) * 2) }
        }

        // Size sanity (flag suspiciously small fake 4K/1080p)
        if bytes > 0 {
            let gb: Double = 1024 * 1024 * 1024
            if tq == 4 && bytes < 6 * gb { score -= 8 }
            else if tq == 3 && bytes < 1.2 * gb { score -= 6 }
        }

        // Encoder reputation
        if matchesPattern(#"\b(yify|yts)\b"#, in: text) { score -= 4 }
        if matchesPattern(#"-(framestor|hdb|don|cmrg|kralimarko|tigole|qxr|psa|ntb|ggez|hone)\b"#, in: text) { score += 3 }

        return score
    }

    public static func rankTorrents(_ torrents: [TorrentStream], preferredLang: String = AppConfig.preferredStreamLang) -> [TorrentStream] {
        torrents.sorted { scoreTorrent($0, preferredLang: preferredLang) > scoreTorrent($1, preferredLang: preferredLang) }
    }

    public static func buildPlayQueue(
        ranked: [TorrentStream],
        pick: TorrentStream? = nil,
        max: Int = playQueueMax
    ) -> [TorrentStream] {
        let tier: (TorrentStream) -> Int = { t in
            if t.cached == true || t.isCached { return 0 }
            if t.fit == "pack" { return 2 }
            return 1
        }

        let auto = ranked.enumerated()
            .filter { _, t in
                guard let u = t.url, !u.isEmpty else { return false }
                return t.fit != "other" && !isRejectedForAutoPlay(t)
            }
            .sorted { lhs, rhs in
                let lt = tier(lhs.element)
                let rt = tier(rhs.element)
                if lt != rt { return lt < rt }
                return lhs.offset < rhs.offset
            }
            .map(\.element)

        let same: (TorrentStream, TorrentStream) -> Bool = { a, b in
            if a.id == b.id { return true }
            if let ah = a.hash, !ah.isEmpty, ah == b.hash { return true }
            if let au = a.url, !au.isEmpty, au == b.url { return true }
            return false
        }

        let queue: [TorrentStream]
        if let pick {
            queue = [pick] + auto.filter { !same($0, pick) }
        } else {
            queue = auto
        }

        return Array(queue.prefix(Swift.max(1, max)))
    }

    public static func pickDeepbridSource(ranked: [TorrentStream], pick: TorrentStream? = nil) -> TorrentStream? {
        if let pick, let mag = pick.magnet, !mag.isEmpty, (pick.url == nil || pick.url?.isEmpty == true) {
            return pick
        }
        let ok = ranked.filter { t in
            guard let mag = t.magnet, !mag.isEmpty else { return false }
            return t.fit != "other" && !isRejectedForAutoPlay(t)
        }
        return ok.first(where: { $0.fit != "pack" }) ?? ok.first
    }

    public static func pickWaitSources(_ list: [TorrentStream], max: Int = 2) -> [TorrentStream] {
        let valid = list.filter { ($0.url?.isEmpty == false) && $0.fit != "other" }
        let singles = valid.filter { $0.fit != "pack" }
        let packs = valid.filter { $0.fit == "pack" }
        return Array((singles + packs).prefix(Swift.max(0, max)))
    }
}

// MARK: - Stream Resolution Orchestrator

public struct ResolvedPlayOutcome {
    public let streamURL: URL
    public let stream: TorrentStream
    public let candidates: [TorrentStream]
    public let startPosition: Double
    public let isDeepbrid: Bool
}

public enum StreamResolveError: LocalizedError {
    case noSourcesFound
    case noPlayableSources(String)

    public var errorDescription: String? {
        switch self {
        case .noSourcesFound:
            return tr("No media sources found.", "Aucune source trouvée.")
        case .noPlayableSources(let detail):
            return detail
        }
    }
}

public final class StreamResolver {
    public static let shared = StreamResolver()

    private init() {}

    /// Resolves a playable stream URL via `lastSource` (if applicable) or `search-torrents` +
    /// `rd-stream-torrent` queue + `deepbrid-stream` fallback.
    public func resolvePlayableStream(
        mediaType: String,
        tmdbId: Int?,
        rawId: String,
        title: String,
        year: Int? = nil,
        season: Int? = nil,
        episode: Int? = nil,
        manualPick: TorrentStream? = nil,
        skipLastSource: Bool = false,
        statusCallback: ((String) -> Void)? = nil
    ) async throws -> ResolvedPlayOutcome {
        let existingProgress = await Api.shared.fetchWatchProgress(
            mediaType: mediaType,
            rawId: rawId.isEmpty ? title : rawId,
            title: title,
            season: season,
            episode: episode
        )

        let resumePos: Double
        if let existingProgress, !existingProgress.completed, existingProgress.position > 5 {
            resumePos = existingProgress.position
        } else {
            resumePos = 0
        }

        // 1) Try saved lastSource when opening without a manual pick or reload
        if manualPick == nil, !skipLastSource,
           let prog = existingProgress,
           let lastSrc = prog.lastSource?.toTorrentStream(),
           (mediaType != "tv" || (prog.season == season && prog.episode == episode)) {
            statusCallback?(tr("Opening the last source…", "Ouverture de la dernière source…"))
            if let resolved = try? await Api.shared.resolveStream(lastSrc),
               resolved.success == true,
               let urlStr = resolved.streamUrl,
               let url = URL(string: urlStr) {
                return ResolvedPlayOutcome(
                    streamURL: url,
                    stream: lastSrc,
                    candidates: [lastSrc],
                    startPosition: resumePos,
                    isDeepbrid: false
                )
            }
        }

        // 2) Search & rank candidates
        statusCallback?(tr("Querying Comet for cached streams…", "Recherche des flux en cache sur Comet…"))
        let ranked = try await Api.shared.fetchStreams(
            mediaType: mediaType,
            tmdbId: tmdbId,
            rawId: rawId,
            title: title,
            year: year,
            season: season,
            episode: episode
        )

        guard !ranked.isEmpty else {
            throw StreamResolveError.noSourcesFound
        }

        let queue = StreamPicker.buildPlayQueue(ranked: ranked, pick: manualPick)
        let started = Date()
        var notReady: [TorrentStream] = []
        var lastError: String? = nil

        if let manualPick, (manualPick.url == nil || manualPick.url?.isEmpty == true),
           let mag = manualPick.magnet, !mag.isEmpty {
            statusCallback?(tr("Trying Deepbrid…", "Essai avec Deepbrid…"))
            if let db = try? await Api.shared.resolveDeepbridStream(manualPick, season: season, episode: episode),
               db.success == true, let uStr = db.streamUrl, let url = URL(string: uStr) {
                return ResolvedPlayOutcome(
                    streamURL: url,
                    stream: manualPick,
                    candidates: ranked,
                    startPosition: resumePos,
                    isDeepbrid: true
                )
            }
        }

        for (idx, candidate) in queue.enumerated() {
            if Task.isCancelled { throw CancellationError() }
            if Date().timeIntervalSince(started) > StreamPicker.playQueueBudgetSeconds {
                break
            }

            statusCallback?(tr(
                "Opening source \(idx + 1)/\(queue.count)…",
                "Ouverture de la source \(idx + 1)/\(queue.count)…"
            ))

            do {
                if let resolved = try await Api.shared.resolveStream(candidate) {
                    if resolved.success == true,
                       let uStr = resolved.streamUrl,
                       let url = URL(string: uStr) {
                        return ResolvedPlayOutcome(
                            streamURL: url,
                            stream: candidate,
                            candidates: ranked,
                            startPosition: resumePos,
                            isDeepbrid: false
                        )
                    }
                    if resolved.notCachedYet == true {
                        notReady.append(candidate)
                    }
                    lastError = resolved.error ?? lastError
                }
            } catch {
                lastError = error.localizedDescription
            }
        }

        // 3) Deepbrid fallback
        if let dbPick = StreamPicker.pickDeepbridSource(ranked: ranked, pick: manualPick) {
            statusCallback?(tr("Trying Deepbrid…", "Essai avec Deepbrid…"))
            if let db = try? await Api.shared.resolveDeepbridStream(dbPick, season: season, episode: episode),
               db.success == true, let uStr = db.streamUrl, let url = URL(string: uStr) {
                return ResolvedPlayOutcome(
                    streamURL: url,
                    stream: dbPick,
                    candidates: ranked,
                    startPosition: resumePos,
                    isDeepbrid: true
                )
            }
        }

        // 4) Bounded retry for Real-Debrid MEDIA_NOT_CACHED_YET sources
        let waitSources = StreamPicker.pickWaitSources(notReady)
        if !waitSources.isEmpty {
            for round in 1...2 {
                if Task.isCancelled { throw CancellationError() }
                statusCallback?(tr(
                    "Real-Debrid is downloading this… retry \(round)/2",
                    "Real-Debrid télécharge ce contenu… essai \(round)/2"
                ))
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                if Task.isCancelled { throw CancellationError() }

                for candidate in waitSources {
                    if let resolved = try? await Api.shared.resolveStream(candidate),
                       resolved.success == true,
                       let uStr = resolved.streamUrl,
                       let url = URL(string: uStr) {
                        return ResolvedPlayOutcome(
                            streamURL: url,
                            stream: candidate,
                            candidates: ranked,
                            startPosition: resumePos,
                            isDeepbrid: false
                        )
                    }
                }
            }
        }

        throw StreamResolveError.noPlayableSources(
            lastError ?? tr("No cached playable streams found.", "Aucun flux jouable trouvé.")
        )
    }
}
