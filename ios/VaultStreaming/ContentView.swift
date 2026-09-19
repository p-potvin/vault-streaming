import SwiftUI

public struct ContentView: View {
    @State private var serverURL: URL = AppConfig.serverURL
    @State private var isLoading: Bool = true
    @State private var navigationError: String? = nil
    @State private var canGoBack: Bool = false
    @State private var canGoForward: Bool = false
    
    @State private var reloadToken: Int = 0
    @State private var goBackToken: Int = 0
    @State private var goForwardToken: Int = 0
    
    @State private var activeStream: StreamPlaybackItem? = nil
    @State private var progressUpdate: ProgressUpdate? = nil
    
    @State private var isLocked: Bool = AppConfig.isBiometricLockEnabled
    @State private var showSettings: Bool = false
    @State private var customURLInput: String = AppConfig.serverURL.absoluteString
    @State private var biometricToggle: Bool = AppConfig.isBiometricLockEnabled
    
    public init() {}
    
    public var body: some View {
        ZStack {
            // Main Web Streaming Container
            VStack(spacing: 0) {
                // Top Progress Bar
                if isLoading {
                    ProgressView()
                        .progressViewStyle(LinearProgressViewStyle(tint: Color(red: 176/255.0, green: 124/255.0, blue: 255/255.0)))
                        .frame(height: 2)
                }
                
                // Offline / Tailscale Connection Banner
                if let error = navigationError {
                    VStack(spacing: 8) {
                        HStack {
                            Image(systemName: "network.slash")
                                .foregroundColor(.orange)
                            Text(error)
                                .font(.footnote)
                                .foregroundColor(.primary)
                                .multilineTextAlignment(.leading)
                            Spacer()
                            Button("Retry") {
                                navigationError = nil
                                reloadToken += 1
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(Color(red: 176/255.0, green: 124/255.0, blue: 255/255.0))
                            .controlSize(.small)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(Color(UIColor.secondarySystemBackground))
                    }
                    .transition(.move(edge: .top))
                }
                
                // Embedded WebKit View
                WebViewWrapper(
                    url: serverURL,
                    isLoading: $isLoading,
                    navigationError: $navigationError,
                    canGoBack: $canGoBack,
                    canGoForward: $canGoForward,
                    activeStream: $activeStream,
                    progressUpdate: $progressUpdate,
                    reloadToken: reloadToken,
                    goBackToken: goBackToken,
                    goForwardToken: goForwardToken
                )
                
                // Bottom Utility Toolbar
                HStack(spacing: 24) {
                    Button(action: { goBackToken += 1 }) {
                        Image(systemName: "chevron.backward")
                    }
                    .disabled(!canGoBack)
                    
                    Button(action: { goForwardToken += 1 }) {
                        Image(systemName: "chevron.forward")
                    }
                    .disabled(!canGoForward)
                    
                    Spacer()
                    
                    Button(action: { reloadToken += 1 }) {
                        Image(systemName: isLoading ? "xmark" : "arrow.clockwise")
                    }
                    
                    Button(action: { showSettings = true }) {
                        Image(systemName: "gearshape")
                    }
                }
                .font(.system(size: 18, weight: .medium))
                .foregroundColor(Color(red: 176/255.0, green: 124/255.0, blue: 255/255.0))
                .padding(.horizontal, 20)
                .padding(.vertical, 10)
                .background(Color(red: 11/255.0, green: 8/255.0, blue: 19/255.0))
            }
            
            // Biometric Face ID Lock Screen Overlay
            if isLocked {
                ZStack {
                    Color(red: 11/255.0, green: 8/255.0, blue: 19/255.0)
                        .ignoresSafeArea()
                    
                    VStack(spacing: 20) {
                        Image(systemName: "play.tv.fill")
                            .font(.system(size: 64))
                            .foregroundColor(Color(red: 176/255.0, green: 124/255.0, blue: 255/255.0))
                        
                        Text("Vault Streaming")
                            .font(.title)
                            .fontWeight(.bold)
                            .foregroundColor(.white)
                        
                        Text("Library locked")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                        
                        Button(action: triggerUnlock) {
                            HStack {
                                Image(systemName: biometricIconName)
                                Text("Unlock App")
                            }
                            .font(.headline)
                            .padding()
                            .frame(maxWidth: 220)
                            .background(Color(red: 176/255.0, green: 124/255.0, blue: 255/255.0))
                            .foregroundColor(.black)
                            .cornerRadius(12)
                        }
                        .padding(.top, 10)
                    }
                    .padding()
                }
                .transition(.opacity)
            }
        }
        .onAppear {
            if isLocked {
                triggerUnlock()
            }
        }
        .sheet(isPresented: $showSettings) {
            settingsSheet
        }
        .fullScreenCover(item: $activeStream) { stream in
            NativePlayerView(
                item: stream,
                serverURL: serverURL,
                onDismiss: { position, duration, completed in
                    self.progressUpdate = ProgressUpdate(position: position, duration: duration, completed: completed)
                    self.activeStream = nil
                }
            )
            .ignoresSafeArea()
        }
    }
    
    private var biometricIconName: String {
        switch BiometricAuth.shared.biometricType {
        case .faceID:
            return "faceid"
        case .touchID:
            return "touchid"
        case .opticID:
            return "opticid"
        case .none:
            return "lock.open.fill"
        }
    }
    
    private func triggerUnlock() {
        BiometricAuth.shared.authenticate { success, error in
            if success {
                withAnimation {
                    self.isLocked = false
                }
            }
        }
    }
    
    private var settingsSheet: some View {
        NavigationView {
            Form {
                Section(header: Text("Streaming Server Endpoint")) {
                    TextField("Server URL", text: $customURLInput)
                        .autocapitalization(.none)
                        .disableAutocorrection(true)
                        .keyboardType(.URL)
                    
                    Button("Reset to Comet on OVH (100.67.25.118:5173)") {
                        customURLInput = AppConfig.defaultServerURL
                    }
                    .font(.footnote)
                    .foregroundColor(Color(red: 176/255.0, green: 124/255.0, blue: 255/255.0))
                    
                    Button("Set to Desktop PC (100.71.101.21:8722)") {
                        customURLInput = AppConfig.defaultWorkstationURL
                    }
                    .font(.footnote)
                    .foregroundColor(.secondary)
                }
                
                Section(header: Text("Security")) {
                    Toggle("Face ID / Biometric Lock", isOn: $biometricToggle)
                        .onChange(of: biometricToggle) { newValue in
                            AppConfig.isBiometricLockEnabled = newValue
                        }
                }
                
                Section(header: Text("About")) {
                    HStack {
                        Text("Version")
                        Spacer()
                        Text(AppConfig.appVersion)
                            .foregroundColor(.secondary)
                    }
                    HStack {
                        Text("Network Target")
                        Spacer()
                        Text("Tailnet-First")
                            .foregroundColor(.secondary)
                    }
                    HStack {
                        Text("Default Backend")
                        Spacer()
                        Text("Comet (OVH :5173)")
                            .foregroundColor(.secondary)
                    }
                    HStack {
                        Text("Transcode Dispatch")
                        Spacer()
                        Text("OVH API -> PC")
                            .foregroundColor(.secondary)
                    }
                }
            }
            .navigationTitle("Settings")
            .navigationBarItems(
                leading: Button("Cancel") {
                    showSettings = false
                },
                trailing: Button("Save") {
                    if let newURL = URL(string: customURLInput) {
                        AppConfig.setServerURL(customURLInput)
                        self.serverURL = newURL
                        self.reloadToken += 1
                    }
                    showSettings = false
                }
                .foregroundColor(Color(red: 176/255.0, green: 124/255.0, blue: 255/255.0))
            )
        }
    }
}
