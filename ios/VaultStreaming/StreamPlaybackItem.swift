import Foundation

/// Data model representing an active media stream passed to the native iOS player.
public struct StreamPlaybackItem: Identifiable, Codable {
    public var id: String {
        "\(rawId ?? title)_\(season ?? 0)_\(episode ?? 0)_\(url.absoluteString)"
    }
    public let url: URL
    public let title: String
    public let posterUrl: String?
    public let year: String?
    public let startPosition: Double
    public let mediaType: String?
    public let tmdbId: Int?
    public let rawId: String?
    public let season: Int?
    public let episode: Int?
    public let sourceStream: TorrentStream?
    public let candidates: [TorrentStream]

    public init(
        url: URL,
        title: String,
        posterUrl: String? = nil,
        year: String? = nil,
        startPosition: Double = 0,
        mediaType: String? = nil,
        tmdbId: Int? = nil,
        rawId: String? = nil,
        season: Int? = nil,
        episode: Int? = nil,
        sourceStream: TorrentStream? = nil,
        candidates: [TorrentStream] = []
    ) {
        self.url = url
        self.title = title
        self.posterUrl = posterUrl
        self.year = year
        self.startPosition = startPosition
        self.mediaType = mediaType
        self.tmdbId = tmdbId
        self.rawId = rawId
        self.season = season
        self.episode = episode
        self.sourceStream = sourceStream
        self.candidates = candidates
    }

    /// Formatted localized subtitle (e.g. "Season 1 · Episode 4" / "Saison 1 · Épisode 4" or "Series" / "Movie")
    public var subtitleDisplay: String? {
        if let s = season, let e = episode {
            return L10n.seasonEpisode(s, e)
        } else if mediaType == "tv" {
            return L10n.series
        } else if mediaType == "movie" {
            return L10n.movie
        }
        return nil
    }
}
