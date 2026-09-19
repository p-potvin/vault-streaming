import Foundation

/// Data model representing an active media stream passed from the web interface
/// to the native iOS player.
public struct StreamPlaybackItem: Identifiable, Codable {
    public var id: String { url.absoluteString }
    public let url: URL
    public let title: String
    public let posterUrl: String?
    public let startPosition: Double
    public let mediaType: String?
    public let season: Int?
    public let episode: Int?

    public init(
        url: URL,
        title: String,
        posterUrl: String? = nil,
        startPosition: Double = 0,
        mediaType: String? = nil,
        season: Int? = nil,
        episode: Int? = nil
    ) {
        self.url = url
        self.title = title
        self.posterUrl = posterUrl
        self.startPosition = startPosition
        self.mediaType = mediaType
        self.season = season
        self.episode = episode
    }

    /// Formatted subtitle (e.g. "Season 1, Episode 4" or "Feature Film")
    public var subtitleDisplay: String? {
        if let s = season, let e = episode {
            return "Season \(s) · Episode \(e)"
        } else if mediaType == "tv" {
            return "Series"
        } else if mediaType == "movie" {
            return "Movie"
        }
        return nil
    }
}
