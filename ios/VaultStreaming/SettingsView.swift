import SwiftUI

/// Native iOS Settings View for configuring server endpoints,
/// subtitle preferences (French/AI translation), biometric locks, and diagnostics.
public struct SettingsView: View {
    @State private var serverURLInput: String = AppConfig.serverURL.absoluteString
    @State private var biometricToggle: Bool = AppConfig.isBiometricLockEnabled
    @State private var defaultLanguage: String = "fr"
    @State private var saveSubtitlesToggle: Bool = true
    @State private var autoTranslateFrench: Bool = true
    
    public init() {}
    
    public var body: some View {
        NavigationStack {
            ZStack {
                Theme.background
                    .ignoresSafeArea()
                
                Form {
                    Section(header: Text("Streaming Server Endpoint").foregroundColor(Theme.accent)) {
                        TextField("Server URL with token", text: $serverURLInput)
                            .autocapitalization(.none)
                            .disableAutocorrection(true)
                            .keyboardType(.URL)
                            .font(.system(size: 13, design: .monospaced))
                        
                        Button("Preset: Streaming Web (streaming.vaultwares.ca)") {
                            serverURLInput = AppConfig.defaultServerURL
                            AppConfig.setServerURL(serverURLInput)
                        }
                        .font(.footnote)
                        .foregroundColor(Theme.accent)
                        
                        Button("Preset: Desktop PC Worker (100.71.101.21:8722)") {
                            serverURLInput = "http://100.71.101.21:8722/?token=cbSPErDf-BpWBOXz-norVbGkqABWSEKbiZWi5CY-UZI"
                            AppConfig.setServerURL(serverURLInput)
                        }
                        .font(.footnote)
                        .foregroundColor(Theme.textSecondary)
                    }
                    .listRowBackground(Theme.cardBackground)
                    
                    Section(header: Text("Subtitles & AI Engine").foregroundColor(Theme.accent)) {
                        Picker("Default Subtitle Language", selection: $defaultLanguage) {
                            Text("French (Français)").tag("fr")
                            Text("English").tag("en")
                            Text("Disabled").tag("none")
                        }
                        
                        Toggle("Auto-Translate French (-TranslateTo fr)", isOn: $autoTranslateFrench)
                            .tint(Theme.accent)
                        
                        Toggle("Save Subtitles Permanently", isOn: $saveSubtitlesToggle)
                            .tint(Theme.accent)
                    }
                    .listRowBackground(Theme.cardBackground)
                    
                    Section(header: Text("Security").foregroundColor(Theme.accent)) {
                        Toggle("Face ID / Biometric Lock", isOn: $biometricToggle)
                            .tint(Theme.accent)
                            .onChange(of: biometricToggle) { newValue in
                                AppConfig.isBiometricLockEnabled = newValue
                            }
                    }
                    .listRowBackground(Theme.cardBackground)
                    
                    Section(header: Text("System & Diagnostics").foregroundColor(Theme.accent)) {
                        diagnosticRow(label: "App Version", value: AppConfig.appVersion)
                        diagnosticRow(label: "Network Mode", value: "Tailnet-First")
                        diagnosticRow(label: "Streams Backend", value: "Comet (OVH VPS :5173)")
                        diagnosticRow(label: "French Indexers", value: "Enabled + Prioritized")
                        diagnosticRow(label: "Direct-Stream Remux", value: "PC GPU / OVH API")
                    }
                    .listRowBackground(Theme.cardBackground)
                }
                .scrollContentBackground(.hidden)
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Save") {
                        AppConfig.setServerURL(serverURLInput)
                        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                    }
                    .foregroundColor(Theme.accent)
                    .fontWeight(.bold)
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
