import SwiftUI

/// Native iOS bottom sheet for movie and series details.
/// Presents a rich backdrop, metadata, synopsis, direct Comet/Real-Debrid
/// stream list (with French indexer highlighting), and subtitle/AI management.
public struct MovieDetailsSheet: View {
    let item: MediaItem
    var isWatchlisted: Bool = false
    let onPlayStream: (TorrentStream) -> Void
    let onToggleWatchlist: () -> Void
    let onDismiss: () -> Void
    
    @State private var details: MediaDetails? = nil
    @State private var streams: [TorrentStream] = []
    @State private var isLoadingDetails: Bool = true
    @State private var isLoadingStreams: Bool = true
    @State private var streamError: String? = nil
    @State private var filterFrenchOnly: Bool = false
    @State private var isGeneratingAiSubtitles: Bool = false
    @State private var aiSubtitlesResult: String? = nil
    
    public init(
        item: MediaItem,
        isWatchlisted: Bool = false,
        onPlayStream: @escaping (TorrentStream) -> Void,
        onToggleWatchlist: @escaping () -> Void,
        onDismiss: @escaping () -> Void
    ) {
        self.item = item
        self.isWatchlisted = isWatchlisted
        self.onPlayStream = onPlayStream
        self.onToggleWatchlist = onToggleWatchlist
        self.onDismiss = onDismiss
    }
    
    public var body: some View {
        ZStack(alignment: .top) {
            Theme.background
                .ignoresSafeArea()
            
            ScrollView(.vertical, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    // Hero Backdrop Section
                    backdropHeader
                    
                    // Core Content
                    VStack(alignment: .leading, spacing: 20) {
                        // Title & Metadata
                        metadataHeader
                        
                        // Action Buttons
                        actionButtonsRow
                        
                        // Synopsis
                        synopsisSection
                        
                        // Streams Section
                        streamsSection
                        
                        // AI Subtitles Section
                        aiSubtitlesSection
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 16)
                    .padding(.bottom, 48)
                }
            }
            
            // Top Drag Handle & Close Button
            topBarControls
        }
        .task {
            await loadData()
        }
    }
    
    // MARK: - Views
    
    private var topBarControls: some View {
        HStack {
            Spacer()
            // Rounded Drag Indicator
            Capsule()
                .fill(Color.white.opacity(0.35))
                .frame(width: 36, height: 5)
                .padding(.top, 10)
            Spacer()
        }
        .overlay(
            HStack {
                Spacer()
                Button(action: onDismiss) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 28))
                        .foregroundColor(Color.white.opacity(0.75))
                        .padding(.trailing, 16)
                        .padding(.top, 12)
                }
            }
        )
    }
    
    private var backdropHeader: some View {
        ZStack(alignment: .bottom) {
            if let url = item.backdropURL ?? item.posterURL {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .scaledToFill()
                            .frame(height: 240)
                            .clipped()
                    default:
                        Theme.cardBackground
                            .frame(height: 240)
                    }
                }
            } else {
                Theme.cardBackground
                    .frame(height: 240)
            }
            
            // Gradient Fades
            LinearGradient(
                colors: [Color.clear, Theme.background],
                startPoint: .center,
                endPoint: .bottom
            )
            .frame(height: 180)
        }
    }
    
    private var metadataHeader: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(item.displayTitle)
                .font(.system(size: 24, weight: .bold))
                .foregroundColor(.white)
            
            HStack(spacing: 12) {
                if !item.releaseYear.isEmpty {
                    Text(item.releaseYear)
                        .font(.subheadline)
                        .foregroundColor(Theme.textSecondary)
                }
                
                if let dur = details?.formattedRuntime {
                    Text(dur)
                        .font(.subheadline)
                        .foregroundColor(Theme.textSecondary)
                }
                
                if let rating = item.vote_average, rating > 0 {
                    HStack(spacing: 4) {
                        Image(systemName: "star.fill")
                            .font(.caption)
                            .foregroundColor(Theme.ratingGold)
                        Text(String(format: "%.1f", rating))
                            .font(.subheadline)
                            .fontWeight(.semibold)
                            .foregroundColor(.white)
                    }
                }
                
                Text(item.effectiveMediaType == "tv" ? "TV Series" : "Movie")
                    .font(.caption)
                    .fontWeight(.bold)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Theme.accent.opacity(0.2))
                    .foregroundColor(Theme.accent)
                    .cornerRadius(4)
            }
            
            // Genres Pills
            if let genres = details?.genres, !genres.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(genres) { g in
                            Text(g.name)
                                .font(.caption)
                                .foregroundColor(Theme.textSecondary)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 4)
                                .background(Theme.cardBackground)
                                .cornerRadius(Theme.radiusPill)
                                .overlay(
                                    RoundedRectangle(cornerRadius: Theme.radiusPill)
                                        .stroke(Theme.cardBorder, lineWidth: 0.5)
                                )
                        }
                    }
                }
                .padding(.top, 4)
            }
        }
    }
    
    private var actionButtonsRow: some View {
        HStack(spacing: 12) {
            // Play Button
            Button(action: {
                if let topStream = visibleStreams.first {
                    onPlayStream(topStream)
                }
            }) {
                HStack(spacing: 8) {
                    Image(systemName: "play.fill")
                    Text(visibleStreams.isEmpty ? "Streams Below" : "Watch Top Stream")
                        .fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(Theme.accentGradient)
                .foregroundColor(.black)
                .cornerRadius(Theme.radiusMedium)
            }
            .disabled(visibleStreams.isEmpty)
            
            // Watchlist Toggle
            Button(action: onToggleWatchlist) {
                HStack(spacing: 6) {
                    Image(systemName: isWatchlisted ? "bookmark.fill" : "bookmark")
                        .foregroundColor(isWatchlisted ? Theme.accent : .white)
                    Text(isWatchlisted ? "Saved" : "Library")
                        .font(.subheadline)
                        .foregroundColor(.white)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
                .background(Theme.cardBackground)
                .cornerRadius(Theme.radiusMedium)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.radiusMedium)
                        .stroke(isWatchlisted ? Theme.accent : Theme.cardBorder, lineWidth: 1)
                )
            }
        }
    }
    
    private var synopsisSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Overview")
                .font(.headline)
                .foregroundColor(.white)
            
            Text(details?.overview ?? item.overview ?? "No synopsis available.")
                .font(.subheadline)
                .foregroundColor(Theme.textSecondary)
                .lineSpacing(4)
        }
    }
    
    private var streamsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Available Streams")
                    .font(.headline)
                    .foregroundColor(.white)
                
                Spacer()
                
                // French Streams Filter Toggle
                Button(action: {
                    withAnimation {
                        filterFrenchOnly.toggle()
                    }
                }) {
                    HStack(spacing: 4) {
                        Image(systemName: "flag.fill")
                            .font(.caption)
                        Text("French")
                            .font(.caption)
                            .fontWeight(.medium)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(filterFrenchOnly ? Theme.frenchAccent : Theme.cardBackground)
                    .foregroundColor(filterFrenchOnly ? .white : Theme.frenchAccent)
                    .cornerRadius(Theme.radiusPill)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.radiusPill)
                            .stroke(Theme.frenchAccent, lineWidth: 0.8)
                    )
                }
            }
            
            if isLoadingStreams {
                HStack {
                    Spacer()
                    VStack(spacing: 8) {
                        ProgressView()
                            .progressViewStyle(CircularProgressViewStyle(tint: Theme.accent))
                        Text("Querying Comet indexers...")
                            .font(.caption)
                            .foregroundColor(Theme.textTertiary)
                    }
                    .padding(.vertical, 24)
                    Spacer()
                }
            } else if let error = streamError {
                Text(error)
                    .font(.caption)
                    .foregroundColor(.orange)
                    .padding(.vertical, 8)
            } else if visibleStreams.isEmpty {
                VStack(spacing: 6) {
                    Text(filterFrenchOnly ? "No French streams found on Comet." : "No streams available.")
                        .font(.subheadline)
                        .foregroundColor(Theme.textTertiary)
                    if filterFrenchOnly {
                        Button("Show All Streams") {
                            filterFrenchOnly = false
                        }
                        .font(.caption)
                        .foregroundColor(Theme.accent)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 16)
            } else {
                VStack(spacing: 10) {
                    ForEach(visibleStreams) { stream in
                        streamRow(stream)
                    }
                }
            }
        }
    }
    
    private var visibleStreams: [TorrentStream] {
        if filterFrenchOnly {
            return streams.filter { $0.isFrench }
        }
        return streams
    }
    
    private func streamRow(_ stream: TorrentStream) -> some View {
        Button(action: {
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            onPlayStream(stream)
        }) {
            HStack(alignment: .center, spacing: 12) {
                // Play Icon Badge
                ZStack {
                    Circle()
                        .fill(stream.isCached ? Theme.accent.opacity(0.2) : Color.white.opacity(0.1))
                        .frame(width: 38, height: 38)
                    Image(systemName: "play.fill")
                        .font(.system(size: 14))
                        .foregroundColor(stream.isCached ? Theme.accent : .white)
                }
                
                // Stream Information
                VStack(alignment: .leading, spacing: 4) {
                    Text(stream.cleanReleaseTitle)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(.white)
                        .lineLimit(1)
                    
                    HStack(spacing: 8) {
                        // Resolution Badge
                        Text(stream.displayQuality)
                            .font(.system(size: 10, weight: .bold))
                            .foregroundColor(Theme.accent)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1)
                            .background(Theme.accent.opacity(0.15))
                            .cornerRadius(3)
                        
                        // French Indicator Badge
                        if stream.isFrench {
                            HStack(spacing: 3) {
                                Image(systemName: "flag.fill")
                                    .font(.system(size: 8))
                                Text("FR")
                                    .font(.system(size: 9, weight: .bold))
                            }
                            .foregroundColor(.white)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1)
                            .background(Theme.frenchAccent)
                            .cornerRadius(3)
                        }
                        
                        // Cached Debrid Status
                        if stream.isCached {
                            HStack(spacing: 3) {
                                Image(systemName: "bolt.fill")
                                    .font(.system(size: 8))
                                Text("Cached")
                                    .font(.system(size: 9, weight: .medium))
                            }
                            .foregroundColor(Theme.successGreen)
                        }
                        
                        if let s = stream.size, !s.isEmpty {
                            Text(s)
                                .font(.system(size: 10))
                                .foregroundColor(Theme.textTertiary)
                        }
                    }
                }
                
                Spacer()
                
                Image(systemName: "chevron.right")
                    .font(.system(size: 12))
                    .foregroundColor(Theme.textTertiary)
            }
            .padding(12)
            .background(Theme.cardBackground)
            .cornerRadius(Theme.radiusMedium)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.radiusMedium)
                    .stroke(stream.isFrench ? Theme.frenchAccent.opacity(0.5) : Theme.cardBorder, lineWidth: 1)
            )
        }
        .buttonStyle(PlainButtonStyle())
    }
    
    private var aiSubtitlesSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label("AI Subtitles Engine", systemImage: "sparkles")
                    .font(.headline)
                    .foregroundColor(Theme.accent)
                Spacer()
            }
            
            Text("Generate synchronized subtitles via the workstation Whisper/better-subtitles pipeline.")
                .font(.caption)
                .foregroundColor(Theme.textTertiary)
            
            if let notice = aiSubtitlesResult {
                Text(notice)
                    .font(.caption)
                    .foregroundColor(Theme.successGreen)
                    .padding(.vertical, 2)
            }
            
            Button(action: triggerAiSubtitles) {
                HStack(spacing: 8) {
                    if isGeneratingAiSubtitles {
                        ProgressView()
                            .progressViewStyle(CircularProgressViewStyle(tint: .white))
                            .scaleEffect(0.8)
                    } else {
                        Image(systemName: "captions.bubble.fill")
                    }
                    Text(isGeneratingAiSubtitles ? "Generating AI Subtitles..." : "Generate French AI Subtitles (-TranslateTo fr)")
                        .font(.caption)
                        .fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .background(Theme.cardBackground)
                .foregroundColor(.white)
                .cornerRadius(Theme.radiusMedium)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.radiusMedium)
                        .stroke(Theme.accent, lineWidth: 0.8)
                )
            }
            .disabled(isGeneratingAiSubtitles || visibleStreams.isEmpty)
        }
        .padding(.top, 8)
    }
    
    // MARK: - Actions
    
    private func loadData() async {
        // Load Details
        do {
            details = try await StreamingBackend.shared.fetchDetails(
                mediaType: item.effectiveMediaType,
                tmdbId: item.id
            )
            isLoadingDetails = false
        } catch {
            print("[MovieDetails] Failed to load details: \(error)")
            isLoadingDetails = false
        }
        
        // Load Streams
        do {
            let yearInt = Int(item.releaseYear)
            streams = try await StreamingBackend.shared.fetchStreams(
                mediaType: item.effectiveMediaType,
                tmdbId: item.id,
                title: item.displayTitle,
                year: yearInt
            )
            isLoadingStreams = false
        } catch {
            streamError = error.localizedDescription
            isLoadingStreams = false
        }
    }
    
    private func triggerAiSubtitles() {
        guard let stream = visibleStreams.first, let url = stream.url else { return }
        isGeneratingAiSubtitles = true
        aiSubtitlesResult = nil
        
        Task {
            do {
                if let track = try await StreamingBackend.shared.requestAiSubtitles(videoUrl: url, translateToFrench: true) {
                    aiSubtitlesResult = "Generated: \(track.label) (\(track.format.uppercased()))"
                } else {
                    aiSubtitlesResult = "AI subtitles generation dispatched."
                }
            } catch {
                aiSubtitlesResult = "AI subtitles error: \(error.localizedDescription)"
            }
            isGeneratingAiSubtitles = false
        }
    }
}
