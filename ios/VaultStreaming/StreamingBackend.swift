import Foundation
import Combine

/// Typed IPC channels matching `web/server.js` (`POST /api/invoke`).
public enum IpcChannel: String, Sendable {
    // Catalog & Metadata
    case discoverTmdb = "discover-tmdb"
    case searchTmdb = "search-tmdb"
    case getTmdbMovie = "get-tmdb-movie"
    case getTmdbTv = "get-tmdb-tv"
    case getTmdbTvSeason = "get-tmdb-tv-season"

    // Trailers
    case trailerGet = "trailer:get"
    case trailerCacheStats = "trailer-cache:stats"
    case getKinocheckTrailer = "get-kinocheck-trailer"

    // Streams & Debrid
    case searchTorrents = "search-torrents"
    case rdStreamTorrent = "rd-stream-torrent"
    case deepbridStream = "deepbrid-stream"
    case streamKeepWarm = "stream-keep-warm"

    // Audio Probe & Moments
    case probeAudioTracks = "probe-audio-tracks"
    case detectAudioLanguage = "detect-audio-language"
    case momentsIndexPlayback = "moments:index-playback"

    // Subtitles & Transcripts
    case subtitlesSearch = "subtitles:search"
    case subtitlesTranscript = "subtitles:transcript"
    case downloadSubtitleTrack = "download-subtitle-track"

    // Watch History
    case watchHistorySetProgress = "watch-history:set-progress"
    case watchHistoryGetProgress = "watch-history:get-progress"
    case watchHistoryShowProgress = "watch-history:show-progress"
    case watchHistoryContinueWatching = "watch-history:continue-watching"
    case watchHistoryGetAll = "watch-history:get-all"
    case watchHistoryMarkWatched = "watch-history:mark-watched"
    case watchHistoryRemove = "watch-history:remove"
    case watchHistoryClear = "watch-history:clear"

    // Settings
    case getSettings = "get-settings"
    case saveSettings = "save-settings"
}

public enum BackendError: LocalizedError {
    case invalidURL
    case invalidResponse
    case unauthorized(String)
    case httpError(code: Int, message: String)
    case backendFailure(String)

    public var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Invalid server URL."
        case .invalidResponse:
            return "Invalid response from server."
        case .unauthorized(let message):
            return message
        case .httpError(_, let message):
            return message
        case .backendFailure(let message):
            return message
        }
    }
}

public typealias Api = StreamingBackend

/// Central networking service bridging the native Swift iOS client with the Vault Streaming
/// HTTP/IPC backend on Tailnet / LAN (`POST /api/invoke`).
public class StreamingBackend: ObservableObject {
    public static let shared = StreamingBackend()

    @Published public var requiresAuth: Bool = !AppConfig.hasCredentials

    private let session: URLSession
    private var credentialsObserver: NSObjectProtocol?

    public init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 25
        config.timeoutIntervalForResource = 60
        self.session = URLSession(configuration: config)

        credentialsObserver = NotificationCenter.default.addObserver(
            forName: .vaultStreamingCredentialsChanged,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.requiresAuth = !AppConfig.hasCredentials
        }
    }

    deinit {
        if let observer = credentialsObserver {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    // MARK: - Server Configuration & Auth Helpers

    public var activeServerURL: URL {
        AppConfig.serverURL
    }

    private var token: String {
        AppConfig.token
    }

    /// HTTP headers required for `AVURLAsset` (`AVURLAssetHTTPHeaderFieldsKey`) and authenticated requests.
    public var authHeaders: [String: String] {
        var headers = [
            "x-vw-client": AppConfig.clientId,
            "User-Agent": AppConfig.customUserAgent
        ]
        if !token.isEmpty {
            headers["x-vw-token"] = token
        }
        return headers
    }

    /// Builds a URL for routes such as `/api/hls/index.m3u8`, `/api/media`, or `/trailers/...`. The token travels in
    /// `authHeaders` (AVURLAsset / fetchData), not in the query, so it never lands in the front end's access logs.
    public func authenticatedURL(path: String, queryItems: [URLQueryItem] = [], includeTokenQuery: Bool = false) -> URL? {
        guard var components = URLComponents(url: activeServerURL, resolvingAgainstBaseURL: false) else {
            return nil
        }
        components.path = path.hasPrefix("/") ? path : "/\(path)"
        var items = queryItems
        if includeTokenQuery, !token.isEmpty {
            items.removeAll { $0.name == "token" }
            items.append(URLQueryItem(name: "token", value: token))
        }
        components.queryItems = items.isEmpty ? nil : items
        // URLComponents leaves a literal "+" in query values; Express reads it as a space, which broke source links
        // carrying one (a Comet config path) on their way through /api/hls?src=
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return components.url
    }

    public func hlsURL(for sourceURL: String, audioIndex: Int? = nil, maxHeight: Int = 1080) -> URL? {
        var items = [URLQueryItem(name: "src", value: sourceURL)]
        if let audioIndex {
            items.append(URLQueryItem(name: "audio", value: String(audioIndex)))
        }
        if maxHeight > 0 {
            items.append(URLQueryItem(name: "h", value: String(maxHeight)))
        }
        return authenticatedURL(path: "/api/hls/index.m3u8", queryItems: items)
    }

    public func mediaFileURL(serverPath: String) -> URL? {
        authenticatedURL(
            path: "/api/media",
            queryItems: [URLQueryItem(name: "path", value: serverPath)]
        )
    }

    public func trailerURL(youtubeId: String, h264: Bool = false) -> URL? {
        let suffix = h264 ? ".h264.mp4" : ".mp4"
        return authenticatedURL(path: "/trailers/\(youtubeId)\(suffix)")
    }

    // MARK: - Connection Verification

    /// Tests a candidate server URL and token before saving credentials. Any `/api/invoke` call needs the token; this
    /// one answers a few numbers (`get-settings` sent the whole settings file, API keys included, to the phone).
    public func verifyConnection(serverURL rawServerURL: String, token rawToken: String) async throws {
        let (cleanURLString, embeddedToken) = AppConfig.splitEmbeddedToken(from: rawServerURL)
        guard let baseURL = URL(string: cleanURLString.isEmpty ? AppConfig.defaultServerURL : cleanURLString),
              baseURL.scheme != nil,
              baseURL.host != nil else {
            throw BackendError.invalidURL
        }

        let trimmedToken = rawToken.trimmingCharacters(in: .whitespacesAndNewlines)
        let candidateToken = trimmedToken.isEmpty ? (embeddedToken ?? "") : trimmedToken

        _ = try await performInvoke(
            channel: IpcChannel.trailerCacheStats.rawValue,
            args: [],
            baseURL: baseURL,
            tokenOverride: candidateToken,
            updateAuthState: false
        )

        await MainActor.run {
            self.requiresAuth = false
        }
    }

    // MARK: - Core IPC Invocation

    public func invoke(_ channel: IpcChannel, args: [Any] = []) async throws -> [String: Any] {
        try await invokeRaw(channel: channel.rawValue, args: args)
    }

    public func invokeRaw(channel: String, args: [Any]) async throws -> [String: Any] {
        try await performInvoke(
            channel: channel,
            args: args,
            baseURL: activeServerURL,
            tokenOverride: token,
            updateAuthState: true
        )
    }

    private func performInvoke(
        channel: String,
        args: [Any],
        baseURL: URL,
        tokenOverride: String,
        updateAuthState: Bool
    ) async throws -> [String: Any] {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw BackendError.invalidURL
        }
        components.path = "/api/invoke"
        components.queryItems = nil

        guard let requestURL = components.url else {
            throw BackendError.invalidURL
        }

        var request = URLRequest(url: requestURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(AppConfig.clientId, forHTTPHeaderField: "x-vw-client")
        request.setValue(AppConfig.customUserAgent, forHTTPHeaderField: "User-Agent")
        if !tokenOverride.isEmpty {
            request.setValue(tokenOverride, forHTTPHeaderField: "x-vw-token")
        }

        let payload: [String: Any] = [
            "channel": channel,
            "args": args
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: payload, options: [])

        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw BackendError.invalidResponse
        }

        if httpResponse.statusCode == 401 {
            if updateAuthState {
                await MainActor.run {
                    self.requiresAuth = true
                }
            }
            let errorText = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
            throw BackendError.unauthorized(errorText?.isEmpty == false ? errorText! : "Unauthorized (HTTP 401). Check your access token.")
        }

        guard httpResponse.statusCode == 200 else {
            let errorText = String(data: data, encoding: .utf8) ?? "HTTP \(httpResponse.statusCode)"
            throw BackendError.httpError(code: httpResponse.statusCode, message: errorText)
        }

        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw BackendError.invalidResponse
        }

        if let ok = json["ok"] as? Bool, !ok {
            let errMsg = (json["error"] as? String) ?? "Unknown backend error"
            throw BackendError.backendFailure(errMsg)
        }

        return json
    }

    // MARK: - Discovery & Feed

    public func fetchDiscover(
        mediaType: String = "movie",
        page: Int = 1,
        providerId: String = "all",
        withGenres: String = "all",
        decade: String = "all",
        region: String = "all",
        sort: String = "popularity.desc"
    ) async throws -> [MediaItem] {
        let params: [String: Any] = [
            "providerId": providerId,
            "mediaType": mediaType,
            "page": page,
            "language": AppConfig.serverLanguage,
            "withGenres": withGenres,
            "decade": decade,
            "region": region,
            "sort": sort
        ]
        let json = try await invoke(.discoverTmdb, args: [params])

        guard let result = json["result"] as? [String: Any],
              let resultsArray = result["results"] as? [[String: Any]] else {
            return []
        }

        let data = try JSONSerialization.data(withJSONObject: resultsArray, options: [])
        return try JSONDecoder().decode([MediaItem].self, from: data)
    }

    public func fetchTrending(page: Int = 1) async throws -> [MediaItem] {
        let params: [String: Any] = [
            "query": "",
            "page": page,
            "language": AppConfig.serverLanguage
        ]
        let json = try await invoke(.searchTmdb, args: [params])
        guard let result = json["result"] as? [String: Any],
              let resultsArray = result["results"] as? [[String: Any]] else {
            return []
        }
        let data = try JSONSerialization.data(withJSONObject: resultsArray, options: [])
        return try JSONDecoder().decode([MediaItem].self, from: data)
    }

    /// Fetches authenticated binary/text data (e.g. `.vtt` subtitle files from `/api/media`).
    public func fetchData(from url: URL) async throws -> Data {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        for (k, v) in authHeaders {
            request.setValue(v, forHTTPHeaderField: k)
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw BackendError.invalidResponse
        }
        guard (200...299).contains(http.statusCode) else {
            throw BackendError.httpError(code: http.statusCode, message: "HTTP \(http.statusCode)")
        }
        return data
    }

    // MARK: - Search

    public func searchMedia(query: String, page: Int = 1) async throws -> [MediaItem] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }

        let params: [String: Any] = [
            "query": trimmed,
            "page": page,
            "language": AppConfig.serverLanguage
        ]
        let json = try await invoke(.searchTmdb, args: [params])
        guard let result = json["result"] as? [String: Any],
              let resultsArray = result["results"] as? [[String: Any]] else {
            return []
        }

        let data = try JSONSerialization.data(withJSONObject: resultsArray, options: [])
        return try JSONDecoder().decode([MediaItem].self, from: data)
    }

    // MARK: - Trailers

    public func fetchTrailer(id: String, mediaType: String, title: String) async -> TrailerResult? {
        let idValue: Any = Int(id) ?? id
        let params: [String: Any] = [
            "id": idValue,
            "mediaType": mediaType,
            "language": AppConfig.serverLanguage,
            "title": title
        ]
        do {
            let json = try await invoke(.trailerGet, args: [params])
            guard let result = json["result"] as? [String: Any] else { return nil }
            let data = try JSONSerialization.data(withJSONObject: result, options: [])
            return try JSONDecoder().decode(TrailerResult.self, from: data)
        } catch {
            print("[Backend] Trailer lookup failed: \(error)")
            return nil
        }
    }

    // MARK: - Details & Seasons

    public func fetchDetails(mediaType: String, tmdbId: Int) async throws -> MediaDetails? {
        try await fetchDetails(mediaType: mediaType, id: String(tmdbId))
    }

    public func fetchDetails(mediaType: String, id: String) async throws -> MediaDetails? {
        let isTv = (mediaType == "tv" || mediaType == "series")
        let channel: IpcChannel = isTv ? .getTmdbTv : .getTmdbMovie
        let idValue: Any = Int(id) ?? id

        let json = try await invoke(channel, args: [[
            "id": idValue,
            "language": AppConfig.serverLanguage
        ]])

        guard let result = json["result"] as? [String: Any] else {
            return nil
        }
        let payload = (result["data"] as? [String: Any]) ?? result
        let data = try JSONSerialization.data(withJSONObject: payload, options: [])
        return try JSONDecoder().decode(MediaDetails.self, from: data)
    }

    public func fetchSeason(id: String, seasonNumber: Int) async throws -> SeasonDetails? {
        let idValue: Any = Int(id) ?? id
        let json = try await invoke(.getTmdbTvSeason, args: [[
            "id": idValue,
            "seasonNumber": seasonNumber,
            "language": AppConfig.serverLanguage
        ]])

        guard let result = json["result"] as? [String: Any] else {
            return nil
        }
        let payload = (result["data"] as? [String: Any]) ?? result
        let data = try JSONSerialization.data(withJSONObject: payload, options: [])
        return try JSONDecoder().decode(SeasonDetails.self, from: data)
    }

    // MARK: - Streams & Resolution (Comet)

    public func fetchStreams(
        mediaType: String,
        tmdbId: Int? = nil,
        rawId: String? = nil,
        title: String,
        year: Int? = nil,
        season: Int? = nil,
        episode: Int? = nil
    ) async throws -> [TorrentStream] {
        var opts: [String: Any] = [
            "mediaType": mediaType,
            "movieTitle": title
        ]
        if let rawId, !rawId.isEmpty {
            opts["tmdbId"] = Int(rawId) ?? rawId
        } else if let tmdbId, tmdbId > 0 {
            opts["tmdbId"] = tmdbId
        }
        if let year { opts["year"] = year }
        if let season { opts["season"] = season }
        if let episode { opts["episode"] = episode }

        let json = try await invoke(.searchTorrents, args: [opts])
        guard let result = json["result"] as? [String: Any],
              let torrentsArray = result["torrents"] as? [[String: Any]] else {
            return []
        }

        let data = try JSONSerialization.data(withJSONObject: torrentsArray, options: [])
        let streams = try JSONDecoder().decode([TorrentStream].self, from: data)
        return StreamPicker.rankTorrents(streams)
    }

    public func resolveStream(_ stream: TorrentStream) async throws -> ResolvedStream? {
        var payload: [String: Any] = [
            "name": stream.name,
            "cached": stream.isCached
        ]
        if let url = stream.url { payload["url"] = url }
        if let hash = stream.hash { payload["hash"] = hash }
        if let magnet = stream.magnet { payload["magnet"] = magnet }

        let json = try await invoke(.rdStreamTorrent, args: [payload])
        guard let result = json["result"] as? [String: Any] else {
            return nil
        }
        let data = try JSONSerialization.data(withJSONObject: result, options: [])
        return try JSONDecoder().decode(ResolvedStream.self, from: data)
    }

    public func resolveDeepbridStream(
        _ stream: TorrentStream,
        season: Int? = nil,
        episode: Int? = nil,
        torrentId: String? = nil
    ) async throws -> ResolvedStream? {
        var payload: [String: Any] = ["name": stream.name]
        if let magnet = stream.magnet { payload["magnet"] = magnet }
        if let hash = stream.hash { payload["hash"] = hash }
        if let season { payload["season"] = season }
        if let episode { payload["episode"] = episode }
        if let torrentId { payload["torrentId"] = torrentId }

        let json = try await invoke(.deepbridStream, args: [payload])
        guard let result = json["result"] as? [String: Any] else { return nil }
        let data = try JSONSerialization.data(withJSONObject: result, options: [])
        return try JSONDecoder().decode(ResolvedStream.self, from: data)
    }

    // MARK: - Audio Probe, Keep-Warm & Moments

    public func probeAudioTracks(url: String, preferredLang: String) async -> AudioProbeResult? {
        let params: [String: Any] = [
            "url": url,
            "preferredLang": preferredLang
        ]
        do {
            let json = try await invoke(.probeAudioTracks, args: [params])
            guard let result = json["result"] as? [String: Any] else { return nil }
            let data = try JSONSerialization.data(withJSONObject: result, options: [])
            return try JSONDecoder().decode(AudioProbeResult.self, from: data)
        } catch {
            print("[Backend] probeAudioTracks failed: \(error)")
            return nil
        }
    }

    public func detectAudioLanguage(url: String, audioIndex: Int, durationSeconds: Double? = nil) async -> String? {
        var params: [String: Any] = [
            "url": url,
            "audioIndex": audioIndex
        ]
        if let durationSeconds, durationSeconds > 0 {
            params["durationSeconds"] = durationSeconds
        }
        do {
            let json = try await invoke(.detectAudioLanguage, args: [params])
            guard let result = json["result"] as? [String: Any],
                  (result["success"] as? Bool) == true,
                  let lang = result["lang"] as? String else {
                return nil
            }
            return lang
        } catch {
            print("[Backend] detectAudioLanguage failed: \(error)")
            return nil
        }
    }

    public func keepStreamWarm(url: String) async {
        do {
            _ = try await invoke(.streamKeepWarm, args: [["url": url]])
        } catch {
            // Best-effort keep-alive
        }
    }

    public func indexMomentsPlayback(
        url: String,
        title: String,
        rawId: String,
        mediaType: String,
        season: Int? = nil,
        episode: Int? = nil,
        audioIndex: Int = 0,
        language: String = "und",
        languageSource: String = "none",
        durationSec: Double? = nil,
        sourceRelease: String? = nil
    ) async {
        var payload: [String: Any] = [
            "url": url,
            "title": title,
            "tmdbId": Int(rawId) ?? rawId,
            "mediaType": mediaType,
            "audioIndex": audioIndex,
            "language": language,
            "languageSource": languageSource
        ]
        if let season { payload["season"] = season }
        if let episode { payload["episode"] = episode }
        if let durationSec, durationSec > 0 { payload["durationSec"] = durationSec }
        if let sourceRelease, !sourceRelease.isEmpty { payload["sourceRelease"] = sourceRelease }

        do {
            _ = try await invoke(.momentsIndexPlayback, args: [payload])
        } catch {
            print("[Backend] moments:index-playback failed: \(error)")
        }
    }

    // MARK: - Watch History

    public func recordProgress(
        mediaType: String,
        tmdbId: Int? = nil,
        rawId: String? = nil,
        title: String,
        position: Double,
        duration: Double,
        completed: Bool,
        posterUrl: String?,
        year: String? = nil,
        season: Int? = nil,
        episode: Int? = nil,
        lastSource: TorrentStream? = nil
    ) async {
        var payload: [String: Any] = [
            "mediaType": mediaType,
            "title": title,
            "positionSec": position,
            "durationSec": duration,
            "completed": completed
        ]
        if let tmdbId, tmdbId > 0 {
            payload["tmdbId"] = tmdbId
        } else if let rawId, !rawId.isEmpty {
            payload["tmdbId"] = Int(rawId) ?? rawId
        }
        if let p = posterUrl, !p.isEmpty { payload["poster"] = p }
        if let y = year, !y.isEmpty { payload["year"] = y }
        if let s = season { payload["season"] = s }
        if let e = episode { payload["episode"] = e }
        if let src = lastSource, let srcUrl = src.url, !srcUrl.isEmpty {
            var srcDict: [String: Any] = [
                "url": srcUrl,
                "name": src.name
            ]
            if let h = src.hash { srcDict["hash"] = h }
            if let d = src.desc { srcDict["desc"] = d }
            if let q = src.quality { srcDict["quality"] = q }
            if let sz = src.size { srcDict["size"] = sz }
            payload["lastSource"] = srcDict
        }

        do {
            _ = try await invoke(.watchHistorySetProgress, args: [payload])
        } catch {
            print("[Backend] Failed to record progress: \(error)")
        }
    }

    public func fetchWatchProgress(
        mediaType: String,
        rawId: String,
        title: String,
        season: Int? = nil,
        episode: Int? = nil
    ) async -> WatchProgressRecord? {
        var payload: [String: Any] = [
            "mediaType": mediaType,
            "title": title
        ]
        if !rawId.isEmpty {
            payload["tmdbId"] = Int(rawId) ?? rawId
        }
        if let season { payload["season"] = season }
        if let episode { payload["episode"] = episode }

        do {
            let json = try await invoke(.watchHistoryGetProgress, args: [payload])
            guard let result = json["result"] as? [String: Any] else { return nil }
            let data = try JSONSerialization.data(withJSONObject: result, options: [])
            return try JSONDecoder().decode(WatchProgressRecord.self, from: data)
        } catch {
            return nil
        }
    }

    public func fetchShowProgress(rawId: String, title: String) async -> [WatchProgressRecord] {
        var payload: [String: Any] = ["title": title]
        if !rawId.isEmpty {
            payload["tmdbId"] = Int(rawId) ?? rawId
        }
        do {
            let json = try await invoke(.watchHistoryShowProgress, args: [payload])
            guard let result = json["result"] as? [String: Any],
                  let items = result["items"] as? [[String: Any]] else {
                return []
            }
            let data = try JSONSerialization.data(withJSONObject: items, options: [])
            return try JSONDecoder().decode([WatchProgressRecord].self, from: data)
        } catch {
            return []
        }
    }

    public func markWatched(
        mediaType: String,
        rawId: String,
        title: String,
        posterUrl: String? = nil,
        year: String? = nil,
        season: Int? = nil,
        episode: Int? = nil
    ) async {
        var payload: [String: Any] = [
            "mediaType": mediaType,
            "title": title
        ]
        if !rawId.isEmpty { payload["tmdbId"] = Int(rawId) ?? rawId }
        if let posterUrl, !posterUrl.isEmpty { payload["poster"] = posterUrl }
        if let year, !year.isEmpty { payload["year"] = year }
        if let season { payload["season"] = season }
        if let episode { payload["episode"] = episode }
        do {
            _ = try await invoke(.watchHistoryMarkWatched, args: [payload])
        } catch {
            print("[Backend] Failed to mark watched: \(error)")
        }
    }

    public func removeWatchHistory(
        mediaType: String,
        rawId: String,
        title: String,
        season: Int? = nil,
        episode: Int? = nil
    ) async {
        var payload: [String: Any] = [
            "mediaType": mediaType,
            "title": title
        ]
        if !rawId.isEmpty { payload["tmdbId"] = Int(rawId) ?? rawId }
        if let season { payload["season"] = season }
        if let episode { payload["episode"] = episode }
        do {
            _ = try await invoke(.watchHistoryRemove, args: [payload])
        } catch {
            print("[Backend] Failed to remove watch history item: \(error)")
        }
    }

    public func fetchContinueWatching(limit: Int = 20) async throws -> [WatchProgressRecord] {
        let json = try await invoke(.watchHistoryContinueWatching, args: [["limit": limit]])
        let list: [[String: Any]]
        if let result = json["result"] as? [String: Any],
           let items = result["items"] as? [[String: Any]] {
            list = items
        } else if let direct = json["result"] as? [[String: Any]] {
            list = direct
        } else {
            return []
        }

        let data = try JSONSerialization.data(withJSONObject: list, options: [])
        return try JSONDecoder().decode([WatchProgressRecord].self, from: data)
    }

    public func fetchWatchHistory(limit: Int = 100) async throws -> [WatchProgressRecord] {
        let json = try await invoke(.watchHistoryGetAll, args: [["limit": limit]])
        guard let result = json["result"] as? [String: Any],
              let items = result["items"] as? [[String: Any]] else {
            return []
        }
        let data = try JSONSerialization.data(withJSONObject: items, options: [])
        return try JSONDecoder().decode([WatchProgressRecord].self, from: data)
    }

    // MARK: - Subtitles & AI Transcripts

    public func fetchSubtitles(
        mediaType: String,
        tmdbId: Int? = nil,
        rawId: String? = nil,
        title: String? = nil,
        year: Int? = nil,
        season: Int? = nil,
        episode: Int? = nil,
        langs: String = "en,fr"
    ) async -> [SubtitleTrack] {
        var params: [String: Any] = [
            "mediaType": mediaType,
            "langs": langs
        ]
        if let rawId, !rawId.isEmpty {
            params["tmdbId"] = Int(rawId) ?? rawId
        } else if let tmdbId, tmdbId > 0 {
            params["tmdbId"] = tmdbId
        }
        if let title, !title.isEmpty { params["title"] = title }
        if let year { params["year"] = year }
        if let season { params["season"] = season }
        if let episode { params["episode"] = episode }

        do {
            let json = try await invoke(.subtitlesSearch, args: [params])
            let tracks: [[String: Any]]
            if let result = json["result"] as? [String: Any],
               let rows = result["results"] as? [[String: Any]] {
                tracks = rows
            } else if let direct = json["result"] as? [[String: Any]] {
                tracks = direct
            } else {
                return []
            }

            return tracks.compactMap { dict in
                let fileId = dict["fileId"] as? Int
                let url = dict["url"] as? String
                let serverPath = dict["path"] as? String
                guard fileId != nil || url != nil || serverPath != nil else { return nil }

                let lang = (dict["lang"] as? String) ?? (dict["language"] as? String) ?? "en"
                let release = dict["release"] as? String
                let label = (dict["label"] as? String) ?? (dict["name"] as? String) ?? lang.uppercased()
                let resolvedURL = url ?? serverPath.flatMap { self.mediaFileURL(serverPath: $0)?.absoluteString }
                let id = fileId.map { "os_\($0)" } ?? (dict["id"] as? String) ?? resolvedURL ?? label

                return SubtitleTrack(
                    id: id,
                    fileId: fileId,
                    language: lang,
                    label: label,
                    release: release,
                    downloads: dict["downloads"] as? Int,
                    hearingImpaired: (dict["hearingImpaired"] as? Bool) ?? false,
                    machineTranslated: (dict["machineTranslated"] as? Bool) ?? false,
                    feature: dict["feature"] as? String,
                    url: resolvedURL,
                    serverPath: serverPath,
                    format: "vtt",
                    isLocal: (dict["isLocal"] as? Bool) ?? false,
                    isOpenSubtitles: (dict["isOpenSubtitles"] as? Bool) ?? (fileId != nil),
                    isAi: false
                )
            }
        } catch {
            print("[Backend] Failed to fetch subtitles: \(error)")
            return []
        }
    }

    public func downloadSubtitleTrack(fileId: Int) async throws -> URL {
        let json = try await invoke(.downloadSubtitleTrack, args: [["fileId": fileId]])
        guard let result = json["result"] as? [String: Any],
              (result["success"] as? Bool) == true,
              let serverPath = result["path"] as? String,
              let mediaURL = mediaFileURL(serverPath: serverPath) else {
            let err = (json["result"] as? [String: Any])?["error"] as? String
            throw BackendError.backendFailure(err ?? "Could not download subtitle track.")
        }
        return mediaURL
    }

    public func fetchTranscript(
        mediaType: String,
        rawId: String,
        season: Int? = nil,
        episode: Int? = nil
    ) async throws -> TranscriptStatus? {
        var params: [String: Any] = [
            "mediaType": mediaType,
            "tmdbId": Int(rawId) ?? rawId
        ]
        if let season { params["season"] = season }
        if let episode { params["episode"] = episode }

        let json = try await invoke(.subtitlesTranscript, args: [params])
        guard let result = json["result"] as? [String: Any] else {
            return nil
        }
        let data = try JSONSerialization.data(withJSONObject: result, options: [])
        return try JSONDecoder().decode(TranscriptStatus.self, from: data)
    }
}
