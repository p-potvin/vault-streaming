import Foundation

/// Central networking service bridging the native Swift iOS client with the Vault Streaming
/// HTTP/IPC backend on Tailnet / LAN.
public class StreamingBackend: ObservableObject {
    public static let shared = StreamingBackend()
    
    private let session: URLSession
    
    public init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 25
        config.timeoutIntervalForResource = 60
        self.session = URLSession(configuration: config)
    }
    
    // MARK: - Server Configuration
    public var activeServerURL: URL {
        AppConfig.serverURL
    }
    
    private var token: String {
        // Extract token from query parameter if present, else fallback to standard token
        if let components = URLComponents(url: activeServerURL, resolvingAgainstBaseURL: false),
           let tokenItem = components.queryItems?.first(where: { $0.name == "token" })?.value,
           !tokenItem.isEmpty {
            return tokenItem
        }
        return "cbSPErDf-BpWBOXz-norVbGkqABWSEKbiZWi5CY-UZI"
    }
    
    // MARK: - Core IPC Invocation
    public func invokeRaw(channel: String, args: [Any]) async throws -> [String: Any] {
        var baseComponents = URLComponents(url: activeServerURL, resolvingAgainstBaseURL: false) ?? URLComponents()
        baseComponents.path = "/api/invoke"
        
        var queryItems = baseComponents.queryItems ?? []
        queryItems.removeAll { $0.name == "token" }
        queryItems.append(URLQueryItem(name: "token", value: token))
        baseComponents.queryItems = queryItems
        
        guard let requestURL = baseComponents.url else {
            throw URLError(.badURL)
        }
        
        var request = URLRequest(url: requestURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(token, forHTTPHeaderField: "x-vw-token")
        request.setValue(AppConfig.customUserAgent, forHTTPHeaderField: "User-Agent")
        
        let payload: [String: Any] = [
            "channel": channel,
            "args": args
        ]
        
        request.httpBody = try JSONSerialization.data(withJSONObject: payload, options: [])
        
        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        
        guard httpResponse.statusCode == 200 else {
            let errorText = String(data: data, encoding: .utf8) ?? "HTTP \(httpResponse.statusCode)"
            throw NSError(domain: "VaultStreamingBackend", code: httpResponse.statusCode, userInfo: [NSLocalizedDescriptionKey: errorText])
        }
        
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw URLError(.cannotParseResponse)
        }
        
        if let ok = json["ok"] as? Bool, !ok {
            let errMsg = (json["error"] as? String) ?? "Unknown backend error"
            throw NSError(domain: "VaultStreamingBackend", code: 500, userInfo: [NSLocalizedDescriptionKey: errMsg])
        }
        
        return json
    }
    
    // MARK: - Discovery & Feed
    public func fetchDiscover(mediaType: String = "movie", page: Int = 1) async throws -> [MediaItem] {
        let json = try await invokeRaw(channel: "discover-tmdb", args: [
            ["mediaType": mediaType, "page": page]
        ])
        
        guard let result = json["result"] as? [String: Any],
              let resultsArray = result["results"] as? [[String: Any]] else {
            return []
        }
        
        let data = try JSONSerialization.data(withJSONObject: resultsArray, options: [])
        let items = try JSONDecoder().decode([MediaItem].self, from: data)
        return items
    }
    
    // MARK: - Search
    public func searchMedia(query: String) async throws -> [MediaItem] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }
        
        let json = try await invokeRaw(channel: "search-tmdb", args: [trimmed])
        guard let result = json["result"] as? [String: Any],
              let resultsArray = result["results"] as? [[String: Any]] else {
            return []
        }
        
        let data = try JSONSerialization.data(withJSONObject: resultsArray, options: [])
        let items = try JSONDecoder().decode([MediaItem].self, from: data)
        return items
    }
    
    // MARK: - Details
    public func fetchDetails(mediaType: String, tmdbId: Int) async throws -> MediaDetails? {
        let channel = (mediaType == "tv" || mediaType == "series") ? "get-tmdb-tv" : "get-tmdb-movie"
        let json = try await invokeRaw(channel: channel, args: [["id": tmdbId]])
        
        guard let result = json["result"] as? [String: Any] else {
            return nil
        }
        
        let data = try JSONSerialization.data(withJSONObject: result, options: [])
        return try JSONDecoder().decode(MediaDetails.self, from: data)
    }
    
    // MARK: - Streams & Torrents (Comet + Real-Debrid)
    public func fetchStreams(
        mediaType: String,
        tmdbId: Int,
        title: String,
        year: Int? = nil,
        season: Int? = nil,
        episode: Int? = nil
    ) async throws -> [TorrentStream] {
        var opts: [String: Any] = [
            "mediaType": mediaType,
            "tmdbId": tmdbId,
            "movieTitle": title
        ]
        if let y = year { opts["year"] = y }
        if let s = season { opts["season"] = s }
        if let e = episode { opts["episode"] = e }
        
        let json = try await invokeRaw(channel: "search-torrents", args: [opts])
        guard let result = json["result"] as? [String: Any],
              let torrentsArray = result["torrents"] as? [[String: Any]] else {
            return []
        }
        
        let data = try JSONSerialization.data(withJSONObject: torrentsArray, options: [])
        var streams = try JSONDecoder().decode([TorrentStream].self, from: data)
        
        // Prioritize: 1) Cached streams, 2) French streams, 3) Higher resolution
        streams.sort { a, b in
            if a.isCached != b.isCached {
                return a.isCached && !b.isCached
            }
            if a.isFrench != b.isFrench {
                return a.isFrench && !b.isFrench
            }
            return (a.displayQuality == "4K" || a.displayQuality == "2160p") && (b.displayQuality != "4K" && b.displayQuality != "2160p")
        }
        
        return streams
    }
    
    // MARK: - Watch History
    public func recordProgress(
        mediaType: String,
        tmdbId: Int,
        title: String,
        position: Double,
        duration: Double,
        completed: Bool,
        posterUrl: String?,
        season: Int? = nil,
        episode: Int? = nil
    ) async {
        var payload: [String: Any] = [
            "mediaType": mediaType,
            "tmdbId": tmdbId,
            "title": title,
            "position": position,
            "duration": duration,
            "completed": completed
        ]
        if let p = posterUrl { payload["poster"] = p }
        if let s = season { payload["season"] = s }
        if let e = episode { payload["episode"] = e }
        
        do {
            _ = try await invokeRaw(channel: "watch-history:set-progress", args: [payload])
        } catch {
            print("[Backend] Failed to record progress: \(error)")
        }
    }
    
    public func fetchContinueWatching() async throws -> [WatchProgressRecord] {
        let json = try await invokeRaw(channel: "watch-history:continue-watching", args: [["limit": 20]])
        guard let list = json["result"] as? [[String: Any]] else { return [] }
        
        let data = try JSONSerialization.data(withJSONObject: list, options: [])
        return try JSONDecoder().decode([WatchProgressRecord].self, from: data)
    }
    
    // MARK: - Subtitles & AI Subtitles
    public func fetchSubtitles(mediaType: String, tmdbId: Int, imdbId: String? = nil) async -> [SubtitleTrack] {
        var params: [String: Any] = [
            "mediaType": mediaType,
            "tmdbId": tmdbId
        ]
        if let imdb = imdbId { params["imdbId"] = imdb }
        
        do {
            let json = try await invokeRaw(channel: "get-subtitles", args: [params])
            guard let tracks = json["result"] as? [[String: Any]] else { return [] }
            
            return tracks.compactMap { dict in
                guard let url = dict["url"] as? String else { return nil }
                let lang = (dict["lang"] as? String) ?? (dict["language"] as? String) ?? "en"
                let label = (dict["label"] as? String) ?? (dict["name"] as? String) ?? lang.uppercased()
                let format = (dict["format"] as? String) ?? (url.hasSuffix(".vtt") ? "vtt" : "srt")
                return SubtitleTrack(
                    id: (dict["id"] as? String) ?? url,
                    language: lang,
                    label: label,
                    url: url,
                    format: format,
                    isAi: false
                )
            }
        } catch {
            print("[Backend] Failed to fetch subtitles: \(error)")
            return []
        }
    }
    
    public func requestAiSubtitles(videoUrl: String, translateToFrench: Bool = false) async throws -> SubtitleTrack? {
        var params: [String: Any] = [
            "videoPath": videoUrl,
            "writeSrt": true,
            "langs": ["en", "fr"],
            "separate": false
        ]
        if translateToFrench {
            params["translateTo"] = "fr"
            params["translateFrom"] = "en"
        }
        
        let json = try await invokeRaw(channel: "start-live-subtitles", args: [params])
        guard let res = json["result"] as? [String: Any],
              let vttPath = res["vttPath"] as? String ?? res["srtPath"] as? String else {
            return nil
        }
        
        // Build accessible URL from local server path
        let lang = translateToFrench ? "fr" : "en"
        let label = translateToFrench ? "AI French (Français)" : "AI English"
        return SubtitleTrack(
            id: "ai_\(lang)",
            language: lang,
            label: label,
            url: vttPath,
            format: "vtt",
            isAi: true
        )
    }
}
