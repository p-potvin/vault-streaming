import Foundation

/// Central configuration for the VaultStreaming iOS container application.
public struct AppConfig {
    public static let appName = "VaultStreaming"
    public static let appVersion = "1.0.0"
    public static let customUserAgent = "VaultStreaming-iOS/\(appVersion) (VaultWares; Tailnet-First)"
    
    /// Default canonical endpoint pointing to Vault Streaming web client on Tailnet.
    public static let defaultServerURL = "https://streaming.vaultwares.ca/?token=cbSPErDf-BpWBOXz-norVbGkqABWSEKbiZWi5CY-UZI"
    
    /// Default VaultWares API gateway on OVH for dispatching transcode jobs to PC.
    public static let defaultApiGatewayURL = "https://api.vaultwares.ca"
    
    /// Local desktop PC for direct fallback / GPU worker.
    public static let defaultWorkstationURL = "http://100.71.101.21:8722"
    
    /// Key used to store custom server endpoint in UserDefaults.
    private static let serverURLKey = "vw_streaming_server_url"
    
    /// Key used to track whether Face ID biometric lock is enabled.
    private static let biometricLockKey = "vw_streaming_biometric_lock_enabled"
    
    /// Auto-lock timeout in seconds (e.g. 60 seconds after entering background).
    public static let autoLockTimeout: TimeInterval = 60
    
    /// Returns the active server URL, falling back to defaultServerURL if not set.
    public static var serverURL: URL {
        if let stored = UserDefaults.standard.string(forKey: serverURLKey),
           let url = URL(string: stored), !stored.isEmpty {
            return url
        }
        return URL(string: defaultServerURL)!
    }
    
    /// Update the server endpoint (e.g. if pointing to a custom Tailnet node or port).
    public static func setServerURL(_ urlString: String) {
        UserDefaults.standard.set(urlString.trimmingCharacters(in: .whitespacesAndNewlines), forKey: serverURLKey)
    }
    
    /// Whether biometric authentication (Face ID / Touch ID) is required to view the stream library.
    public static var isBiometricLockEnabled: Bool {
        get {
            if UserDefaults.standard.object(forKey: biometricLockKey) == nil {
                return false
            }
            return UserDefaults.standard.bool(forKey: biometricLockKey)
        }
        set {
            UserDefaults.standard.set(newValue, forKey: biometricLockKey)
        }
    }
}
