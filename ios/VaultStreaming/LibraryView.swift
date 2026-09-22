import SwiftUI

/// Native iOS Library View displaying saved and watchlisted media items.
public struct LibraryView: View {
    let watchlistedItems: [MediaItem]
    let onSelectMedia: (MediaItem) -> Void
    let onPlayMedia: (MediaItem) -> Void
    let onToggleWatchlist: (MediaItem) -> Void
    
    private let columns = [
        GridItem(.flexible(), spacing: 14),
        GridItem(.flexible(), spacing: 14)
    ]
    
    public init(
        watchlistedItems: [MediaItem],
        onSelectMedia: @escaping (MediaItem) -> Void,
        onPlayMedia: @escaping (MediaItem) -> Void,
        onToggleWatchlist: @escaping (MediaItem) -> Void
    ) {
        self.watchlistedItems = watchlistedItems
        self.onSelectMedia = onSelectMedia
        self.onPlayMedia = onPlayMedia
        self.onToggleWatchlist = onToggleWatchlist
    }
    
    public var body: some View {
        NavigationStack {
            ZStack {
                Theme.background
                    .ignoresSafeArea()
                
                if watchlistedItems.isEmpty {
                    emptyLibraryPrompt
                } else {
                    ScrollView(.vertical, showsIndicators: false) {
                        LazyVGrid(columns: columns, spacing: 18) {
                            ForEach(watchlistedItems) { item in
                                MediaCardView(
                                    item: item,
                                    isWatchlisted: true,
                                    onTap: { onSelectMedia(item) },
                                    onPlay: { onPlayMedia(item) },
                                    onWatchlistToggle: { onToggleWatchlist(item) }
                                )
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.top, 14)
                        .padding(.bottom, 24)
                    }
                }
            }
            .navigationTitle("Library")
            .navigationBarTitleDisplayMode(.large)
        }
    }
    
    private var emptyLibraryPrompt: some View {
        VStack(spacing: 12) {
            Image(systemName: "bookmark.slash")
                .font(.system(size: 44))
                .foregroundColor(Theme.textTertiary)
            Text("Your Library is Empty")
                .font(.headline)
                .foregroundColor(.white)
            Text("Tap the bookmark icon or long-press any title on Discover or Search to add it here.")
                .font(.caption)
                .foregroundColor(Theme.textTertiary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 80)
    }
}
