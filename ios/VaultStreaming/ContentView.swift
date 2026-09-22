import SwiftUI

/// Main application entry point for Vault Streaming on iOS.
/// Implements a 100% native SwiftUI navigation hierarchy adhering to Apple HIG,
/// featuring a native TabBar, Biometric Face ID Lock overlay, sheet-based Details
/// (preventing double-popup collision), and full-screen AVPlayer video playback.
public struct ContentView: View {
    @State private var selectedTab: Int = 0
    @State private var selectedMedia: MediaItem? = nil
    @State private var activeStream: StreamPlaybackItem? = nil
    
    @State private var watchlistedItems: [MediaItem] = []
    @State private var isLocked: Bool = AppConfig.isBiometricLockEnabled
    
    private let watchlistStorageKey = "vw_ios_watchlist_items"
    
    public init() {}
    
    public var body: some View {
        ZStack {
            // Main Native App Tab Navigation
            TabView(selection: $selectedTab) {
                DiscoverView(
                    onSelectMedia: { item in selectedMedia = item },
                    onPlayMedia: { item in playTopStreamForMedia(item) },
                    watchlistIds: Set(watchlistedItems.map { $0.id }),
                    onToggleWatchlist: { item in toggleWatchlist(item) }
                )
                .tabItem {
                    Label("Discover", systemImage: "film")
                }
                .tag(0)
                
                SearchView(
                    onSelectMedia: { item in selectedMedia = item },
                    onPlayMedia: { item in playTopStreamForMedia(item) },
                    watchlistIds: Set(watchlistedItems.map { $0.id }),
                    onToggleWatchlist: { item in toggleWatchlist(item) }
                )
                .tabItem {
                    Label("Search", systemImage: "magnifyingglass")
                }
                .tag(1)
                
                LibraryView(
                    watchlistedItems: watchlistedItems,
                    onSelectMedia: { item in selectedMedia = item },
                    onPlayMedia: { item in playTopStreamForMedia(item) },
                    onToggleWatchlist: { item in toggleWatchlist(item) }
                )
                .tabItem {
                    Label("Library", systemImage: "bookmark")
                }
                .tag(2)
                
                HistoryView(
                    onResumeProgress: { record in resumeHistoryPlayback(record) }
                )
                .tabItem {
                    Label("History", systemImage: "clock")
                }
                .tag(3)
                
                SettingsView()
                    .tabItem {
                        Label("Settings", systemImage: "gearshape")
                    }
                    .tag(4)
            }
            .tint(Theme.accent)
            
            // Biometric Face ID / Touch ID Lock Screen
            if isLocked {
                biometricLockOverlay
            }
        }
        .onAppear {
            loadWatchlist()
            if isLocked {
                triggerUnlock()
            }
        }
        // Native Bottom Sheet for Movie/TV Details (Single popup, zero hover-card collision)
        .sheet(item: $selectedMedia) { item in
            MovieDetailsSheet(
                item: item,
                isWatchlisted: watchlistedItems.contains(where: { $0.id == item.id }),
                onPlayStream: { stream in
                    selectedMedia = nil
                    playStream(stream, for: item)
                },
                onToggleWatchlist: {
                    toggleWatchlist(item)
                },
                onDismiss: {
                    selectedMedia = nil
                }
            )
        }
        // Native AVPlayer Full-Screen Video Playback
        .fullScreenCover(item: $activeStream) { stream in
            NativePlayerView(
                item: stream,
                serverURL: AppConfig.serverURL,
                onDismiss: { position, duration, completed in
                    handlePlaybackDismiss(stream: stream, position: position, duration: duration, completed: completed)
                    activeStream = nil
                }
            )
            .ignoresSafeArea()
        }
    }
    
    // MARK: - Playback Handling
    
    private func playTopStreamForMedia(_ item: MediaItem) {
        Task {
            do {
                let yearInt = Int(item.releaseYear)
                let streams = try await StreamingBackend.shared.fetchStreams(
                    mediaType: item.effectiveMediaType,
                    tmdbId: item.id,
                    title: item.displayTitle,
                    year: yearInt
                )
                if let topStream = streams.first {
                    await MainActor.run {
                        playStream(topStream, for: item)
                    }
                } else {
                    // Open details if no direct top stream
                    await MainActor.run {
                        selectedMedia = item
                    }
                }
            } catch {
                await MainActor.run {
                    selectedMedia = item
                }
            }
        }
    }
    
    private func playStream(_ stream: TorrentStream, for item: MediaItem) {
        guard let urlStr = stream.url, let streamURL = URL(string: urlStr) else { return }
        let playbackItem = StreamPlaybackItem(
            url: streamURL,
            title: item.displayTitle,
            posterUrl: item.posterURL?.absoluteString,
            startPosition: 0,
            mediaType: item.effectiveMediaType
        )
        activeStream = playbackItem
    }
    
    private func resumeHistoryPlayback(_ record: WatchProgressRecord) {
        Task {
            do {
                let streams = try await StreamingBackend.shared.fetchStreams(
                    mediaType: record.mediaType,
                    tmdbId: record.tmdbId,
                    title: record.title,
                    season: record.season,
                    episode: record.episode
                )
                guard let topStream = streams.first, let urlStr = topStream.url, let streamURL = URL(string: urlStr) else { return }
                await MainActor.run {
                    activeStream = StreamPlaybackItem(
                        url: streamURL,
                        title: record.title,
                        posterUrl: record.posterUrl,
                        startPosition: record.position,
                        mediaType: record.mediaType,
                        season: record.season,
                        episode: record.episode
                    )
                }
            } catch {
                print("[ContentView] Could not resume playback: \(error)")
            }
        }
    }
    
    private func handlePlaybackDismiss(stream: StreamPlaybackItem, position: Double, duration: Double, completed: Bool) {
        Task {
            await StreamingBackend.shared.recordProgress(
                mediaType: stream.mediaType ?? "movie",
                tmdbId: 0, // TMDB ID if stored in metadata
                title: stream.title,
                position: position,
                duration: duration,
                completed: completed,
                posterUrl: stream.posterUrl,
                season: stream.season,
                episode: stream.episode
            )
        }
    }
    
    // MARK: - Watchlist Persistence
    
    private func toggleWatchlist(_ item: MediaItem) {
        if let idx = watchlistedItems.firstIndex(where: { $0.id == item.id }) {
            watchlistedItems.remove(at: idx)
        } else {
            watchlistedItems.append(item)
        }
        saveWatchlist()
    }
    
    private func saveWatchlist() {
        if let data = try? JSONEncoder().encode(watchlistedItems) {
            UserDefaults.standard.set(data, forKey: watchlistStorageKey)
        }
    }
    
    private func loadWatchlist() {
        if let data = UserDefaults.standard.data(forKey: watchlistStorageKey),
           let items = try? JSONDecoder().decode([MediaItem].self, from: data) {
            watchlistedItems = items
        }
    }
    
    // MARK: - Biometric Security
    
    private var biometricLockOverlay: some View {
        ZStack {
            Theme.background
                .ignoresSafeArea()
            
            VStack(spacing: 20) {
                Image(systemName: "film.stack.fill")
                    .font(.system(size: 64))
                    .foregroundColor(Theme.accent)
                
                Text("Vault Streaming")
                    .font(.title)
                    .fontWeight(.bold)
                    .foregroundColor(.white)
                
                Text("Library protected by Face ID")
                    .font(.subheadline)
                    .foregroundColor(Theme.textSecondary)
                
                Button(action: triggerUnlock) {
                    HStack(spacing: 8) {
                        Image(systemName: "faceid")
                        Text("Unlock with Face ID")
                    }
                    .font(.headline)
                    .padding(.horizontal, 24)
                    .padding(.vertical, 14)
                    .background(Theme.accentGradient)
                    .foregroundColor(.black)
                    .cornerRadius(Theme.radiusMedium)
                }
                .padding(.top, 12)
            }
            .padding()
        }
        .transition(.opacity)
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
}
