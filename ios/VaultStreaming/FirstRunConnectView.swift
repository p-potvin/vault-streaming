import SwiftUI

/// First-run / re-authentication screen used to configure the server URL and
/// `VW_WEB_TOKEN` (stored in the iOS Keychain) before loading the catalog.
public struct FirstRunConnectView: View {
    @ObservedObject private var lang = LanguageManager.shared

    @State private var serverURLInput: String = AppConfig.serverURLString
    @State private var tokenInput: String = AppConfig.token
    @State private var selectedLanguage: String = AppConfig.appLanguage
    @State private var showToken: Bool = false
    @State private var isConnecting: Bool = false
    @State private var errorMessage: String? = nil

    public var onConnected: (() -> Void)?

    public init(onConnected: (() -> Void)? = nil) {
        self.onConnected = onConnected
    }

    public var body: some View {
        ZStack {
            Theme.background
                .ignoresSafeArea()

            ScrollView(.vertical, showsIndicators: false) {
                VStack(spacing: 24) {
                    headerSection
                    connectionFormCard
                    languageCard
                    connectButton
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 36)
                .frame(maxWidth: 520)
            }
            .frame(maxWidth: .infinity)
        }
        .environment(\.locale, lang.locale)
    }

    private var headerSection: some View {
        VStack(spacing: 10) {
            Image(systemName: "film.stack.fill")
                .font(.system(size: 56))
                .foregroundColor(Theme.accent)

            Text("Vault Streaming")
                .font(.title.bold())
                .foregroundColor(.white)

            Text(tr(
                "Connect to your Tailnet server to browse and stream your library.",
                "Connectez-vous à votre serveur Tailnet pour parcourir et lire votre bibliothèque."
            ))
            .font(.subheadline)
            .foregroundColor(Theme.textSecondary)
            .multilineTextAlignment(.center)
        }
        .padding(.top, 12)
    }

    private var connectionFormCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(tr("Server Endpoint", "Adresse du serveur"))
                .font(.caption.weight(.semibold))
                .foregroundColor(Theme.accent)

            TextField("https://streaming.vaultwares.ca", text: $serverURLInput)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled(true)
                .keyboardType(.URL)
                .font(.system(size: 14, design: .monospaced))
                .foregroundColor(.white)
                .padding(12)
                .background(Theme.secondaryBackground)
                .cornerRadius(Theme.radiusSmall)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.radiusSmall)
                        .stroke(Theme.cardBorder, lineWidth: 0.8)
                )

            HStack(spacing: 10) {
                presetButton(title: "Tailnet HTTPS", url: AppConfig.defaultServerURL)
                presetButton(title: tr("Workstation (:8722)", "Poste local (:8722)"), url: AppConfig.defaultWorkstationURL)
            }

            Divider()
                .background(Theme.cardBorder)
                .padding(.vertical, 4)

            Text(tr("Access Token (VW_WEB_TOKEN)", "Jeton d'accès (VW_WEB_TOKEN)"))
                .font(.caption.weight(.semibold))
                .foregroundColor(Theme.accent)

            HStack(spacing: 8) {
                Group {
                    if showToken {
                        TextField(tr("Paste token or ?token= URL", "Coller un jeton ou une URL ?token="), text: $tokenInput)
                    } else {
                        SecureField(tr("Enter access token", "Entrer le jeton d'accès"), text: $tokenInput)
                    }
                }
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled(true)
                .font(.system(size: 14, design: .monospaced))
                .foregroundColor(.white)

                Button(action: { showToken.toggle() }) {
                    Image(systemName: showToken ? "eye.slash" : "eye")
                        .foregroundColor(Theme.textSecondary)
                }
                .buttonStyle(.plain)
            }
            .padding(12)
            .background(Theme.secondaryBackground)
            .cornerRadius(Theme.radiusSmall)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.radiusSmall)
                    .stroke(Theme.cardBorder, lineWidth: 0.8)
            )

            Text(tr(
                "Stored securely in your iOS Keychain. You can paste a full invite URL with ?token= above.",
                "Stocké de façon sécurisée dans le trousseau iOS. Vous pouvez coller une URL complète avec ?token= ci-dessus."
            ))
            .font(.caption2)
            .foregroundColor(Theme.textTertiary)

            if let error = errorMessage {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundColor(.orange)
                    Text(error)
                        .font(.caption)
                        .foregroundColor(.orange)
                }
                .padding(.top, 4)
            }
        }
        .padding(16)
        .background(Theme.cardBackground)
        .cornerRadius(Theme.radiusMedium)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.radiusMedium)
                .stroke(Theme.cardBorder, lineWidth: 0.8)
        )
    }

    private var languageCard: some View {
        HStack {
            Text(tr("Catalog Language", "Langue du catalogue"))
                .font(.subheadline.weight(.medium))
                .foregroundColor(.white)

            Spacer()

            Picker(tr("Catalog Language", "Langue du catalogue"), selection: $selectedLanguage) {
                Text(tr("System", "Système")).tag("system")
                Text("English (en-US)").tag("en-US")
                Text("Français (fr-CA)").tag("fr-CA")
            }
            .tint(Theme.accent)
            .onChange(of: selectedLanguage) { newValue in
                AppConfig.appLanguage = newValue
            }
        }
        .padding(16)
        .background(Theme.cardBackground)
        .cornerRadius(Theme.radiusMedium)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.radiusMedium)
                .stroke(Theme.cardBorder, lineWidth: 0.8)
        )
    }

    private var connectButton: some View {
        Button(action: connect) {
            HStack(spacing: 10) {
                if isConnecting {
                    ProgressView()
                        .progressViewStyle(CircularProgressViewStyle(tint: .black))
                } else {
                    Image(systemName: "link.circle.fill")
                }
                Text(isConnecting ? tr("Connecting...", "Connexion…") : tr("Verify & Connect", "Vérifier et connecter"))
                    .fontWeight(.bold)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 15)
            .background(Theme.accentGradient)
            .foregroundColor(.black)
            .cornerRadius(Theme.radiusMedium)
        }
        .disabled(isConnecting)
    }

    private func presetButton(title: String, url: String) -> some View {
        Button(action: {
            serverURLInput = url
            errorMessage = nil
        }) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundColor(Theme.accent)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Theme.secondaryBackground)
                .cornerRadius(Theme.radiusSmall)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.radiusSmall)
                        .stroke(Theme.cardBorder, lineWidth: 0.8)
                )
        }
        .buttonStyle(.plain)
    }

    private func connect() {
        errorMessage = nil
        let resolved = AppConfig.resolveInputCredentials(serverURL: serverURLInput, token: tokenInput)
        let resolvedURL = resolved.serverURL
        let resolvedToken = resolved.token

        serverURLInput = resolvedURL
        if !resolvedToken.isEmpty {
            tokenInput = resolvedToken
        }

        isConnecting = true
        Task {
            do {
                try await Api.shared.verifyConnection(serverURL: resolvedURL, token: resolvedToken)
                await MainActor.run {
                    AppConfig.appLanguage = selectedLanguage
                    AppConfig.saveCredentials(
                        serverURL: resolvedURL,
                        token: resolvedToken,
                        allowEmptyToken: resolvedToken.isEmpty
                    )
                    isConnecting = false
                    onConnected?()
                }
            } catch {
                await MainActor.run {
                    isConnecting = false
                    errorMessage = describeConnectionError(error)
                }
            }
        }
    }

    private func describeConnectionError(_ error: Error) -> String {
        if let backendError = error as? BackendError {
            return backendError.localizedDescription
        }
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain {
            switch nsError.code {
            case NSURLErrorCannotFindHost, NSURLErrorCannotConnectToHost, NSURLErrorTimedOut:
                return tr(
                    "Cannot reach server. Check that Tailscale is connected and the endpoint URL is correct.",
                    "Impossible de joindre le serveur. Vérifiez que Tailscale est connecté et que l'URL est exacte."
                )
            case NSURLErrorNotConnectedToInternet:
                return tr("No network connection detected.", "Aucune connexion réseau détectée.")
            default:
                break
            }
        }
        return error.localizedDescription
    }
}
