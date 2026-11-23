import SwiftUI
import UIKit

/// Pictures from vault-raggae's local copies first (operator, Mon 23 Nov 2026: TMDB is to be cut off).
///
/// The server sends picture links as its own routes (`/api/img?u=…`, `/api/artwork/…`, `web/server.js`), which proxy
/// to the gateway's kept copies. Those routes are token-gated, and `AsyncImage` cannot send headers, so this view
/// loads them itself with the app's auth headers. A TMDB URL still held locally (an older history entry, a TMDB
/// path) is sent through the same route rather than to TMDB.
public enum ImageRoute {
    /// Where to load `url` from: server-relative links against the server, TMDB pictures through `/api/img`.
    public static func resolve(_ url: URL?) -> URL? {
        guard let url else { return nil }
        let server = AppConfig.serverURL
        if url.host == nil {
            let text = url.absoluteString
            guard text.hasPrefix("/") else { return nil }
            return URL(string: text, relativeTo: server)?.absoluteURL
        }
        if url.host?.lowercased() == "image.tmdb.org" {
            guard var components = URLComponents(url: server, resolvingAgainstBaseURL: false) else { return url }
            components.path = "/api/img"
            components.queryItems = [URLQueryItem(name: "u", value: url.absoluteString)]
            return components.url ?? url
        }
        return url
    }

    /// Whether a request to `url` needs the app's auth headers (it goes to our own server).
    static func needsAuth(_ url: URL) -> Bool {
        let server = AppConfig.serverURL
        return url.host?.lowercased() == server.host?.lowercased() && url.port == server.port
    }
}

/// Decoded pictures kept in memory for the session (posters repeat across Discover, Library and details).
final class VaultImageCache {
    static let shared = VaultImageCache()
    private let cache = NSCache<NSURL, UIImage>()

    private init() {
        cache.countLimit = 400
    }

    func image(for url: URL) -> UIImage? { cache.object(forKey: url as NSURL) }
    func store(_ image: UIImage, for url: URL) { cache.setObject(image, forKey: url as NSURL) }
}

/// A drop-in for `AsyncImage(url:) { phase in … }` that loads through `ImageRoute` with the auth headers.
public struct VaultImage<Content: View>: View {
    private let url: URL?
    private let content: (AsyncImagePhase) -> Content
    @State private var phase: AsyncImagePhase = .empty

    public init(url: URL?, @ViewBuilder content: @escaping (AsyncImagePhase) -> Content) {
        self.url = url
        self.content = content
    }

    public var body: some View {
        content(phase)
            .task(id: url) { await load() }
    }

    private struct LoadFailed: Error {}

    @MainActor
    private func load() async {
        guard let target = ImageRoute.resolve(url) else {
            phase = .empty
            return
        }
        if let cached = VaultImageCache.shared.image(for: target) {
            phase = .success(Image(uiImage: cached))
            return
        }
        phase = .empty
        var request = URLRequest(url: target)
        if ImageRoute.needsAuth(target) {
            for (key, value) in StreamingBackend.shared.authHeaders {
                request.setValue(value, forHTTPHeaderField: key)
            }
        }
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard !Task.isCancelled else { return }
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                  let image = UIImage(data: data) else {
                phase = .failure(LoadFailed())
                return
            }
            VaultImageCache.shared.store(image, for: target)
            phase = .success(Image(uiImage: image))
        } catch {
            if !Task.isCancelled { phase = .failure(error) }
        }
    }
}
