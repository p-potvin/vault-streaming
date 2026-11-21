import SwiftUI

/// Displays the user's saved/watchlisted media items in a responsive iPhone/iPad grid.
public struct LibraryView: View {
    public let watchlistedItems: [MediaItem]
    public let onSelectMedia: (MediaItem) -> Void
    public let onPlayMedia: (MediaItem) -> Void
    public let onToggleWatchlist: (MediaItem) -> Void

    @ObservedObject private var lang = LanguageManager.shared

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
                Theme.background.ignoresSafeArea()

                if watchlistedItems.isEmpty {
                    emptyLibraryPrompt
                } else {
                    GeometryReader { geo in
                        let columns = AdaptiveGrid.posterColumns(for: max(geo.size.width - 32, 300), spacing: 14)
                        ScrollView {
                            LazyVGrid(columns: columns, spacing: 18) {
                                ForEach(watchlistedItems) { item in
                                    MediaCardView(
                                        item: item,
                                        isWatchlisted: true,
                                        onTap: { onSelectMedia(item) },
                                        onPlay: { onPlayMedia(item) },
                                        onToggleWatchlist: { onToggleWatchlist(item) }
                                    )
                                }
                            }
                            .padding(.horizontal, 16)
                            .padding(.top, 12)
                            .padding(.bottom, 32)
                        }
                    }
                }
            }
            .navigationTitle(L10n.tabLibrary)
            .navigationBarTitleDisplayMode(.large)
            .environment(\.locale, lang.locale)
        }
    }

    private var emptyLibraryPrompt: some View {
        VStack(spacing: 14) {
            Image(systemName: "bookmark.slash")
                .font(.system(size: 52))
                .foregroundColor(Theme.textTertiary)
            Text(tr("Your Library is Empty", "Votre bibliothèque est vide"))
                .font(.headline)
                .foregroundColor(Theme.textPrimary)
            Text(tr("Tap the bookmark icon or long-press any title on Discover or Search to add it here.", "Appuyez sur le signet ou maintenez un titre sur Découvrir ou Rechercher pour l'ajouter ici."))
                .font(.subheadline)
                .foregroundColor(Theme.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
        }
    }
}
