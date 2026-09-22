import SwiftUI

/// Native iOS Discover feed featuring a hero banner, category filters,
/// responsive 2-column poster grid with zero horizontal overflow, and pull-to-refresh.
public struct DiscoverView: View {
    let onSelectMedia: (MediaItem) -> Void
    let onPlayMedia: (MediaItem) -> Void
    let watchlistIds: Set<Int>
    let onToggleWatchlist: (MediaItem) -> Void
    
    @State private var selectedCategory: String = "movie"
    @State private var items: [MediaItem] = []
    @State private var featuredItem: MediaItem? = nil
    @State private var isLoading: Bool = true
    @State private var errorMessage: String? = nil
    
    private let columns = [
        GridItem(.flexible(), spacing: 14),
        GridItem(.flexible(), spacing: 14)
    ]
    
    public init(
        onSelectMedia: @escaping (MediaItem) -> Void,
        onPlayMedia: @escaping (MediaItem) -> Void,
        watchlistIds: Set<Int>,
        onToggleWatchlist: @escaping (MediaItem) -> Void
    ) {
        self.onSelectMedia = onSelectMedia
        self.onPlayMedia = onPlayMedia
        self.watchlistIds = watchlistIds
        self.onToggleWatchlist = onToggleWatchlist
    }
    
    public var body: some View {
        NavigationStack {
            ZStack {
                Theme.background
                    .ignoresSafeArea()
                
                ScrollView(.vertical, showsIndicators: false) {
                    VStack(spacing: 20) {
                        // Category Segmented Selector
                        categoryPicker
                        
                        // Hero Featured Item Banner
                        if let featured = featuredItem {
                            featuredHeroBanner(featured)
                        }
                        
                        // Feed Content
                        if isLoading && items.isEmpty {
                            feedLoadingView
                        } else if let error = errorMessage, items.isEmpty {
                            feedErrorView(error)
                        } else {
                            mediaGrid
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 10)
                    .padding(.bottom, 24)
                }
                .refreshable {
                    await loadFeed()
                }
            }
            .navigationTitle("Discover")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    HStack(spacing: 4) {
                        Circle()
                            .fill(Theme.successGreen)
                            .frame(width: 7, height: 7)
                        Text("Tailnet")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundColor(Theme.textSecondary)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Theme.cardBackground)
                    .cornerRadius(Theme.radiusPill)
                }
            }
        }
        .task {
            await loadFeed()
        }
    }
    
    // MARK: - Subviews
    
    private var categoryPicker: some View {
        HStack(spacing: 12) {
            filterChip(title: "Movies", type: "movie", icon: "film")
            filterChip(title: "Series", type: "tv", icon: "tv")
        }
    }
    
    private func filterChip(title: String, type: String, icon: String) -> some View {
        let isSelected = (selectedCategory == type)
        return Button(action: {
            if selectedCategory != type {
                selectedCategory = type
                Task { await loadFeed() }
            }
        }) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.system(size: 13))
                Text(title)
                    .font(.system(size: 13, weight: .semibold))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 9)
            .background(isSelected ? Theme.accent : Theme.cardBackground)
            .foregroundColor(isSelected ? .black : .white)
            .cornerRadius(Theme.radiusSmall)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.radiusSmall)
                    .stroke(isSelected ? Theme.accent : Theme.cardBorder, lineWidth: 0.8)
            )
        }
        .buttonStyle(PlainButtonStyle())
    }
    
    private func featuredHeroBanner(_ item: MediaItem) -> some View {
        ZStack(alignment: .bottomLeading) {
            if let backdrop = item.backdropURL ?? item.posterURL {
                AsyncImage(url: backdrop) { phase in
                    if let image = phase.image {
                        image
                            .resizable()
                            .scaledToFill()
                            .frame(height: 190)
                            .clipped()
                    } else {
                        Theme.cardBackground
                            .frame(height: 190)
                    }
                }
            } else {
                Theme.cardBackground
                    .frame(height: 190)
            }
            
            // Gradient Overlay
            LinearGradient(
                colors: [Color.clear, Color.black.opacity(0.85)],
                startPoint: .top,
                endPoint: .bottom
            )
            
            // Content
            VStack(alignment: .leading, spacing: 6) {
                Text("FEATURED")
                    .font(.system(size: 10, weight: .black))
                    .foregroundColor(Theme.accent)
                    .tracking(1.5)
                
                Text(item.displayTitle)
                    .font(.system(size: 18, weight: .bold))
                    .foregroundColor(.white)
                    .lineLimit(1)
                
                HStack(spacing: 12) {
                    Button(action: { onPlayMedia(item) }) {
                        HStack(spacing: 6) {
                            Image(systemName: "play.fill")
                                .font(.system(size: 11))
                            Text("Play")
                                .font(.system(size: 12, weight: .bold))
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 7)
                        .background(Theme.accentGradient)
                        .foregroundColor(.black)
                        .cornerRadius(Theme.radiusSmall)
                    }
                    
                    Button(action: { onSelectMedia(item) }) {
                        HStack(spacing: 6) {
                            Image(systemName: "info.circle")
                                .font(.system(size: 11))
                            Text("Details")
                                .font(.system(size: 12, weight: .semibold))
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 7)
                        .background(Color.white.opacity(0.18))
                        .foregroundColor(.white)
                        .cornerRadius(Theme.radiusSmall)
                    }
                }
                .padding(.top, 2)
            }
            .padding(14)
        }
        .cornerRadius(Theme.radiusMedium)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.radiusMedium)
                .stroke(Theme.cardBorder, lineWidth: 0.8)
        )
    }
    
    private var mediaGrid: some View {
        LazyVGrid(columns: columns, spacing: 18) {
            ForEach(items) { item in
                MediaCardView(
                    item: item,
                    isWatchlisted: watchlistIds.contains(item.id),
                    onTap: { onSelectMedia(item) },
                    onPlay: { onPlayMedia(item) },
                    onWatchlistToggle: { onToggleWatchlist(item) }
                )
            }
        }
    }
    
    private var feedLoadingView: some View {
        VStack(spacing: 12) {
            ProgressView()
                .progressViewStyle(CircularProgressViewStyle(tint: Theme.accent))
                .scaleEffect(1.2)
            Text("Loading trending titles...")
                .font(.subheadline)
                .foregroundColor(Theme.textTertiary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 60)
    }
    
    private func feedErrorView(_ error: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 32))
                .foregroundColor(.orange)
            Text("Could not reach backend")
                .font(.headline)
                .foregroundColor(.white)
            Text(error)
                .font(.caption)
                .foregroundColor(Theme.textTertiary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
            
            Button("Retry") {
                Task { await loadFeed() }
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.accent)
            .foregroundColor(.black)
            .padding(.top, 8)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
    }
    
    // MARK: - Actions
    
    private func loadFeed() async {
        isLoading = true
        errorMessage = nil
        do {
            let fetched = try await StreamingBackend.shared.fetchDiscover(
                mediaType: selectedCategory,
                page: 1
            )
            items = fetched
            if let first = fetched.first {
                featuredItem = first
            }
            isLoading = false
        } catch {
            errorMessage = error.localizedDescription
            isLoading = false
        }
    }
}
