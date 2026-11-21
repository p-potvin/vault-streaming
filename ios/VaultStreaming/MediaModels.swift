import Foundation

// MARK: - Media Item (Discovery & Search)

public struct MediaItem: Identifiable, Hashable, Codable {
    public let id: Int
    public let rawId: String
    public let tmdbId: Int?
    public let imdb_id: String?
    public let catalog_id: String?
    public let title: String?
    public let name: String?
    public let overview: String?
    public let poster: String?
    public let poster_path: String?
    public let backdrop: String?
    public let backdrop_path: String?
    public let vote_average: Double?
    public let rating: String?
    public let year: String?
    public let release_date: String?
    public let first_air_date: String?
    public let genres: String?
    public let media_type: String?
    public let votes: Int?
    public let source: String?

    enum CodingKeys: String, CodingKey {
        case id, rawId, tmdbId, imdb_id, catalog_id
        case title, name, overview
        case poster, poster_path, backdrop, backdrop_path
        case vote_average, rating, year, release_date, first_air_date
        case genres, media_type, votes, source
    }

    public init(
        id: Int,
        rawId: String? = nil,
        tmdbId: Int? = nil,
        imdb_id: String? = nil,
        catalog_id: String? = nil,
        title: String? = nil,
        name: String? = nil,
        overview: String? = nil,
        poster: String? = nil,
        poster_path: String? = nil,
        backdrop: String? = nil,
        backdrop_path: String? = nil,
        vote_average: Double? = nil,
        rating: String? = nil,
        year: String? = nil,
        release_date: String? = nil,
        first_air_date: String? = nil,
        genres: String? = nil,
        media_type: String? = nil,
        votes: Int? = nil,
        source: String? = nil
    ) {
        let resolvedRaw = rawId ?? String(id)
        self.id = Self.identity(mediaType: media_type, rawId: resolvedRaw)
        self.rawId = resolvedRaw
        self.tmdbId = tmdbId ?? (id > 0 ? id : nil)
        self.imdb_id = imdb_id
        self.catalog_id = catalog_id
        self.title = title
        self.name = name
        self.overview = overview
        self.poster = poster
        self.poster_path = poster_path
        self.backdrop = backdrop
        self.backdrop_path = backdrop_path
        self.vote_average = vote_average
        self.rating = rating
        self.year = year
        self.release_date = release_date
        self.first_air_date = first_air_date
        self.genres = genres
        self.media_type = media_type
        self.votes = votes
        self.source = source
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)

        let decodedRawId: String
        let decodedTmdbId: Int?
        let decodedStableId: Int

        if let savedRaw = try? c.decode(String.self, forKey: .rawId), !savedRaw.isEmpty {
            decodedRawId = savedRaw
            decodedTmdbId = (try? c.decodeIfPresent(Int.self, forKey: .tmdbId)) ?? Int(savedRaw)
            decodedStableId = (try? c.decode(Int.self, forKey: .id)) ?? decodedTmdbId ?? Self.stableHashId(savedRaw)
        } else if let intId = try? c.decode(Int.self, forKey: .id) {
            decodedRawId = String(intId)
            decodedTmdbId = intId > 0 ? intId : nil
            decodedStableId = intId
        } else if let strId = try? c.decode(String.self, forKey: .id), !strId.isEmpty {
            decodedRawId = strId
            if let parsed = Int(strId), parsed > 0 {
                decodedTmdbId = parsed
                decodedStableId = parsed
            } else {
                decodedTmdbId = nil
                decodedStableId = Self.stableHashId(strId)
            }
        } else {
            let fallback = (try? c.decodeIfPresent(String.self, forKey: .catalog_id))
                ?? (try? c.decodeIfPresent(String.self, forKey: .imdb_id))
                ?? (try? c.decodeIfPresent(String.self, forKey: .title))
                ?? UUID().uuidString
            decodedRawId = fallback
            decodedTmdbId = nil
            decodedStableId = Self.stableHashId(fallback)
        }

        _ = decodedStableId
        // recomputed rather than read back, so watchlist entries saved with the bare TMDB id are re-keyed too
        self.id = Self.identity(mediaType: try? c.decodeIfPresent(String.self, forKey: .media_type), rawId: decodedRawId)
        self.rawId = decodedRawId
        self.tmdbId = decodedTmdbId
        self.imdb_id = try? c.decodeIfPresent(String.self, forKey: .imdb_id)
        self.catalog_id = try? c.decodeIfPresent(String.self, forKey: .catalog_id)
        self.title = try? c.decodeIfPresent(String.self, forKey: .title)
        self.name = try? c.decodeIfPresent(String.self, forKey: .name)
        self.overview = try? c.decodeIfPresent(String.self, forKey: .overview)
        self.poster = try? c.decodeIfPresent(String.self, forKey: .poster)
        self.poster_path = try? c.decodeIfPresent(String.self, forKey: .poster_path)
        self.backdrop = try? c.decodeIfPresent(String.self, forKey: .backdrop)
        self.backdrop_path = try? c.decodeIfPresent(String.self, forKey: .backdrop_path)
        self.release_date = try? c.decodeIfPresent(String.self, forKey: .release_date)
        self.first_air_date = try? c.decodeIfPresent(String.self, forKey: .first_air_date)
        self.media_type = try? c.decodeIfPresent(String.self, forKey: .media_type)
        self.votes = try? c.decodeIfPresent(Int.self, forKey: .votes)
        self.source = try? c.decodeIfPresent(String.self, forKey: .source)

        if let yearStr = try? c.decodeIfPresent(String.self, forKey: .year) {
            self.year = yearStr
        } else if let yearInt = try? c.decodeIfPresent(Int.self, forKey: .year) {
            self.year = String(yearInt)
        } else {
            self.year = nil
        }

        if let ratingStr = try? c.decodeIfPresent(String.self, forKey: .rating) {
            self.rating = ratingStr
        } else if let ratingDouble = try? c.decodeIfPresent(Double.self, forKey: .rating) {
            self.rating = String(format: "%.1f", ratingDouble)
        } else {
            self.rating = nil
        }

        if let avg = try? c.decodeIfPresent(Double.self, forKey: .vote_average) {
            self.vote_average = avg
        } else if let r = self.rating, let parsed = Double(r) {
            self.vote_average = parsed
        } else {
            self.vote_average = nil
        }

        if let genresStr = try? c.decodeIfPresent(String.self, forKey: .genres) {
            self.genres = genresStr
        } else if let genreItems = try? c.decodeIfPresent([GenreItem].self, forKey: .genres) {
            self.genres = genreItems.map(\.name).joined(separator: ", ")
        } else if let genreStrings = try? c.decodeIfPresent([String].self, forKey: .genres) {
            self.genres = genreStrings.joined(separator: ", ")
        } else {
            self.genres = nil
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(rawId, forKey: .rawId)
        try c.encodeIfPresent(tmdbId, forKey: .tmdbId)
        try c.encodeIfPresent(imdb_id, forKey: .imdb_id)
        try c.encodeIfPresent(catalog_id, forKey: .catalog_id)
        try c.encodeIfPresent(title, forKey: .title)
        try c.encodeIfPresent(name, forKey: .name)
        try c.encodeIfPresent(overview, forKey: .overview)
        try c.encodeIfPresent(poster, forKey: .poster)
        try c.encodeIfPresent(poster_path, forKey: .poster_path)
        try c.encodeIfPresent(backdrop, forKey: .backdrop)
        try c.encodeIfPresent(backdrop_path, forKey: .backdrop_path)
        try c.encodeIfPresent(vote_average, forKey: .vote_average)
        try c.encodeIfPresent(rating, forKey: .rating)
        try c.encodeIfPresent(year, forKey: .year)
        try c.encodeIfPresent(release_date, forKey: .release_date)
        try c.encodeIfPresent(first_air_date, forKey: .first_air_date)
        try c.encodeIfPresent(genres, forKey: .genres)
        try c.encodeIfPresent(media_type, forKey: .media_type)
        try c.encodeIfPresent(votes, forKey: .votes)
        try c.encodeIfPresent(source, forKey: .source)
    }

    /// List / watchlist identity: the media type and the id together. A film and a series can share a TMDB number
    /// (both 1399, say), and keyed by the number alone they were one item in ForEach and in the watchlist.
    static func identity(mediaType: String?, rawId: String) -> Int {
        let kind = (mediaType == "tv" || mediaType == "series") ? "tv" : "movie"
        return stableHashId("\(kind):\(rawId)")
    }

    /// Deterministic non-colliding positive integer ID for string catalog/IMDb identifiers.
    private static func stableHashId(_ text: String) -> Int {
        var hash: UInt64 = 14695981039346656037
        for byte in text.utf8 {
            hash ^= UInt64(byte)
            hash &*= 1099511628211
        }
        return Int((hash & 0x3FFF_FFFF) | 0x4000_0000)
    }

    public var displayTitle: String {
        if let t = title, !t.isEmpty { return t }
        if let n = name, !n.isEmpty { return n }
        return L10n.untitled
    }

    public var effectiveMediaType: String {
        if let m = media_type, !m.isEmpty {
            return (m == "series" || m == "tv") ? "tv" : "movie"
        }
        return title != nil ? "movie" : "tv"
    }

    public var releaseYear: String {
        let dateStr = release_date ?? first_air_date ?? ""
        if dateStr.count >= 4 {
            return String(dateStr.prefix(4))
        }
        if let y = year, !y.isEmpty, y != "—" {
            return y
        }
        return ""
    }

    public var posterURL: URL? {
        Self.resolveImageURL(primary: poster, fallbackPath: poster_path, tmdbSize: "w500")
    }

    public var backdropURL: URL? {
        Self.resolveImageURL(primary: backdrop, fallbackPath: backdrop_path, tmdbSize: "w1280")
    }

    public var formattedRating: String {
        guard let r = vote_average, r > 0 else {
            if let raw = rating, !raw.isEmpty, raw != "—" { return raw }
            return "—"
        }
        return String(format: "%.1f", r)
    }

    fileprivate static func resolveImageURL(primary: String?, fallbackPath: String?, tmdbSize: String) -> URL? {
        for candidate in [primary, fallbackPath] {
            guard let raw = candidate?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !raw.isEmpty,
                  raw != "public/poster_placeholder.svg",
                  !raw.hasPrefix("public/") else {
                continue
            }
            if raw.hasPrefix("http://") || raw.hasPrefix("https://") {
                return URL(string: raw)
            }
            if raw.hasPrefix("/") {
                return URL(string: "https://image.tmdb.org/t/p/\(tmdbSize)\(raw)")
            }
        }
        return nil
    }
}

// MARK: - Media Detailed Metadata

public struct MediaDetails: Codable {
    public let id: Int
    public let rawId: String
    public let catalog_id: String?
    public let imdb_id: String?
    public let title: String?
    public let name: String?
    public let overview: String?
    public let tagline: String?
    public let status: String?
    public let runtime: Int?
    public let poster: String?
    public let poster_path: String?
    public let backdrop: String?
    public let backdrop_path: String?
    public let vote_average: Double?
    public let vote_count: Int?
    public let release_date: String?
    public let first_air_date: String?
    public let genres: [GenreItem]?
    public let number_of_seasons: Int?
    public let number_of_episodes: Int?
    public let seasons: [SeasonSummary]?
    public let credits: CreditsPayload?
    public let cast_or_credits: [String]?
    public let source: String?

    enum CodingKeys: String, CodingKey {
        case id, catalog_id, imdb_id, title, name, overview, tagline, status
        case runtime, poster, poster_path, backdrop, backdrop_path
        case vote_average, rating, vote_count, release_date, first_air_date
        case genres, number_of_seasons, number_of_episodes, seasons
        case credits, cast_or_credits, source, external_ids
    }

    private struct ExternalIdsPayload: Codable {
        let imdb_id: String?
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)

        if let intId = try? c.decode(Int.self, forKey: .id) {
            self.id = intId
            self.rawId = String(intId)
        } else if let strId = try? c.decode(String.self, forKey: .id) {
            self.rawId = strId
            self.id = Int(strId) ?? 0
        } else {
            self.id = 0
            self.rawId = "0"
        }

        self.catalog_id = try? c.decodeIfPresent(String.self, forKey: .catalog_id)
        let ext = try? c.decodeIfPresent(ExternalIdsPayload.self, forKey: .external_ids)
        self.imdb_id = (try? c.decodeIfPresent(String.self, forKey: .imdb_id)) ?? ext?.imdb_id
        self.title = try? c.decodeIfPresent(String.self, forKey: .title)
        self.name = try? c.decodeIfPresent(String.self, forKey: .name)
        self.overview = try? c.decodeIfPresent(String.self, forKey: .overview)
        self.tagline = try? c.decodeIfPresent(String.self, forKey: .tagline)
        self.status = try? c.decodeIfPresent(String.self, forKey: .status)
        self.poster = try? c.decodeIfPresent(String.self, forKey: .poster)
        self.poster_path = try? c.decodeIfPresent(String.self, forKey: .poster_path)
        self.backdrop = try? c.decodeIfPresent(String.self, forKey: .backdrop)
        self.backdrop_path = try? c.decodeIfPresent(String.self, forKey: .backdrop_path)
        self.vote_count = try? c.decodeIfPresent(Int.self, forKey: .vote_count)
        self.release_date = try? c.decodeIfPresent(String.self, forKey: .release_date)
        self.first_air_date = try? c.decodeIfPresent(String.self, forKey: .first_air_date)
        self.genres = try? c.decodeIfPresent([GenreItem].self, forKey: .genres)
        self.number_of_seasons = try? c.decodeIfPresent(Int.self, forKey: .number_of_seasons)
        self.number_of_episodes = try? c.decodeIfPresent(Int.self, forKey: .number_of_episodes)
        self.seasons = try? c.decodeIfPresent([SeasonSummary].self, forKey: .seasons)
        self.credits = try? c.decodeIfPresent(CreditsPayload.self, forKey: .credits)
        self.cast_or_credits = try? c.decodeIfPresent([String].self, forKey: .cast_or_credits)
        self.source = try? c.decodeIfPresent(String.self, forKey: .source)

        if let runtimeInt = try? c.decodeIfPresent(Int.self, forKey: .runtime) {
            self.runtime = runtimeInt
        } else if let runtimeStr = try? c.decodeIfPresent(String.self, forKey: .runtime) {
            self.runtime = Int(runtimeStr.components(separatedBy: CharacterSet.decimalDigits.inverted).joined())
        } else {
            self.runtime = nil
        }

        if let avg = try? c.decodeIfPresent(Double.self, forKey: .vote_average) {
            self.vote_average = avg
        } else if let ratingStr = try? c.decodeIfPresent(String.self, forKey: .rating), let parsed = Double(ratingStr) {
            self.vote_average = parsed
        } else {
            self.vote_average = nil
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encodeIfPresent(catalog_id, forKey: .catalog_id)
        try c.encodeIfPresent(imdb_id, forKey: .imdb_id)
        try c.encodeIfPresent(title, forKey: .title)
        try c.encodeIfPresent(name, forKey: .name)
        try c.encodeIfPresent(overview, forKey: .overview)
        try c.encodeIfPresent(tagline, forKey: .tagline)
        try c.encodeIfPresent(status, forKey: .status)
        try c.encodeIfPresent(runtime, forKey: .runtime)
        try c.encodeIfPresent(poster, forKey: .poster)
        try c.encodeIfPresent(poster_path, forKey: .poster_path)
        try c.encodeIfPresent(backdrop, forKey: .backdrop)
        try c.encodeIfPresent(backdrop_path, forKey: .backdrop_path)
        try c.encodeIfPresent(vote_average, forKey: .vote_average)
        try c.encodeIfPresent(vote_count, forKey: .vote_count)
        try c.encodeIfPresent(release_date, forKey: .release_date)
        try c.encodeIfPresent(first_air_date, forKey: .first_air_date)
        try c.encodeIfPresent(genres, forKey: .genres)
        try c.encodeIfPresent(number_of_seasons, forKey: .number_of_seasons)
        try c.encodeIfPresent(number_of_episodes, forKey: .number_of_episodes)
        try c.encodeIfPresent(seasons, forKey: .seasons)
        try c.encodeIfPresent(credits, forKey: .credits)
        try c.encodeIfPresent(cast_or_credits, forKey: .cast_or_credits)
        try c.encodeIfPresent(source, forKey: .source)
    }

    public var displayTitle: String {
        if let t = title, !t.isEmpty { return t }
        if let n = name, !n.isEmpty { return n }
        return L10n.untitled
    }

    /// Top cast members from TMDB `credits` (movie `cast` or series `aggregate_credits`),
    /// falling back to the catalog's plain `cast_or_credits` strings.
    public var displayCast: [CastMember] {
        if let cast = credits?.cast, !cast.isEmpty {
            return Array(cast.prefix(20))
        }
        guard let plain = cast_or_credits, !plain.isEmpty else { return [] }
        return plain.compactMap { raw in
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return nil }
            let lower = trimmed.lowercased()
            if lower.contains("(director)") || lower.contains("(writer)") || lower.contains("(producer)") || lower.contains("(composer)") {
                return nil
            }
            return CastMember(rawId: nil, name: trimmed, character: nil, profile_path: nil, order: nil, roles: nil)
        }.prefix(20).map { $0 }
    }

    public var posterURL: URL? {
        MediaItem.resolveImageURL(primary: poster, fallbackPath: poster_path, tmdbSize: "w500")
    }

    public var backdropURL: URL? {
        MediaItem.resolveImageURL(primary: backdrop, fallbackPath: backdrop_path, tmdbSize: "w1280")
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
    public var id: String { rawId.map(String.init) ?? name }
    public let rawId: Int?
    public let name: String

    enum CodingKeys: String, CodingKey {
        case id, name
    }

    public init(id: Int? = nil, name: String) {
        self.rawId = id
        self.name = name
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.rawId = try? c.decodeIfPresent(Int.self, forKey: .id)
        self.name = (try? c.decode(String.self, forKey: .name)) ?? ""
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(rawId, forKey: .id)
        try c.encode(name, forKey: .name)
    }
}

// MARK: - Series Seasons & Episodes

public struct SeasonSummary: Identifiable, Codable {
    public var id: Int { season_number }
    public let season_number: Int
    public let name: String?
    public let episode_count: Int?
    public let air_date: String?
    public let poster_path: String?
}

public struct SeasonDetails: Codable {
    public let id: Int?
    public let season_number: Int?
    public let name: String?
    public let overview: String?
    public let air_date: String?
    public let poster_path: String?
    public let episodes: [EpisodeItem]?
}

public struct EpisodeItem: Identifiable, Codable {
    public var id: Int { rawId ?? episode_number }
    public let rawId: Int?
    public let episode_number: Int
    public let name: String?
    public let overview: String?
    public let air_date: String?
    public let vote_average: Double?
    public let runtime: Int?
    public let still_path: String?

    enum CodingKeys: String, CodingKey {
        case rawId = "id"
        case episode_number, name, overview, air_date, vote_average, runtime, still_path
    }

    public var stillURL: URL? {
        MediaItem.resolveImageURL(primary: nil, fallbackPath: still_path, tmdbSize: "w500")
    }
}

// MARK: - Cast & Trailers

public struct CreditsPayload: Codable {
    public let cast: [CastMember]?
    public let aggregate: Bool?
}

public struct CastRole: Codable, Hashable {
    public let character: String?
    public let episode_count: Int?
}

public struct CastMember: Identifiable, Codable, Hashable {
    public var id: String { "\(rawId.map(String.init) ?? name)_\(displayCharacter ?? "")" }
    public let rawId: Int?
    public let name: String
    public let character: String?
    public let profile_path: String?
    public let order: Int?
    public let roles: [CastRole]?

    enum CodingKeys: String, CodingKey {
        case rawId = "id"
        case name, character, profile_path, order, roles
    }

    public init(
        rawId: Int? = nil,
        name: String,
        character: String? = nil,
        profile_path: String? = nil,
        order: Int? = nil,
        roles: [CastRole]? = nil
    ) {
        self.rawId = rawId
        self.name = name
        self.character = character
        self.profile_path = profile_path
        self.order = order
        self.roles = roles
    }

    public var displayCharacter: String? {
        if let c = character, !c.isEmpty { return c }
        return roles?.first(where: { !($0.character ?? "").isEmpty })?.character
    }

    public var profileURL: URL? {
        MediaItem.resolveImageURL(primary: nil, fallbackPath: profile_path, tmdbSize: "w185")
    }
}

public struct TrailerResult: Codable {
    public let success: Bool?
    public let key: String?
    public let youtubeId: String?
    public let provider: String?
    public let title: String?
    public let httpPath: String?
    public let cached: Bool?
    public let error: String?

    public var effectiveKey: String? {
        if let k = key, !k.isEmpty { return k }
        if let y = youtubeId, !y.isEmpty { return y }
        return nil
    }
}

// MARK: - Torrent / Comet Stream Item

public struct TorrentStream: Identifiable, Codable, Hashable {
    public var id: String {
        if let h = hash, !h.isEmpty { return h }
        if let u = url, !u.isEmpty { return u }
        return "\(name)_\(desc ?? "")"
    }

    public let name: String
    public let type: String?
    public let desc: String?
    public let quality: String?
    public let size: String?
    public let seeds: String?
    public let peers: String?
    public let hash: String?
    public let magnet: String?
    public let cached: Bool?
    public let url: String?
    public let fit: String?

    public init(
        name: String,
        type: String? = nil,
        desc: String? = nil,
        quality: String? = nil,
        size: String? = nil,
        seeds: String? = nil,
        peers: String? = nil,
        hash: String? = nil,
        magnet: String? = nil,
        cached: Bool? = nil,
        url: String? = nil,
        fit: String? = nil
    ) {
        self.name = name
        self.type = type
        self.desc = desc
        self.quality = quality
        self.size = size
        self.seeds = seeds
        self.peers = peers
        self.hash = hash
        self.magnet = magnet
        self.cached = cached
        self.url = url
        self.fit = fit
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
        return keywords.contains { haystack.contains($0) }
    }

    public var cleanReleaseTitle: String {
        if let d = desc, !d.isEmpty {
            let cleaned = d.replacingOccurrences(of: "📄", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !cleaned.isEmpty { return cleaned }
        }
        return name
    }
}

public struct ResolvedStream: Codable {
    public let success: Bool?
    public let streamUrl: String?
    public let filename: String?
    public let provider: String?
    public let cached: Bool?
    public let notCached: Bool?
    public let placeholder: Bool?
    public let notCachedYet: Bool?
    public let refused: Bool?
    public let downloading: Bool?
    public let progress: Double?
    public let torrentId: String?
    public let error: String?
}

// MARK: - Audio Track Probe

public struct AudioTrackInfo: Identifiable, Codable {
    public var id: Int { audioIndex }
    public let audioIndex: Int
    public let streamIndex: Int?
    public let lang: String
    public let langSource: String?
    public let rawLang: String?
    public let title: String?
    public let codec: String?
    public let channels: Int?
    public let isDefault: Bool?
    public let browserSafe: Bool?
}

public struct AudioProbeResult: Codable {
    public let success: Bool?
    public let tracks: [AudioTrackInfo]?
    public let durationSeconds: Double?
    public let chosenAudioIndex: Int?
    public let chosenLang: String?
    public let needsDetection: Bool?
    public let undetermined: [Int]?
    public let error: String?
}

// MARK: - Subtitle Track & AI Transcript

public struct SubtitleTrack: Identifiable, Codable {
    public let id: String
    public let fileId: Int?
    public let language: String
    public let label: String
    public let release: String?
    public let downloads: Int?
    public let hearingImpaired: Bool
    public let machineTranslated: Bool
    public let feature: String?
    public let url: String?
    public let serverPath: String?
    public let format: String
    public let isLocal: Bool
    public let isOpenSubtitles: Bool
    public let isAi: Bool

    public init(
        id: String,
        fileId: Int? = nil,
        language: String,
        label: String,
        release: String? = nil,
        downloads: Int? = nil,
        hearingImpaired: Bool = false,
        machineTranslated: Bool = false,
        feature: String? = nil,
        url: String? = nil,
        serverPath: String? = nil,
        format: String = "vtt",
        isLocal: Bool = false,
        isOpenSubtitles: Bool = false,
        isAi: Bool = false
    ) {
        self.id = id
        self.fileId = fileId
        self.language = language
        self.label = label
        self.release = release
        self.downloads = downloads
        self.hearingImpaired = hearingImpaired
        self.machineTranslated = machineTranslated
        self.feature = feature
        self.url = url
        self.serverPath = serverPath
        self.format = format
        self.isLocal = isLocal
        self.isOpenSubtitles = isOpenSubtitles
        self.isAi = isAi
    }
}

public struct TranscriptStatus: Codable {
    public let state: String
    public let path: String?
    public let lang: String?
    public let cues: Int?
    public let partial: Bool?
    public let progress: Int?
    public let error: String?
}

// MARK: - Watch Progress

public struct LastSourceRecord: Codable, Hashable {
    public let url: String?
    public let hash: String?
    public let name: String?
    public let desc: String?
    public let quality: String?
    public let size: String?
    public let savedAt: String?

    public init(
        url: String? = nil,
        hash: String? = nil,
        name: String? = nil,
        desc: String? = nil,
        quality: String? = nil,
        size: String? = nil,
        savedAt: String? = nil
    ) {
        self.url = url
        self.hash = hash
        self.name = name
        self.desc = desc
        self.quality = quality
        self.size = size
        self.savedAt = savedAt
    }

    public func toTorrentStream() -> TorrentStream? {
        guard let url, !url.isEmpty else { return nil }
        return TorrentStream(
            name: name ?? "Saved Source",
            type: "⚡ \(name ?? "Saved")",
            desc: desc,
            quality: quality,
            size: size,
            seeds: "—",
            peers: "—",
            hash: hash,
            cached: true,
            url: url,
            fit: "exact"
        )
    }
}

public struct WatchProgressRecord: Identifiable, Codable {
    public let id: String
    public let tmdbId: Int?
    public let rawTmdbId: String
    public let mediaType: String
    public let title: String
    public let position: Double
    public let duration: Double
    public let completed: Bool
    public let posterUrl: String?
    public let season: Int?
    public let episode: Int?
    public let year: String?
    public let lastWatched: String?
    public let lastSource: LastSourceRecord?

    enum CodingKeys: String, CodingKey {
        case key, tmdbId, mediaType, title
        case positionSec, position, durationSec, duration
        case completed, poster, posterUrl, season, episode, year, lastWatched, updatedAt, lastSource
    }

    public init(
        id: String,
        tmdbId: Int? = nil,
        rawTmdbId: String,
        mediaType: String,
        title: String,
        position: Double = 0,
        duration: Double = 0,
        completed: Bool = false,
        posterUrl: String? = nil,
        season: Int? = nil,
        episode: Int? = nil,
        year: String? = nil,
        lastWatched: String? = nil,
        lastSource: LastSourceRecord? = nil
    ) {
        self.id = id
        self.tmdbId = tmdbId
        self.rawTmdbId = rawTmdbId
        self.mediaType = mediaType
        self.title = title
        self.position = position
        self.duration = duration
        self.completed = completed
        self.posterUrl = posterUrl
        self.season = season
        self.episode = episode
        self.year = year
        self.lastWatched = lastWatched
        self.lastSource = lastSource
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)

        let mediaType = (try? c.decodeIfPresent(String.self, forKey: .mediaType)) ?? "movie"
        let title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? L10n.untitled
        let season = try? c.decodeIfPresent(Int.self, forKey: .season)
        let episode = try? c.decodeIfPresent(Int.self, forKey: .episode)

        var parsedIntId: Int? = nil
        var parsedRawId = ""
        if let intId = try? c.decodeIfPresent(Int.self, forKey: .tmdbId) {
            parsedIntId = intId
            parsedRawId = String(intId)
        } else if let strId = try? c.decodeIfPresent(String.self, forKey: .tmdbId) {
            parsedRawId = strId
            parsedIntId = Int(strId)
        }

        let key = try? c.decodeIfPresent(String.self, forKey: .key)
        self.id = (key?.isEmpty == false ? key! : nil)
            ?? "\(mediaType)_\(parsedRawId.isEmpty ? title : parsedRawId)_\(season ?? 0)_\(episode ?? 0)"
        self.tmdbId = parsedIntId
        self.rawTmdbId = parsedRawId
        self.mediaType = mediaType
        self.title = title
        self.season = season
        self.episode = episode

        self.position = (try? c.decodeIfPresent(Double.self, forKey: .positionSec))
            ?? (try? c.decodeIfPresent(Double.self, forKey: .position))
            ?? 0
        self.duration = (try? c.decodeIfPresent(Double.self, forKey: .durationSec))
            ?? (try? c.decodeIfPresent(Double.self, forKey: .duration))
            ?? 0
        self.completed = (try? c.decodeIfPresent(Bool.self, forKey: .completed)) ?? false

        let rawPoster = (try? c.decodeIfPresent(String.self, forKey: .poster))
            ?? (try? c.decodeIfPresent(String.self, forKey: .posterUrl))
        if let rawPoster, rawPoster.hasPrefix("http") {
            self.posterUrl = rawPoster
        } else {
            self.posterUrl = nil
        }

        if let yearStr = try? c.decodeIfPresent(String.self, forKey: .year) {
            self.year = yearStr
        } else if let yearInt = try? c.decodeIfPresent(Int.self, forKey: .year) {
            self.year = String(yearInt)
        } else {
            self.year = nil
        }

        self.lastWatched = try? c.decodeIfPresent(String.self, forKey: .lastWatched)
        self.lastSource = try? c.decodeIfPresent(LastSourceRecord.self, forKey: .lastSource)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .key)
        if let tmdbId {
            try c.encode(tmdbId, forKey: .tmdbId)
        } else if !rawTmdbId.isEmpty {
            try c.encode(rawTmdbId, forKey: .tmdbId)
        }
        try c.encode(mediaType, forKey: .mediaType)
        try c.encode(title, forKey: .title)
        try c.encode(position, forKey: .positionSec)
        try c.encode(duration, forKey: .durationSec)
        try c.encode(completed, forKey: .completed)
        try c.encodeIfPresent(posterUrl, forKey: .poster)
        try c.encodeIfPresent(season, forKey: .season)
        try c.encodeIfPresent(episode, forKey: .episode)
        try c.encodeIfPresent(year, forKey: .year)
        try c.encodeIfPresent(lastWatched, forKey: .lastWatched)
        try c.encodeIfPresent(lastSource, forKey: .lastSource)
    }

    public var progressFraction: Double {
        guard duration > 0 else { return 0 }
        return min(max(position / duration, 0.0), 1.0)
    }
}
