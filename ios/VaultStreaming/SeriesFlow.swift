import Foundation

public struct SeriesResumeTarget: Equatable {
    public enum Kind {
        case resume
        case next
    }

    public let kind: Kind
    public let season: Int
    public let episode: Int
    public let positionSec: Double

    public init(kind: Kind, season: Int, episode: Int, positionSec: Double = 0) {
        self.kind = kind
        self.season = season
        self.episode = episode
        self.positionSec = positionSec
    }
}

public struct GroupedHistoryEntry: Identifiable {
    public var id: String { primary.id }
    public let primary: WatchProgressRecord
    public let episodes: [WatchProgressRecord]

    public var episodeCount: Int { episodes.count }
}

/// Series resume, adjacent-episode navigation, and per-series history grouping
/// aligned with `js/continue-watching.js`, `js/history.js`, `js/player/episodes.js`, and `js/streaming/details-modal.js`.
public enum SeriesResumeHelper {
    /// Collapses a series' episodes into one entry (the most recently watched episode).
    public static func latestPerTitle(_ history: [WatchProgressRecord]) -> [WatchProgressRecord] {
        var seen = Set<String>()
        var titles: [String: Set<String>] = [:]
        var out: [WatchProgressRecord] = []

        for item in history {
            if item.mediaType != "tv" {
                let key = item.id
                if seen.contains(key) { continue }
                seen.insert(key)
                out.append(item)
                continue
            }

            let idKey = item.rawTmdbId.isEmpty ? "" : "tv:\(item.rawTmdbId)"
            var under = titles[item.title] ?? Set<String>()
            let same = idKey.isEmpty ? !under.isEmpty : (seen.contains(idKey) || under.contains(""))
            under.insert(idKey)
            titles[item.title] = under
            if !idKey.isEmpty { seen.insert(idKey) }
            if same { continue }
            out.append(item)
        }

        return out
    }

    /// Groups watch history so each series renders as one card carrying its episode list.
    public static func groupedHistory(_ history: [WatchProgressRecord]) -> [GroupedHistoryEntry] {
        var out: [GroupedHistoryEntry] = []
        var showIndices: [String: Int] = [:]

        for item in history {
            if item.mediaType == "tv" {
                let key = item.rawTmdbId.isEmpty ? item.title : item.rawTmdbId
                if let idx = showIndices[key] {
                    let existing = out[idx]
                    out[idx] = GroupedHistoryEntry(primary: existing.primary, episodes: existing.episodes + [item])
                } else {
                    showIndices[key] = out.count
                    out.append(GroupedHistoryEntry(primary: item, episodes: [item]))
                }
            } else {
                out.append(GroupedHistoryEntry(primary: item, episodes: [item]))
            }
        }

        return out
    }

    /// Picks either the unfinished last episode to resume or the next episode after a finished one.
    public static func pickResumeTarget(items: [WatchProgressRecord], seasons: [SeasonSummary]) -> SeriesResumeTarget? {
        guard let last = items.first,
              let season = last.season,
              let episode = last.episode else {
            return nil
        }

        if !last.completed {
            return SeriesResumeTarget(kind: .resume, season: season, episode: episode, positionSec: last.position)
        }

        let ordered = seasons
            .filter { $0.season_number > 0 && ($0.episode_count ?? 0) > 0 }
            .sorted { $0.season_number < $1.season_number }
        guard !ordered.isEmpty else { return nil }

        let epKey: (Int, Int) -> String = { s, e in "s\(s)e\(e)" }
        let done = Set(items.filter(\.completed).compactMap { item -> String? in
            guard let s = item.season, let e = item.episode else { return nil }
            return epKey(s, e)
        })

        let after: (Int, Int) -> (Int, Int)? = { sn, en in
            if let idx = ordered.firstIndex(where: { $0.season_number == sn }) {
                let cur = ordered[idx]
                if en < (cur.episode_count ?? 0) {
                    return (sn, en + 1)
                }
                if idx + 1 < ordered.count {
                    return (ordered[idx + 1].season_number, 1)
                }
            }
            return nil
        }

        var next = after(season, episode)
        var guardCount = 0
        while let candidate = next, done.contains(epKey(candidate.0, candidate.1)), guardCount < 1000 {
            next = after(candidate.0, candidate.1)
            guardCount += 1
        }

        guard let target = next else { return nil }
        return SeriesResumeTarget(kind: .next, season: target.0, episode: target.1, positionSec: 0)
    }

    // MARK: - Episode Cache & Adjacent Navigation

    private static var showCache: [String: MediaDetails] = [:]
    private static var seasonCache: [String: [EpisodeItem]] = [:]
    private static let cacheLock = NSLock()

    public static func seasonsOf(rawId: String) async -> [SeasonSummary] {
        guard !rawId.isEmpty else { return [] }
        let key = "\(rawId):\(AppConfig.effectiveLanguage)"

        cacheLock.lock()
        let cached = showCache[key]
        cacheLock.unlock()

        let details: MediaDetails?
        if let cached {
            details = cached
        } else if let fetched = try? await Api.shared.fetchDetails(mediaType: "tv", id: rawId) {
            cacheLock.lock()
            showCache[key] = fetched
            cacheLock.unlock()
            details = fetched
        } else {
            details = nil
        }

        return (details?.seasons ?? [])
            .filter { $0.season_number > 0 && ($0.episode_count ?? 0) > 0 }
            .sorted { $0.season_number < $1.season_number }
    }

    public static func episodesOf(rawId: String, season: Int) async -> [EpisodeItem] {
        guard !rawId.isEmpty else { return [] }
        let key = "\(rawId):\(season):\(AppConfig.effectiveLanguage)"

        cacheLock.lock()
        let cached = seasonCache[key]
        cacheLock.unlock()
        if let cached { return cached }

        if let details = try? await Api.shared.fetchSeason(id: rawId, seasonNumber: season),
           let eps = details.episodes {
            cacheLock.lock()
            seasonCache[key] = eps
            cacheLock.unlock()
            return eps
        }
        return []
    }

    public static func episodeInfo(rawId: String, season: Int, episode: Int) async -> EpisodeItem? {
        let eps = await episodesOf(rawId: rawId, season: season)
        return eps.first { $0.episode_number == episode }
    }

    public static func adjacentEpisode(
        rawId: String,
        season: Int,
        episode: Int,
        direction: Int
    ) async -> (season: Int, episode: Int, info: EpisodeItem?)? {
        let seasons = await seasonsOf(rawId: rawId)
        guard !seasons.isEmpty,
              let idx = seasons.firstIndex(where: { $0.season_number == season }) else {
            return nil
        }

        var target: (Int, Int)? = nil
        if direction > 0 {
            if episode < (seasons[idx].episode_count ?? 0) {
                target = (season, episode + 1)
            } else if idx + 1 < seasons.count {
                target = (seasons[idx + 1].season_number, 1)
            }
        } else {
            if episode > 1 {
                target = (season, episode - 1)
            } else if idx - 1 >= 0 {
                let prev = seasons[idx - 1]
                target = (prev.season_number, max(1, prev.episode_count ?? 1))
            }
        }

        guard let chosen = target else { return nil }
        let info = await episodeInfo(rawId: rawId, season: chosen.0, episode: chosen.1)
        return (chosen.0, chosen.1, info)
    }
}

// MARK: - Next-Episode Preloader (`js/streaming/preload.js`)

public final class NextEpisodePreloader {
    public static let shared = NextEpisodePreloader()
    public static let preloadBeforeEndSeconds: Double = 30
    private static let keepTTLSeconds: TimeInterval = 30 * 60

    private struct CachedPreload {
        let key: String
        let outcome: ResolvedPlayOutcome
        let createdAt: Date
        let warmTask: Task<Void, Never>
    }

    private var pendingKey: String? = nil
    private var pendingTask: Task<ResolvedPlayOutcome?, Never>? = nil
    private var cached: CachedPreload? = nil

    private init() {}

    private func keyFor(idOrTitle: String, season: Int, episode: Int) -> String {
        "\(idOrTitle):\(season):\(episode)"
    }

    public func drop() {
        cached?.warmTask.cancel()
        cached = nil
    }

    public func cancelAll() {
        pendingTask?.cancel()
        pendingTask = nil
        pendingKey = nil
        drop()
    }

    /// Resolves the next episode's stream quietly in the background 30 s before the current episode ends.
    public func preload(mediaTitle: String, rawId: String, tmdbId: Int?, season: Int, episode: Int) {
        let idKey = rawId.isEmpty ? mediaTitle : rawId
        let key = keyFor(idOrTitle: idKey, season: season, episode: episode)
        if let entry = cached, Date().timeIntervalSince(entry.createdAt) > Self.keepTTLSeconds { drop() }
        if pendingKey == key || cached?.key == key { return }

        pendingTask?.cancel()
        pendingKey = key
        pendingTask = Task { [weak self] in
            guard let self else { return nil }
            let resolved = await self.resolveQuietly(
                mediaTitle: mediaTitle,
                rawId: rawId,
                tmdbId: tmdbId,
                season: season,
                episode: episode
            )
            guard !Task.isCancelled, self.pendingKey == key else { return nil }
            self.pendingKey = nil

            guard let resolved else { return nil }
            self.drop()
            let streamURLString = resolved.streamURL.absoluteString
            // kept warm for its lifetime only, then evicted whether or not it was played (leaving the player near the
            // end of an episode used to keep the server warming the next one every minute, indefinitely)
            let warmTask = Task { [weak self] in
                let deadline = Date().addingTimeInterval(Self.keepTTLSeconds)
                while !Task.isCancelled && Date() < deadline {
                    try? await Task.sleep(nanoseconds: 60_000_000_000)
                    if Task.isCancelled { return }
                    await Api.shared.keepStreamWarm(url: streamURLString)
                }
                guard !Task.isCancelled else { return }
                await MainActor.run {
                    if let self, self.cached?.key == key { self.cached = nil }
                }
            }
            self.cached = CachedPreload(key: key, outcome: resolved, createdAt: Date(), warmTask: warmTask)
            await self.queueMomentsQuietly(
                mediaTitle: mediaTitle,
                rawId: rawId,
                season: season,
                episode: episode,
                outcome: resolved
            )
            return resolved
        }
    }

    /// Consumes a preloaded stream if ready (or waits if currently in-flight for the requested episode).
    public func takePreloaded(rawId: String, title: String, season: Int, episode: Int) async -> ResolvedPlayOutcome? {
        let idKey = rawId.isEmpty ? title : rawId
        let key = keyFor(idOrTitle: idKey, season: season, episode: episode)

        if pendingKey == key, let task = pendingTask {
            _ = await task.value
        }

        guard let entry = cached, entry.key == key else { return nil }
        cached = nil
        entry.warmTask.cancel()
        guard Date().timeIntervalSince(entry.createdAt) <= Self.keepTTLSeconds else { return nil }
        return entry.outcome
    }

    private func resolveQuietly(
        mediaTitle: String,
        rawId: String,
        tmdbId: Int?,
        season: Int,
        episode: Int
    ) async -> ResolvedPlayOutcome? {
        if let prog = await Api.shared.fetchWatchProgress(
            mediaType: "tv",
            rawId: rawId.isEmpty ? mediaTitle : rawId,
            title: mediaTitle,
            season: season,
            episode: episode
        ),
           prog.season == season, prog.episode == episode,
           let lastSrc = prog.lastSource?.toTorrentStream(),
           let r = try? await Api.shared.resolveStream(lastSrc),
           r.success == true, r.placeholder != true,
           let uStr = r.streamUrl, let url = URL(string: uStr) {
            let pos = prog.completed ? 0 : (prog.position > 5 ? prog.position : 0)
            return ResolvedPlayOutcome(streamURL: url, stream: lastSrc, candidates: [lastSrc], startPosition: pos, isDeepbrid: false)
        }

        guard let ranked = try? await Api.shared.fetchStreams(
            mediaType: "tv",
            tmdbId: tmdbId,
            rawId: rawId,
            title: mediaTitle,
            season: season,
            episode: episode
        ), !ranked.isEmpty else {
            return nil
        }

        let tries = StreamPicker.buildPlayQueue(ranked: ranked, max: 5)
        for candidate in tries {
            if Task.isCancelled { return nil }
            if let r = try? await Api.shared.resolveStream(candidate),
               r.success == true,
               let uStr = r.streamUrl,
               let url = URL(string: uStr) {
                return ResolvedPlayOutcome(streamURL: url, stream: candidate, candidates: ranked, startPosition: 0, isDeepbrid: false)
            }
        }
        return nil
    }

    private func queueMomentsQuietly(
        mediaTitle: String,
        rawId: String,
        season: Int,
        episode: Int,
        outcome: ResolvedPlayOutcome
    ) async {
        let probe = await Api.shared.probeAudioTracks(
            url: outcome.streamURL.absoluteString,
            preferredLang: AppConfig.preferredStreamLang
        )
        let audioIdx = probe?.chosenAudioIndex ?? 0
        guard let track = probe?.tracks?.first(where: { $0.audioIndex == audioIdx }),
              !track.lang.isEmpty,
              track.lang != "und" else {
            return
        }
        await Api.shared.indexMomentsPlayback(
            url: outcome.streamURL.absoluteString,
            title: mediaTitle,
            rawId: rawId,
            mediaType: "tv",
            season: season,
            episode: episode,
            audioIndex: audioIdx,
            language: track.lang,
            languageSource: track.langSource ?? "tag",
            durationSec: probe?.durationSeconds,
            sourceRelease: outcome.stream.cleanReleaseTitle
        )
    }
}
