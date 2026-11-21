import SwiftUI

/// Main application entry point for Vault Streaming on iOS & iPadOS.
/// Features adaptive iPhone TabBar / iPad NavigationSplitView, First-Run authentication gate,
/// Biometric Face ID lock overlay, StreamResolver queue overlay, sheet-based Details, and AVPlayer playback.
public struct ContentView: View {
    @ObservedObject private var backend = Api.shared
    @ObservedObject private var lang = LanguageManager.shared

    @State private var selectedTab: Int = 0
    @State private var selectedMedia: MediaItem? = nil
    @State private var activeStream: StreamPlaybackItem? = nil

    // Cancelable stream-resolution HUD state
    @State private var isResolvingStream: Bool = false
    @State private var resolvingTitle: String = ""
    @State private var resolveStatus: String = ""
    @State private var resolveError: String? = nil
    @State private var resolveTask: Task<Void, Never>? = nil
    @State private var retryAction: (() -> Void)? = nil
    @State private var fallbackMediaForResolve: MediaItem? = nil

    @State private var watchlistedItems: [MediaItem] = []
    @State private var isLocked: Bool = AppConfig.isBiometricLockEnabled

    private let watchlistStorageKey = "vw_ios_watchlist_items"

    public init() {}

    public var body: some View {
        ZStack {
            if backend.requiresAuth || !AppConfig.hasCredentials {
                FirstRunConnectView()
            } else if AdaptiveGrid.isPad {
                iPadSplitView
            } else {
                mainTabView
            }

            if isResolvingStream {
                streamResolvingOverlay
            }

            if isLocked {
                biometricLockOverlay
            }
        }
        .environment(\.locale, lang.locale)
        .onAppear {
            loadWatchlist()
            if isLocked {
                triggerUnlock()
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .vaultStreamingShouldLock)) { _ in
            if AppConfig.isBiometricLockEnabled {
                // the lock overlay covers this view only: a details sheet or the full-screen player sit above it,
                // so close them (the player saves its position as it closes) before locking
                selectedMedia = nil
                activeStream = nil
                isLocked = true
                triggerUnlock()
            }
        }
        // Native Bottom Sheet for Movie/TV Details
        .sheet(item: $selectedMedia) { item in
            MovieDetailsSheet(
                item: item,
                isWatchlisted: watchlistedItems.contains(where: { $0.id == item.id }),
                onPlayStream: { stream in
                    selectedMedia = nil
                    startPlayback(
                        mediaType: item.effectiveMediaType,
                        tmdbId: item.tmdbId,
                        rawId: item.rawId,
                        title: item.displayTitle,
                        posterUrl: item.posterURL?.absoluteString,
                        year: item.releaseYear,
                        season: nil,
                        episode: nil,
                        manualPick: stream,
                        fallbackItem: item
                    )
                },
                onPlayAuto: { chosenItem, season, episode, startPos in
                    selectedMedia = nil
                    startPlayback(
                        mediaType: chosenItem.effectiveMediaType,
                        tmdbId: chosenItem.tmdbId,
                        rawId: chosenItem.rawId,
                        title: chosenItem.displayTitle,
                        posterUrl: chosenItem.posterURL?.absoluteString,
                        year: chosenItem.releaseYear,
                        season: season,
                        episode: episode,
                        overrideStartPosition: startPos,
                        fallbackItem: chosenItem
                    )
                },
                onPlayEpisodeStream: { stream, season, episode in
                    selectedMedia = nil
                    startPlayback(
                        mediaType: "tv",
                        tmdbId: item.tmdbId,
                        rawId: item.rawId,
                        title: item.displayTitle,
                        posterUrl: item.posterURL?.absoluteString,
                        year: item.releaseYear,
                        season: season,
                        episode: episode,
                        manualPick: stream,
                        fallbackItem: item
                    )
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

    // MARK: - iPhone TabBar & iPad Sidebar

    private var mainTabView: some View {
        TabView(selection: $selectedTab) {
            discoverScreen
                .tabItem { Label(L10n.tabDiscover, systemImage: "film") }
                .tag(0)

            searchScreen
                .tabItem { Label(L10n.tabSearch, systemImage: "magnifyingglass") }
                .tag(1)

            libraryScreen
                .tabItem { Label(L10n.tabLibrary, systemImage: "bookmark") }
                .tag(2)

            historyScreen
                .tabItem { Label(L10n.tabHistory, systemImage: "clock") }
                .tag(3)

            SettingsView()
                .tabItem { Label(L10n.tabSettings, systemImage: "gearshape") }
                .tag(4)
        }
        .tint(Theme.accent)
    }

    private var iPadSplitView: some View {
        NavigationSplitView {
            List(selection: Binding<Int?>(
                get: { selectedTab },
                set: { if let v = $0 { selectedTab = v } }
            )) {
                Label(L10n.tabDiscover, systemImage: "film").tag(0)
                Label(L10n.tabSearch, systemImage: "magnifyingglass").tag(1)
                Label(L10n.tabLibrary, systemImage: "bookmark").tag(2)
                Label(L10n.tabHistory, systemImage: "clock").tag(3)
                Label(L10n.tabSettings, systemImage: "gearshape").tag(4)
            }
            .navigationTitle("Vault Streaming")
            .scrollContentBackground(.hidden)
            .background(Theme.secondaryBackground)
        } detail: {
            switch selectedTab {
            case 1:
                searchScreen
            case 2:
                libraryScreen
            case 3:
                historyScreen
            case 4:
                SettingsView()
            default:
                discoverScreen
            }
        }
        .tint(Theme.accent)
    }

    private var discoverScreen: some View {
        DiscoverView(
            onSelectMedia: { item in selectedMedia = item },
            onPlayMedia: { item in playTopStreamForMedia(item) },
            onResumeProgress: { record in resumeHistoryPlayback(record) },
            watchlistIds: Set(watchlistedItems.map { $0.id }),
            onToggleWatchlist: { item in toggleWatchlist(item) }
        )
    }

    private var searchScreen: some View {
        SearchView(
            onSelectMedia: { item in selectedMedia = item },
            onPlayMedia: { item in playTopStreamForMedia(item) },
            watchlistIds: Set(watchlistedItems.map { $0.id }),
            onToggleWatchlist: { item in toggleWatchlist(item) }
        )
    }

    private var libraryScreen: some View {
        LibraryView(
            watchlistedItems: watchlistedItems,
            onSelectMedia: { item in selectedMedia = item },
            onPlayMedia: { item in playTopStreamForMedia(item) },
            onToggleWatchlist: { item in toggleWatchlist(item) }
        )
    }

    private var historyScreen: some View {
        HistoryView(
            onResumeProgress: { record in resumeHistoryPlayback(record) },
            onSelectMedia: { item in selectedMedia = item }
        )
    }

    // MARK: - Playback Orchestration

    private func playTopStreamForMedia(_ item: MediaItem) {
        if item.effectiveMediaType == "tv" {
            cancelResolution()
            isResolvingStream = true
            resolvingTitle = item.displayTitle
            resolveStatus = tr("Checking episode progress…", "Vérification de la progression…")
            resolveError = nil
            fallbackMediaForResolve = item
            retryAction = { playTopStreamForMedia(item) }

            resolveTask = Task {
                async let prog = Api.shared.fetchShowProgress(rawId: item.rawId, title: item.displayTitle)
                async let seasons = SeriesResumeHelper.seasonsOf(rawId: item.rawId)
                let (items, availableSeasons) = await (prog, seasons)
                if Task.isCancelled { return }

                let target = SeriesResumeHelper.pickResumeTarget(items: items, seasons: availableSeasons)
                let season = target?.season ?? availableSeasons.first?.season_number ?? 1
                let episode = target?.episode ?? 1
                let startPos = (target?.kind == .resume) ? target?.positionSec : 0

                await executeResolution(
                    mediaType: "tv",
                    tmdbId: item.tmdbId,
                    rawId: item.rawId,
                    title: item.displayTitle,
                    posterUrl: item.posterURL?.absoluteString,
                    year: item.releaseYear,
                    season: season,
                    episode: episode,
                    manualPick: nil,
                    overrideStartPosition: startPos
                )
            }
            return
        }

        startPlayback(
            mediaType: item.effectiveMediaType,
            tmdbId: item.tmdbId,
            rawId: item.rawId,
            title: item.displayTitle,
            posterUrl: item.posterURL?.absoluteString,
            year: item.releaseYear,
            fallbackItem: item
        )
    }

    private func resumeHistoryPlayback(_ record: WatchProgressRecord) {
        // a finished episode: go on with the series' next one rather than replay it (js/continue-watching.js)
        if record.mediaType == "tv" && record.completed {
            let rawId = record.rawTmdbId.isEmpty ? record.title : record.rawTmdbId
            Task { @MainActor in
                let shown = await Api.shared.fetchShowProgress(rawId: record.rawTmdbId, title: record.title)
                let seasons = await SeriesResumeHelper.seasonsOf(rawId: rawId)
                if let target = SeriesResumeHelper.pickResumeTarget(items: shown.isEmpty ? [record] : shown, seasons: seasons) {
                    startPlayback(
                        mediaType: "tv",
                        tmdbId: record.tmdbId,
                        rawId: rawId,
                        title: record.title,
                        posterUrl: record.posterUrl,
                        year: record.year,
                        season: target.season,
                        episode: target.episode,
                        overrideStartPosition: target.kind == .resume && target.positionSec > 5 ? target.positionSec : nil,
                        fallbackItem: historyFallbackItem(record)
                    )
                } else {
                    startHistoryRecord(record)
                }
            }
            return
        }
        startHistoryRecord(record)
    }

    private func historyFallbackItem(_ record: WatchProgressRecord) -> MediaItem {
        MediaItem(
            id: record.tmdbId ?? abs(record.title.hashValue),
            rawId: record.rawTmdbId.isEmpty ? record.title : record.rawTmdbId,
            tmdbId: record.tmdbId,
            title: record.mediaType == "movie" ? record.title : nil,
            name: record.mediaType == "tv" ? record.title : nil,
            poster: record.posterUrl,
            year: record.year,
            media_type: record.mediaType
        )
    }

    private func startHistoryRecord(_ record: WatchProgressRecord) {
        let fallback = historyFallbackItem(record)
        let startPos: Double? = (!record.completed && record.position > 5) ? record.position : nil

        startPlayback(
            mediaType: record.mediaType,
            tmdbId: record.tmdbId,
            rawId: record.rawTmdbId.isEmpty ? record.title : record.rawTmdbId,
            title: record.title,
            posterUrl: record.posterUrl,
            year: record.year,
            season: record.season,
            episode: record.episode,
            overrideStartPosition: startPos,
            fallbackItem: fallback
        )
    }

    private func startPlayback(
        mediaType: String,
        tmdbId: Int?,
        rawId: String,
        title: String,
        posterUrl: String?,
        year: String?,
        season: Int? = nil,
        episode: Int? = nil,
        manualPick: TorrentStream? = nil,
        overrideStartPosition: Double? = nil,
        fallbackItem: MediaItem? = nil
    ) {
        cancelResolution()
        isResolvingStream = true
        resolvingTitle = title
        resolveStatus = L10n.loading
        resolveError = nil
        fallbackMediaForResolve = fallbackItem
        retryAction = {
            startPlayback(
                mediaType: mediaType,
                tmdbId: tmdbId,
                rawId: rawId,
                title: title,
                posterUrl: posterUrl,
                year: year,
                season: season,
                episode: episode,
                manualPick: manualPick,
                overrideStartPosition: overrideStartPosition,
                fallbackItem: fallbackItem
            )
        }

        resolveTask = Task {
            await executeResolution(
                mediaType: mediaType,
                tmdbId: tmdbId,
                rawId: rawId,
                title: title,
                posterUrl: posterUrl,
                year: year,
                season: season,
                episode: episode,
                manualPick: manualPick,
                overrideStartPosition: overrideStartPosition
            )
        }
    }

    private func executeResolution(
        mediaType: String,
        tmdbId: Int?,
        rawId: String,
        title: String,
        posterUrl: String?,
        year: String?,
        season: Int?,
        episode: Int?,
        manualPick: TorrentStream?,
        overrideStartPosition: Double?
    ) async {
        // 1) Consume preloaded next-episode stream if ready
        if manualPick == nil, mediaType == "tv", let s = season, let e = episode {
            if let preloaded = await NextEpisodePreloader.shared.takePreloaded(
                rawId: rawId,
                title: title,
                season: s,
                episode: e
            ) {
                if Task.isCancelled { return }
                await MainActor.run {
                    isResolvingStream = false
                    activeStream = StreamPlaybackItem(
                        url: preloaded.streamURL,
                        title: title,
                        posterUrl: posterUrl,
                        year: year,
                        startPosition: overrideStartPosition ?? preloaded.startPosition,
                        mediaType: mediaType,
                        tmdbId: tmdbId,
                        rawId: rawId,
                        season: season,
                        episode: episode,
                        sourceStream: preloaded.stream,
                        candidates: preloaded.candidates
                    )
                }
                return
            }
        }

        let yearInt = year.flatMap { Int($0.prefix(4)) }
        do {
            let outcome = try await StreamResolver.shared.resolvePlayableStream(
                mediaType: mediaType,
                tmdbId: tmdbId,
                rawId: rawId,
                title: title,
                year: yearInt,
                season: season,
                episode: episode,
                manualPick: manualPick,
                skipLastSource: false,
                statusCallback: { msg in
                    Task { @MainActor in
                        if isResolvingStream {
                            resolveStatus = msg
                        }
                    }
                }
            )
            if Task.isCancelled { return }

            await MainActor.run {
                isResolvingStream = false
                activeStream = StreamPlaybackItem(
                    url: outcome.streamURL,
                    title: title,
                    posterUrl: posterUrl,
                    year: year,
                    startPosition: overrideStartPosition ?? outcome.startPosition,
                    mediaType: mediaType,
                    tmdbId: tmdbId,
                    rawId: rawId,
                    season: season,
                    episode: episode,
                    sourceStream: outcome.stream,
                    candidates: outcome.candidates
                )
            }
        } catch {
            if Task.isCancelled { return }
            await MainActor.run {
                resolveError = error.localizedDescription
            }
        }
    }

    private func cancelResolution() {
        resolveTask?.cancel()
        resolveTask = nil
        isResolvingStream = false
        resolveError = nil
    }

    private var streamResolvingOverlay: some View {
        ZStack {
            Color.black.opacity(0.72)
                .ignoresSafeArea()

            VStack(spacing: 16) {
                if let err = resolveError {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 34))
                        .foregroundColor(.orange)

                    Text(resolvingTitle)
                        .font(.headline)
                        .foregroundColor(Theme.textPrimary)
                        .lineLimit(1)

                    Text(err)
                        .font(.subheadline)
                        .foregroundColor(Theme.textSecondary)
                        .multilineTextAlignment(.center)

                    HStack(spacing: 10) {
                        Button(L10n.cancel) {
                            cancelResolution()
                        }
                        .font(.subheadline.weight(.semibold))
                        .foregroundColor(Theme.textSecondary)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 9)
                        .background(Theme.cardBackground)
                        .cornerRadius(Theme.radiusSmall)

                        if let fallback = fallbackMediaForResolve {
                            Button(L10n.details) {
                                cancelResolution()
                                selectedMedia = fallback
                            }
                            .font(.subheadline.weight(.semibold))
                            .foregroundColor(Theme.textPrimary)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 9)
                            .background(Theme.secondaryBackground)
                            .cornerRadius(Theme.radiusSmall)
                        }

                        if let retryAction {
                            Button(L10n.retry) {
                                retryAction()
                            }
                            .font(.subheadline.bold())
                            .foregroundColor(.white)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 9)
                            .background(Theme.accentGradient)
                            .cornerRadius(Theme.radiusSmall)
                        }
                    }
                } else {
                    ProgressView()
                        .progressViewStyle(CircularProgressViewStyle(tint: Theme.accent))
                        .scaleEffect(1.3)

                    Text(resolvingTitle)
                        .font(.headline)
                        .foregroundColor(Theme.textPrimary)
                        .lineLimit(1)

                    Text(resolveStatus)
                        .font(.subheadline)
                        .foregroundColor(Theme.textSecondary)
                        .multilineTextAlignment(.center)

                    Button(L10n.cancel) {
                        cancelResolution()
                    }
                    .font(.caption.weight(.semibold))
                    .foregroundColor(Theme.textSecondary)
                    .padding(.top, 4)
                }
            }
            .padding(24)
            .frame(maxWidth: 360)
            .background(Theme.cardBackground)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.radiusLarge)
                    .stroke(Theme.cardBorder, lineWidth: 1)
            )
            .cornerRadius(Theme.radiusLarge)
            .padding(24)
        }
    }

    private func handlePlaybackDismiss(stream: StreamPlaybackItem, position: Double, duration: Double, completed: Bool) {
        // Nothing to save here: PlayerViewModel.cleanup() writes the final position against the episode actually
        // playing. `stream` is the item the cover opened with, so after Next episode a second write here put
        // episode 2's position on episode 1.
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

                Text(tr("Library protected by Face ID", "Bibliothèque protégée par Face ID"))
                    .font(.subheadline)
                    .foregroundColor(Theme.textSecondary)

                Button(action: triggerUnlock) {
                    HStack(spacing: 8) {
                        Image(systemName: "faceid")
                        Text(tr("Unlock with Face ID", "Déverrouiller avec Face ID"))
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
        BiometricAuth.shared.authenticate(
            reason: tr("Unlock Vault Streaming", "Déverrouiller Vault Streaming")
        ) { success, _ in
            if success {
                withAnimation {
                    self.isLocked = false
                }
            }
        }
    }
}
