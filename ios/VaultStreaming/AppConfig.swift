import Foundation

/// Central configuration for the VaultStreaming iOS application.
public struct AppConfig {
    public static let appName = "VaultStreaming"
    public static let appVersion = "2.10.3"
    public static let customUserAgent = "VaultStreaming-iOS/\(appVersion) (VaultWares; Tailnet-First)"

    /// Default canonical endpoint pointing to Vault Streaming web client on Tailnet.
    public static let defaultServerURL = "https://streaming.vaultwares.ca"

    /// Local desktop PC workstation endpoint on Tailnet.
    public static let defaultWorkstationURL = "http://100.71.101.21:8722"

    /// Key used to store custom server endpoint in UserDefaults.
    private static let serverURLKey = "vw_streaming_server_url"

    /// Key used to record an explicit verified connection to an unauthenticated local dev server.
    private static let noTokenVerifiedKey = "vw_streaming_no_token_verified"

    /// Key used to track whether Face ID biometric lock is enabled.
    private static let biometricLockKey = "vw_streaming_biometric_lock_enabled"

    /// Key used to store preferred catalog/app language ("system", "en-US", "fr-CA").
    private static let appLanguageKey = "vw_streaming_app_language"

    /// Key used to store a stable device client identifier for SSE / API headers.
    private static let clientIdKey = "vw_streaming_client_id"

    private static let preferredStreamLangKey = "vw_streaming_preferred_stream_lang"
    private static let maxStreamHeightKey = "vw_streaming_max_stream_height"
    private static let defaultSubtitleLangKey = "vw_streaming_default_subtitle_lang"
    private static let muteTrailersKey = "vw_streaming_mute_trailers"
    private static let trailerSkipIntroKey = "vw_streaming_trailer_skip_intro"
    private static let upNextSecondsKey = "vw_streaming_up_next_seconds"
    private static let watchedAtPercentKey = "vw_streaming_watched_at_percent"
    private static let autoplayNextKey = "vw_streaming_autoplay_next"
    private static let showContinueWatchingKey = "vw_streaming_show_continue_watching"
    private static let seriesSkipKey = "vw_streaming_series_skip"

    /// Auto-lock timeout in seconds (e.g. 60 seconds after entering background).
    public static let autoLockTimeout: TimeInterval = 60

    // MARK: - Server URL & Token (Keychain-backed)

    /// Active clean server base URL (without any embedded token query parameter).
    public static var serverURL: URL {
        migrateLegacyEmbeddedTokenIfNeeded()
        if let stored = UserDefaults.standard.string(forKey: serverURLKey),
           !stored.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           let url = URL(string: stored) {
            return url
        }
        return URL(string: defaultServerURL)!
    }

    /// Active server URL string for editing in UI.
    public static var serverURLString: String {
        serverURL.absoluteString
    }

    /// Updates the server endpoint, extracting and moving any `?token=` query item into the Keychain.
    public static func setServerURL(_ urlString: String) {
        let (cleanURLString, extractedToken) = splitEmbeddedToken(from: urlString)
        if !cleanURLString.isEmpty {
            UserDefaults.standard.set(cleanURLString, forKey: serverURLKey)
        } else {
            UserDefaults.standard.removeObject(forKey: serverURLKey)
        }
        if let extractedToken, !extractedToken.isEmpty {
            KeychainHelper.shared.saveToken(extractedToken)
            UserDefaults.standard.set(false, forKey: noTokenVerifiedKey)
        }
        NotificationCenter.default.post(name: .vaultStreamingCredentialsChanged, object: nil)
    }

    /// Access token (`VW_WEB_TOKEN`) persisted in the iOS Keychain.
    public static var token: String {
        get {
            migrateLegacyEmbeddedTokenIfNeeded()
            return KeychainHelper.shared.readToken() ?? ""
        }
        set {
            let trimmed = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                KeychainHelper.shared.deleteToken()
            } else {
                KeychainHelper.shared.saveToken(trimmed)
                UserDefaults.standard.set(false, forKey: noTokenVerifiedKey)
            }
            NotificationCenter.default.post(name: .vaultStreamingCredentialsChanged, object: nil)
        }
    }

    /// True when the app has a stored token (or verified a tokenless dev server) and a valid server URL.
    public static var hasCredentials: Bool {
        let hasToken = !token.isEmpty || UserDefaults.standard.bool(forKey: noTokenVerifiedKey)
        return hasToken && !serverURLString.isEmpty
    }

    /// Saves both server URL and token atomically and notifies listeners once.
    public static func saveCredentials(serverURL: String, token: String, allowEmptyToken: Bool = false) {
        let (cleanURLString, embeddedToken) = splitEmbeddedToken(from: serverURL)
        let effectiveURL = cleanURLString.isEmpty ? defaultServerURL : cleanURLString
        UserDefaults.standard.set(effectiveURL, forKey: serverURLKey)

        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        let finalToken = trimmedToken.isEmpty ? (embeddedToken ?? "") : trimmedToken
        if finalToken.isEmpty {
            KeychainHelper.shared.deleteToken()
            UserDefaults.standard.set(allowEmptyToken, forKey: noTokenVerifiedKey)
        } else {
            KeychainHelper.shared.saveToken(finalToken)
            UserDefaults.standard.set(false, forKey: noTokenVerifiedKey)
        }
        NotificationCenter.default.post(name: .vaultStreamingCredentialsChanged, object: nil)
    }

    /// Clears the Keychain token and notifies the app to show the connection screen.
    public static func clearCredentials() {
        KeychainHelper.shared.deleteToken()
        UserDefaults.standard.set(false, forKey: noTokenVerifiedKey)
        NotificationCenter.default.post(name: .vaultStreamingCredentialsChanged, object: nil)
    }

    /// Extracts a `token` query parameter if present and returns `(cleanURLString, token)`.
    public static func splitEmbeddedToken(from rawString: String) -> (String, String?) {
        let trimmed = rawString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return ("", nil) }

        let withScheme: String
        if trimmed.contains("://") {
            withScheme = trimmed
        } else {
            withScheme = "https://\(trimmed)"
        }

        guard var components = URLComponents(string: withScheme) else {
            return (trimmed, nil)
        }

        var extracted: String? = nil
        if var items = components.queryItems {
            if let match = items.first(where: { $0.name == "token" })?.value, !match.isEmpty {
                extracted = match
            }
            items.removeAll { $0.name == "token" }
            components.queryItems = items.isEmpty ? nil : items
        }

        if components.path == "/" {
            components.path = ""
        }

        let cleaned = components.url?.absoluteString ?? trimmed
        return (cleaned, extracted)
    }

    /// Resolves user-entered server URL and token inputs, extracting any embedded `?token=` query value.
    public static func resolveInputCredentials(serverURL: String, token: String) -> (serverURL: String, token: String) {
        let (cleanURL, embeddedToken) = splitEmbeddedToken(from: serverURL)
        let (_, tokenFromTokenField) = splitEmbeddedToken(from: token)
        let resolvedURL = cleanURL.isEmpty ? defaultServerURL : cleanURL
        let resolvedToken = embeddedToken
            ?? tokenFromTokenField
            ?? token.trimmingCharacters(in: .whitespacesAndNewlines)
        return (resolvedURL, resolvedToken)
    }

    private static func migrateLegacyEmbeddedTokenIfNeeded() {
        guard let stored = UserDefaults.standard.string(forKey: serverURLKey),
              stored.contains("token=") else {
            return
        }
        let (cleanURLString, extractedToken) = splitEmbeddedToken(from: stored)
        if !cleanURLString.isEmpty {
            UserDefaults.standard.set(cleanURLString, forKey: serverURLKey)
        }
        if let extractedToken, !extractedToken.isEmpty, KeychainHelper.shared.readToken() == nil {
            KeychainHelper.shared.saveToken(extractedToken)
        }
    }

    // MARK: - Language Configuration

    /// User selection in Settings: `"system"`, `"en-US"`, or `"fr-CA"`.
    public static var appLanguage: String {
        get {
            UserDefaults.standard.string(forKey: appLanguageKey) ?? "system"
        }
        set {
            UserDefaults.standard.set(newValue, forKey: appLanguageKey)
            NotificationCenter.default.post(name: .vaultStreamingLanguageChanged, object: nil)
        }
    }

    /// Resolved TMDB/catalog BCP-47 tag sent to backend API calls (`"fr-CA"` or `"en-US"`).
    public static var effectiveLanguage: String {
        let choice = appLanguage
        if choice == "fr-CA" || choice == "en-US" {
            return choice
        }
        let preferred = Locale.preferredLanguages.first?.lowercased() ?? "en"
        return preferred.hasPrefix("fr") ? "fr-CA" : "en-US"
    }

    // MARK: - Client Identity

    /// Stable client identifier sent in `x-vw-client`.
    public static var clientId: String {
        if let existing = UserDefaults.standard.string(forKey: clientIdKey), !existing.isEmpty {
            return existing
        }
        let generated = "ios-\(UUID().uuidString.lowercased())"
        UserDefaults.standard.set(generated, forKey: clientIdKey)
        return generated
    }

    // MARK: - Biometric Lock

    /// Whether biometric authentication (Face ID / Touch ID) is required to view the stream library.
    public static var isBiometricLockEnabled: Bool {
        get { boolSetting(forKey: biometricLockKey, defaultValue: false) }
        set { UserDefaults.standard.set(newValue, forKey: biometricLockKey) }
    }

    // MARK: - Playback, Trailers & Series Preferences

    public static var preferredStreamLang: String {
        get {
            if let stored = UserDefaults.standard.string(forKey: preferredStreamLangKey), !stored.isEmpty {
                return stored
            }
            return effectiveLanguage.lowercased().hasPrefix("fr") ? "fr" : "en"
        }
        set { UserDefaults.standard.set(newValue, forKey: preferredStreamLangKey) }
    }

    public static var maxStreamHeight: Int {
        get {
            let v = UserDefaults.standard.integer(forKey: maxStreamHeightKey)
            return v > 0 ? v : 1080
        }
        set { UserDefaults.standard.set(newValue, forKey: maxStreamHeightKey) }
    }

    public static var defaultSubtitleLang: String {
        get { UserDefaults.standard.string(forKey: defaultSubtitleLangKey) ?? "fr" }
        set { UserDefaults.standard.set(newValue, forKey: defaultSubtitleLangKey) }
    }

    public static var muteTrailers: Bool {
        get { boolSetting(forKey: muteTrailersKey, defaultValue: false) }
        set { UserDefaults.standard.set(newValue, forKey: muteTrailersKey) }
    }

    public static var trailerSkipIntro: Bool {
        get { boolSetting(forKey: trailerSkipIntroKey, defaultValue: true) }
        set { UserDefaults.standard.set(newValue, forKey: trailerSkipIntroKey) }
    }

    public static var upNextSeconds: Int {
        get { intSetting(forKey: upNextSecondsKey, defaultValue: 40, min: 0, max: 600) }
        set { UserDefaults.standard.set(min(600, max(0, newValue)), forKey: upNextSecondsKey) }
    }

    public static var watchedAtPercent: Int {
        get { intSetting(forKey: watchedAtPercentKey, defaultValue: 95, min: 50, max: 100) }
        set { UserDefaults.standard.set(min(100, max(50, newValue)), forKey: watchedAtPercentKey) }
    }

    public static var autoplayNextEpisode: Bool {
        get { boolSetting(forKey: autoplayNextKey, defaultValue: true) }
        set { UserDefaults.standard.set(newValue, forKey: autoplayNextKey) }
    }

    public static var showContinueWatchingOnDiscover: Bool {
        get { boolSetting(forKey: showContinueWatchingKey, defaultValue: true) }
        set { UserDefaults.standard.set(newValue, forKey: showContinueWatchingKey) }
    }

    public static func isWatchedAt(position: Double, duration: Double) -> Bool {
        guard duration > 0 else { return false }
        return (position / duration) >= (Double(watchedAtPercent) / 100.0)
    }

    public static func seriesSkip(for tvId: String) -> (intro: Int, outro: Int) {
        guard !tvId.isEmpty,
              let dict = UserDefaults.standard.dictionary(forKey: seriesSkipKey) as? [String: [String: Int]],
              let entry = dict[tvId] else {
            return (0, 0)
        }
        let clamp = { (v: Int?) -> Int in min(900, max(0, v ?? 0)) }
        return (clamp(entry["intro"]), clamp(entry["outro"]))
    }

    public static func setSeriesSkip(for tvId: String, intro: Int, outro: Int) {
        guard !tvId.isEmpty else { return }
        var dict = (UserDefaults.standard.dictionary(forKey: seriesSkipKey) as? [String: [String: Int]]) ?? [:]
        let cleanIntro = min(900, max(0, intro))
        let cleanOutro = min(900, max(0, outro))
        if cleanIntro == 0 && cleanOutro == 0 {
            dict.removeValue(forKey: tvId)
        } else {
            dict[tvId] = ["intro": cleanIntro, "outro": cleanOutro]
        }
        UserDefaults.standard.set(dict, forKey: seriesSkipKey)
    }

    private static func boolSetting(forKey key: String, defaultValue: Bool) -> Bool {
        if UserDefaults.standard.object(forKey: key) == nil {
            return defaultValue
        }
        return UserDefaults.standard.bool(forKey: key)
    }

    private static func intSetting(forKey key: String, defaultValue: Int, min minVal: Int, max maxVal: Int) -> Int {
        if UserDefaults.standard.object(forKey: key) == nil {
            return defaultValue
        }
        let val = UserDefaults.standard.integer(forKey: key)
        return Swift.min(maxVal, Swift.max(minVal, val))
    }
}

public extension Notification.Name {
    static let vaultStreamingCredentialsChanged = Notification.Name("VaultStreamingCredentialsChanged")
    static let vaultStreamingLanguageChanged = Notification.Name("VaultStreamingLanguageChanged")
}
