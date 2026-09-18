import SwiftUI

@main
struct VaultStreamingApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @State private var backgroundTimestamp: Date? = nil
    
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .onChange(of: scenePhase) { newPhase in
            switch newPhase {
            case .background:
                backgroundTimestamp = Date()
            case .active:
                if let timestamp = backgroundTimestamp {
                    let elapsed = Date().timeIntervalSince(timestamp)
                    if elapsed >= AppConfig.autoLockTimeout && AppConfig.isBiometricLockEnabled {
                        NotificationCenter.default.post(name: .vaultStreamingShouldLock, object: nil)
                    }
                }
                backgroundTimestamp = nil
            case .inactive:
                break
            @unknown default:
                break
            }
        }
    }
}

public extension Notification.Name {
    static let vaultStreamingShouldLock = Notification.Name("VaultStreamingShouldLock")
}
