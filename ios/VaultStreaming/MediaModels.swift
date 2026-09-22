import Foundation

// MARK: - Media Item (Discovery & Search)
public struct MediaItem: Identifiable, Hashable, Codable {
    public let id: Int
    public let title: String?
    public let name: String?
    public let overview: String?
    public let poster_path: String?
    public let backdrop_path: String?
    public let vote_average: Double?
    public let release_date: String?
    public let first_air_date: String?
    public let media_type: String?
    
    public init(
        id: Int,
        title: String? = nil,
        name: String? = nil,
        overview: String? = nil,
        poster_path: String? = nil,
        backdrop_path: String? = nil,
        vote_average: Double? = nil,
        release_date: String? = nil,
        first_air_date: String? = nil,
        media_type: String? = nil
    ) {
        self.id = id
        self.title = title
        self.name = name
        self.overview = overview
        self.poster_path = poster_path
        self.backdrop_path = backdrop_path
        self.vote_average = vote_average
        self.release_date = release_date
        self.first_air_date = first_air_date
        self.media_type = media_type
    }
    
    public var displayTitle: String {
        if let t = title, !t.isEmpty { return t }
        if let n = name, !n.isEmpty { return n }
        return "Untitled"
    }
    
    public var effectiveMediaType: String {
        if let m = media_type, !m.isEmpty { return m }
        return title != nil ? "movie" : "tv"
    }
    
    public var releaseYear: String {
        let dateStr = release_date ?? first_air_date ?? ""
        if dateStr.count >= 4 {
            return String(dateStr.prefix(4))
        }
        return ""
    }
    
    public var posterURL: URL? {
        guard let p = poster_path, !p.isEmpty else { return nil }
        if p.hasPrefix("http") { return URL(string: p) }
        return URL(string: "https://image.tmdb.org/t/p/w500\(p)")
    }
    
    public var backdropURL: URL? {
        guard let b = backdrop_path, !b.isEmpty else { return nil }
        if b.hasPrefix("http") { return URL(string: b) }
        return URL(string: "https://image.tmdb.org/t/p/w1280\(b)")
    }
    
    public var formattedRating: String {
        guard let r = vote_average, r > 0 else { return "—" }
        return String(format: "%.1f", r)
    }
}

// MARK: - Media Detailed Metadata
public struct MediaDetails: Codable {
    public let id: Int
    public let title: String?
    public let name: String?
    public let overview: String?
    public let tagline: String?
    public let runtime: Int?
    public let poster_path: String?
    public let backdrop_path: String?
    public let vote_average: Double?
    public let release_date: String?
    public let first_air_date: String?
    public let genres: [GenreItem]?
    public let number_of_seasons: Int?
    public let number_of_episodes: Int?
    
    public var displayTitle: String {
        if let t = title, !t.isEmpty { return t }
        if let n = name, !n.isEmpty { return n }
        return "Untitled"
    }
    
    public var formattedRuntime: String? {
        guard let r = runtime, r > 0 else { return nil }
        let hours = r / 60
        let mins = r % 60
        if hours > 0 {
            return "\(hours)h \(mins)m"
        }
        return "\(mins)m"
    }
}

public struct GenreItem: Identifiable, Codable {
    public let id: Int
    public let name: String
}

// MARK: - Torrent / Comet Stream Item
public struct TorrentStream: Identifiable, Codable {
    public var id: String {
        if let u = url, !u.isEmpty { return u }
        return "\(name)_\(desc ?? "")"
    }
    
    public let name: String
    public let desc: String?
    public let quality: String?
    public let size: String?
    public let seeds: String?
    public let peers: String?
    public let cached: Bool?
    public let url: String?
    
    public init(
        name: String,
        desc: String? = nil,
        quality: String? = nil,
        size: String? = nil,
        seeds: String? = nil,
        peers: String? = nil,
        cached: Bool? = nil,
        url: String? = nil
    ) {
        self.name = name
        self.desc = desc
        self.quality = quality
        self.size = size
        self.seeds = seeds
        self.peers = peers
        self.cached = cached
        self.url = url
    }
    
    public var isCached: Bool {
        if cached == true { return true }
        guard let u = url else { return false }
        return u.contains("playback") || u.contains("real-debrid")
    }
    
    public var displayQuality: String {
        if let q = quality, !q.isEmpty, q != "HD" { return q }
        let haystack = "\(name) \(desc ?? "")".uppercased()
        if haystack.contains("2160P") || haystack.contains("4K") || haystack.contains("UHD") { return "4K" }
        if haystack.contains("1080P") || haystack.contains("FHD") { return "1080p" }
        if haystack.contains("720P") { return "720p" }
        return quality ?? "HD"
    }
    
    public var isFrench: Bool {
        let haystack = " \(name) \(desc ?? "") ".uppercased()
        let keywords = [
            "[FR]", "FRENCH", "TRUEFRENCH", "VFF", "VF2", "VFQ", "VOSTFR", "MULTI", "FRANCAIS", "FRANÇAIS"
        ]
        return keywords.some { haystack.contains($0) }
    }
    
    public var cleanReleaseTitle: String {
        if let d = desc, !d.isEmpty {
            // Remove leading emoji and whitespace
            let cleaned = d.replacingOccurrences(of: "📄", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !cleaned.isEmpty { return cleaned }
        }
        return name
    }
}

// MARK: - Subtitle Track
public struct SubtitleTrack: Identifiable, Codable {
    public let id: String
    public let language: String
    public let label: String
    public let url: String
    public let format: String
    public let isAi: Bool
    
    public init(id: String, language: String, label: String, url: String, format: String = "vtt", isAi: Bool = false) {
        self.id = id
        self.language = language
        self.label = label
        self.url = url
        self.format = format
        self.isAi = isAi
    }
}

// MARK: - Watch Progress
public struct WatchProgressRecord: Identifiable, Codable {
    public var id: String { "\(mediaType)_\(tmdbId)_\(season ?? 0)_\(episode ?? 0)" }
    public let tmdbId: Int
    public let mediaType: String
    public let title: String
    public let position: Double
    public let duration: Double
    public let completed: Bool
    public let posterUrl: String?
    public let season: Int?
    public let episode: Int?
    public let updatedAt: Double
    
    public var progressFraction: Double {
        guard duration > 0 else { return 0 }
        return min(max(position / duration, 0.0), 1.0)
    }
}

// MARK: - Array Extension
private extension Array {
    func some(_ predicate: (Element) -> Bool) -> Bool {
        for element in self {
            if predicate(element) { return true }
        }
        return false
    }
}
