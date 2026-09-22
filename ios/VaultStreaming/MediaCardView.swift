import SwiftUI

/// Native SwiftUI poster card for movies and TV series.
/// Features high-performance async loading, floating metadata badges,
/// single-tap sheet invocation (no overlapping hover popups), and a native
/// iOS Context Menu (touch-and-hold long-press) with haptic feedback.
public struct MediaCardView: View {
    let item: MediaItem
    var isWatchlisted: Bool = false
    let onTap: () -> Void
    let onPlay: () -> Void
    let onWatchlistToggle: () -> Void
    
    public init(
        item: MediaItem,
        isWatchlisted: Bool = false,
        onTap: @escaping () -> Void,
        onPlay: @escaping () -> Void,
        onWatchlistToggle: @escaping () -> Void
    ) {
        self.item = item
        self.isWatchlisted = isWatchlisted
        self.onTap = onTap
        self.onPlay = onPlay
        self.onWatchlistToggle = onWatchlistToggle
    }
    
    public var body: some View {
        Button(action: {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            onTap()
        }) {
            VStack(alignment: .leading, spacing: 6) {
                // Poster Image Container
                ZStack(alignment: .topTrailing) {
                    posterImage
                        .aspectRatio(2.0 / 3.0, contentMode: .fit)
                        .cornerRadius(Theme.radiusMedium)
                        .overlay(
                            RoundedRectangle(cornerRadius: Theme.radiusMedium)
                                .stroke(Theme.cardBorder, lineWidth: 0.8)
                        )
                        .clipped()
                    
                    // Rating Badge
                    if let rating = item.vote_average, rating > 0 {
                        HStack(spacing: 3) {
                            Image(systemName: "star.fill")
                                .font(.system(size: 9))
                                .foregroundColor(Theme.ratingGold)
                            Text(String(format: "%.1f", rating))
                                .font(.system(size: 11, weight: .bold))
                                .foregroundColor(.white)
                        }
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(Color.black.opacity(0.75))
                        .cornerRadius(Theme.radiusSmall)
                        .padding(6)
                    }
                    
                    // Bookmark Indicator if in Library
                    if isWatchlisted {
                        VStack {
                            Spacer()
                            HStack {
                                Spacer()
                                Image(systemName: "bookmark.fill")
                                    .font(.system(size: 12))
                                    .foregroundColor(Theme.accent)
                                    .padding(6)
                                    .background(Color.black.opacity(0.8))
                                    .clipShape(Circle())
                                    .padding(6)
                            }
                        }
                    }
                }
                
                // Title and Release Year
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.displayTitle)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(Theme.textPrimary)
                        .lineLimit(1)
                    
                    HStack {
                        if !item.releaseYear.isEmpty {
                            Text(item.releaseYear)
                                .font(.system(size: 11, weight: .regular))
                                .foregroundColor(Theme.textTertiary)
                        }
                        
                        Spacer()
                        
                        Text(item.effectiveMediaType == "tv" ? "SERIES" : "FILM")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundColor(Theme.accent)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(Theme.accent.opacity(0.15))
                            .cornerRadius(3)
                    }
                }
                .padding(.horizontal, 2)
            }
        }
        .buttonStyle(PlainButtonStyle())
        // MARK: - Native iOS Long-Press Context Menu
        .contextMenu {
            Button(action: {
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                onPlay()
            }) {
                Label("Play Now", systemImage: "play.fill")
            }
            
            Button(action: {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                onWatchlistToggle()
            }) {
                Label(
                    isWatchlisted ? "Remove from Library" : "Add to Library",
                    systemImage: isWatchlisted ? "bookmark.slash.fill" : "bookmark.fill"
                )
            }
            
            Button(action: {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                onTap()
            }) {
                Label("View Details", systemImage: "info.circle")
            }
        }
    }
    
    @ViewBuilder
    private var posterImage: some View {
        if let url = item.posterURL {
            AsyncImage(url: url) { phase in
                switch phase {
                case .empty:
                    ZStack {
                        Theme.cardBackground
                        ProgressView()
                            .progressViewStyle(CircularProgressViewStyle(tint: Theme.accent))
                            .scaleEffect(0.8)
                    }
                case .success(let image):
                    image
                        .resizable()
                        .scaledToFill()
                case .failure:
                    posterFallback
                @unknown default:
                    posterFallback
                }
            }
        } else {
            posterFallback
        }
    }
    
    private var posterFallback: some View {
        ZStack {
            Theme.cardBackground
            VStack(spacing: 6) {
                Image(systemName: "film")
                    .font(.system(size: 28))
                    .foregroundColor(Theme.textTertiary)
                Text(item.displayTitle)
                    .font(.caption2)
                    .foregroundColor(Theme.textSecondary)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .padding(.horizontal, 4)
            }
        }
    }
}
