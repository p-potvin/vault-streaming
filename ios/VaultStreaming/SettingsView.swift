import SwiftUI

/// Native iOS Settings View for configuring server endpoints, Keychain access token,
/// UI/catalog language, stream & subtitle preferences, trailer behavior, series autoplay,
/// biometric lock, and diagnostics.
public struct SettingsView: View {
    @ObservedObject private var lang = LanguageManager.shared

    @State private var serverURLInput: String = AppConfig.serverURLString
    @State private var tokenInput: String = AppConfig.token
    @State private var showToken: Bool = false
    @State private var appLanguage: String = AppConfig.appLanguage

    @State private var preferredStreamLang: String = AppConfig.preferredStreamLang
    @State private var maxStreamHeight: Int = AppConfig.maxStreamHeight
    @State private var defaultSubtitleLang: String = AppConfig.defaultSubtitleLang

    @State private var muteTrailers: Bool = AppConfig.muteTrailers
    @State private var trailerSkipIntro: Bool = AppConfig.trailerSkipIntro
    @State private var showContinueWatching: Bool = AppConfig.showContinueWatchingOnDiscover

    @State private var autoplayNextEpisode: Bool = AppConfig.autoplayNextEpisode
    @State private var upNextSeconds: Int = AppConfig.upNextSeconds
    @State private var watchedAtPercent: Int = AppConfig.watchedAtPercent

    @State private var biometricToggle: Bool = AppConfig.isBiometricLockEnabled
    @State private var statusMessage: String? = nil
    @State private var statusIsError: Bool = false
    @State private var isVerifying: Bool = false

    public init() {}

    public var body: some View {
        NavigationStack {
            ZStack {
                Theme.background
                    .ignoresSafeArea()

                Form {
                    serverSection
                    languageSection
                    playbackSection
                    trailersSection
                    seriesSection
                    securitySection
                    diagnosticsSection
                }
                .scrollContentBackground(.hidden)
            }
            .navigationTitle(L10n.tabSettings)
            .navigationBarTitleDisplayMode(.large)
            .environment(\.locale, lang.locale)
            .onAppear(perform: reloadFromConfig)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button(L10n.save) {
                        saveLocally()
                        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                    }
                    .foregroundColor(Theme.accent)
                    .fontWeight(.bold)
                }
            }
        }
    }

    // MARK: - Sections

    private var serverSection: some View {
        Section(header: Text(tr("Server & Authentication", "Serveur et authentification")).foregroundColor(Theme.accent)) {
            TextField("https://streaming.vaultwares.ca", text: $serverURLInput)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled(true)
                .keyboardType(.URL)
                .font(.system(size: 13, design: .monospaced))

            HStack(spacing: 8) {
                Group {
                    let placeholder = tr("Access Token (VW_WEB_TOKEN)", "Jeton d'accès (VW_WEB_TOKEN)")
                    if showToken {
                        TextField(placeholder, text: $tokenInput)
                    } else {
                        SecureField(placeholder, text: $tokenInput)
                    }
                }
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled(true)
                .font(.system(size: 13, design: .monospaced))

                Button(action: { showToken.toggle() }) {
                    Image(systemName: showToken ? "eye.slash" : "eye")
                        .foregroundColor(Theme.textSecondary)
                }
                .buttonStyle(.plain)
            }

            Button(tr("Preset: Streaming Web (streaming.vaultwares.ca)", "Préréglage : Streaming Web (streaming.vaultwares.ca)")) {
                serverURLInput = AppConfig.defaultServerURL
                AppConfig.setServerURL(serverURLInput)
            }
            .font(.footnote)
            .foregroundColor(Theme.accent)

            Button(tr("Preset: Desktop PC Worker (100.71.101.21:8722)", "Préréglage : Poste local (100.71.101.21:8722)")) {
                serverURLInput = AppConfig.defaultWorkstationURL
                AppConfig.setServerURL(serverURLInput)
            }
            .font(.footnote)
            .foregroundColor(Theme.textSecondary)

            Button(action: testAndSaveConnection) {
                HStack {
                    if isVerifying {
                        ProgressView().scaleEffect(0.8)
                    }
                    Text(isVerifying
                         ? tr("Verifying...", "Vérification…")
                         : tr("Verify & Save Credentials", "Vérifier et enregistrer"))
                }
            }
            .font(.footnote.weight(.semibold))
            .foregroundColor(Theme.accent)
            .disabled(isVerifying)

            Button(tr("Clear Token / Disconnect", "Effacer le jeton / Déconnecter"), role: .destructive) {
                tokenInput = ""
                AppConfig.clearCredentials()
            }
            .font(.footnote)

            if let msg = statusMessage {
                Text(msg)
                    .font(.caption)
                    .foregroundColor(statusIsError ? .orange : Theme.successGreen)
            }
        }
        .listRowBackground(Theme.cardBackground)
    }

    private var languageSection: some View {
        Section(header: Text(tr("Language", "Langue")).foregroundColor(Theme.accent)) {
            Picker(tr("App & Catalog Language", "Langue de l'app et du catalogue"), selection: $appLanguage) {
                Text(tr("System", "Système")).tag("system")
                Text("English (en-US)").tag("en-US")
                Text("Français (fr-CA)").tag("fr-CA")
            }
            .onChange(of: appLanguage) { newValue in
                AppConfig.appLanguage = newValue
            }
        }
        .listRowBackground(Theme.cardBackground)
    }

    private var playbackSection: some View {
        Section(header: Text(tr("Playback & Streams", "Lecture et sources")).foregroundColor(Theme.accent)) {
            Picker(tr("Preferred Stream Language", "Langue préférée des flux"), selection: $preferredStreamLang) {
                Text("English").tag("en")
                Text("Français (VF / VFQ)").tag("fr")
                Text("Multi / Dual").tag("multi")
            }
            .onChange(of: preferredStreamLang) { newValue in
                AppConfig.preferredStreamLang = newValue
            }

            Picker(tr("Max Stream Quality", "Qualité maximale"), selection: $maxStreamHeight) {
                Text("4K (2160p)").tag(2160)
                Text("Full HD (1080p)").tag(1080)
                Text("HD (720p)").tag(720)
            }
            .onChange(of: maxStreamHeight) { newValue in
                AppConfig.maxStreamHeight = newValue
            }

            Picker(tr("Default Subtitles", "Sous-titres par défaut"), selection: $defaultSubtitleLang) {
                Text(tr("Off", "Désactivés")).tag("off")
                Text("Français").tag("fr")
                Text("English").tag("en")
            }
            .onChange(of: defaultSubtitleLang) { newValue in
                AppConfig.defaultSubtitleLang = newValue
            }
        }
        .listRowBackground(Theme.cardBackground)
    }

    private var trailersSection: some View {
        Section(header: Text(tr("Trailers & Discover", "Bandes-annonces et Découvrir")).foregroundColor(Theme.accent)) {
            Toggle(tr("Mute Trailers by Default", "Couper le son des bandes-annonces"), isOn: $muteTrailers)
                .tint(Theme.accent)
                .onChange(of: muteTrailers) { newValue in
                    AppConfig.muteTrailers = newValue
                }

            Toggle(tr("Skip KinoCheck Trailer Intro", "Passer l'intro KinoCheck"), isOn: $trailerSkipIntro)
                .tint(Theme.accent)
                .onChange(of: trailerSkipIntro) { newValue in
                    AppConfig.trailerSkipIntro = newValue
                }

            Toggle(tr("Continue Watching on Discover", "Continuer à regarder sur Découvrir"), isOn: $showContinueWatching)
                .tint(Theme.accent)
                .onChange(of: showContinueWatching) { newValue in
                    AppConfig.showContinueWatchingOnDiscover = newValue
                }
        }
        .listRowBackground(Theme.cardBackground)
    }

    private var seriesSection: some View {
        Section(header: Text(tr("Series & Autoplay", "Séries et lecture auto.")).foregroundColor(Theme.accent)) {
            Toggle(tr("Autoplay Next Episode", "Épisode suivant automatique"), isOn: $autoplayNextEpisode)
                .tint(Theme.accent)
                .onChange(of: autoplayNextEpisode) { newValue in
                    AppConfig.autoplayNextEpisode = newValue
                }

            Stepper(value: $upNextSeconds, in: 0...120, step: 5) {
                HStack {
                    Text(tr("Up Next Card", "Carte « Suivant »"))
                    Spacer()
                    Text("\(upNextSeconds) s")
                        .foregroundColor(Theme.textSecondary)
                        .monospacedDigit()
                }
            }
            .onChange(of: upNextSeconds) { newValue in
                AppConfig.upNextSeconds = newValue
            }

            Stepper(value: $watchedAtPercent, in: 50...100, step: 5) {
                HStack {
                    Text(tr("Mark as Watched at", "Marquer vu à"))
                    Spacer()
                    Text("\(watchedAtPercent)%")
                        .foregroundColor(Theme.textSecondary)
                        .monospacedDigit()
                }
            }
            .onChange(of: watchedAtPercent) { newValue in
                AppConfig.watchedAtPercent = newValue
            }
        }
        .listRowBackground(Theme.cardBackground)
    }

    private var securitySection: some View {
        Section(header: Text(tr("Security", "Sécurité")).foregroundColor(Theme.accent)) {
            Toggle(tr("Face ID / Biometric Lock", "Verrouillage Face ID / biométrique"), isOn: $biometricToggle)
                .tint(Theme.accent)
                .onChange(of: biometricToggle) { newValue in
                    AppConfig.isBiometricLockEnabled = newValue
                }
        }
        .listRowBackground(Theme.cardBackground)
    }

    private var diagnosticsSection: some View {
        Section(header: Text(tr("System & Diagnostics", "Système et diagnostics")).foregroundColor(Theme.accent)) {
            diagnosticRow(label: tr("App Version", "Version de l'app"), value: AppConfig.appVersion)
            diagnosticRow(label: tr("Network Mode", "Mode réseau"), value: "Tailnet-First")
            diagnosticRow(label: tr("Catalog Language", "Langue du catalogue"), value: AppConfig.effectiveLanguage)
            diagnosticRow(label: tr("Playback Engine", "Moteur de lecture"), value: "Native AVPlayer (HLS)")
            diagnosticRow(
                label: tr("Token Storage", "Stockage du jeton"),
                value: AppConfig.token.isEmpty
                    ? tr("Not Set", "Non défini")
                    : tr("Keychain", "Trousseau iOS")
            )
        }
        .listRowBackground(Theme.cardBackground)
    }

    // MARK: - Helpers

    private func reloadFromConfig() {
        serverURLInput = AppConfig.serverURLString
        tokenInput = AppConfig.token
        appLanguage = AppConfig.appLanguage
        preferredStreamLang = AppConfig.preferredStreamLang
        maxStreamHeight = AppConfig.maxStreamHeight
        defaultSubtitleLang = AppConfig.defaultSubtitleLang
        muteTrailers = AppConfig.muteTrailers
        trailerSkipIntro = AppConfig.trailerSkipIntro
        showContinueWatching = AppConfig.showContinueWatchingOnDiscover
        autoplayNextEpisode = AppConfig.autoplayNextEpisode
        upNextSeconds = AppConfig.upNextSeconds
        watchedAtPercent = AppConfig.watchedAtPercent
        biometricToggle = AppConfig.isBiometricLockEnabled
    }

    private func resolvedInputs() -> (serverURL: String, token: String) {
        AppConfig.resolveInputCredentials(serverURL: serverURLInput, token: tokenInput)
    }

    private func saveLocally() {
        let inputs = resolvedInputs()
        serverURLInput = inputs.serverURL
        tokenInput = inputs.token
        AppConfig.saveCredentials(
            serverURL: inputs.serverURL,
            token: inputs.token,
            allowEmptyToken: inputs.token.isEmpty
        )
        statusIsError = false
        statusMessage = tr("Saved.", "Enregistré.")
    }

    private func testAndSaveConnection() {
        statusMessage = nil
        isVerifying = true
        let inputs = resolvedInputs()

        Task {
            do {
                try await Api.shared.verifyConnection(serverURL: inputs.serverURL, token: inputs.token)
                await MainActor.run {
                    serverURLInput = inputs.serverURL
                    tokenInput = inputs.token
                    AppConfig.saveCredentials(
                        serverURL: inputs.serverURL,
                        token: inputs.token,
                        allowEmptyToken: inputs.token.isEmpty
                    )
                    isVerifying = false
                    statusIsError = false
                    statusMessage = tr("Connected and saved.", "Connecté et enregistré.")
                }
            } catch {
                await MainActor.run {
                    isVerifying = false
                    statusIsError = true
                    statusMessage = error.localizedDescription
                }
            }
        }
    }

    private func diagnosticRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .foregroundColor(.white)
            Spacer()
            Text(value)
                .foregroundColor(Theme.textSecondary)
                .font(.footnote)
        }
    }
}
