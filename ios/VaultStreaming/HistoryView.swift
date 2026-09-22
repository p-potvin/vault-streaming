import SwiftUI

/// Native iOS History View displaying Continue Watching items with visual progress bars.
public struct HistoryView: View {
    let onResumeProgress: (WatchProgressRecord) -> Void
    
    @State private var history: [WatchProgressRecord] = []
    @State private var isLoading: Bool = true
    
    public init(onResumeProgress: @escaping (WatchProgressRecord) -> Void) {
        self.onResumeProgress = onResumeProgress
    }
    
    public var body: some View {
        NavigationStack {
            ZStack {
                Theme.background
                    .ignoresSafeArea()
                
                if isLoading && history.isEmpty {
                    VStack {
                        ProgressView()
                            .progressViewStyle(CircularProgressViewStyle(tint: Theme.accent))
                        Text("Loading watch history...")
                            .font(.caption)
                            .foregroundColor(Theme.textTertiary)
                            .padding(.top, 8)
                    }
                } else if history.isEmpty {
                    emptyHistoryPrompt
                } else {
                    ScrollView(.vertical, showsIndicators: false) {
                        LazyVStack(spacing: 12) {
                            ForEach(history) { record in
                                historyRow(record)
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.top, 14)
                        .padding(.bottom, 24)
                    }
                    .refreshable {
                        await loadHistory()
                    }
                }
            }
            .navigationTitle("History")
            .navigationBarTitleDisplayMode(.large)
        }
        .task {
            await loadHistory()
        }
    }
    
    private var emptyHistoryPrompt: some View {
        VStack(spacing: 12) {
            Image(systemName: "clock.arrow.circlepath")
                .font(.system(size: 44))
                .foregroundColor(Theme.textTertiary)
            Text("No Watch History")
                .font(.headline)
                .foregroundColor(.white)
            Text("Items you stream will automatically appear here with your saved playback positions.")
                .font(.caption)
                .foregroundColor(Theme.textTertiary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 80)
    }
    
    private func historyRow(_ record: WatchProgressRecord) -> some View {
        Button(action: {
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            onResumeProgress(record)
        }) {
            HStack(spacing: 14) {
                // Poster thumbnail with progress bar
                ZStack(alignment: .bottom) {
                    if let p = record.posterUrl, let url = URL(string: p) {
                        AsyncImage(url: url) { phase in
                            if let img = phase.image {
                                img.resizable().scaledToFill()
                            } else {
                                Theme.cardBackground
                            }
                        }
                        .frame(width: 70, height: 100)
                        .clipped()
                    } else {
                        Theme.cardBackground
                            .frame(width: 70, height: 100)
                    }
                    
                    // Progress Bar at Bottom of Thumbnail
                    GeometryReader { geo in
                        VStack {
                            Spacer()
                            ZStack(alignment: .leading) {
                                Rectangle()
                                    .fill(Color.black.opacity(0.6))
                                    .frame(height: 4)
                                Rectangle()
                                    .fill(Theme.accent)
                                    .frame(width: geo.size.width * CGFloat(record.progressFraction), height: 4)
                            }
                        }
                    }
                }
                .frame(width: 70, height: 100)
                .cornerRadius(Theme.radiusSmall)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.radiusSmall)
                        .stroke(Theme.cardBorder, lineWidth: 0.5)
                )
                
                // Details
                VStack(alignment: .leading, spacing: 6) {
                    Text(record.title)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundColor(.white)
                        .lineLimit(2)
                    
                    if let s = record.season, let e = record.episode {
                        Text("Season \(s) · Episode \(e)")
                            .font(.caption)
                            .foregroundColor(Theme.accent)
                    } else {
                        Text(record.mediaType.uppercased())
                            .font(.caption2)
                            .fontWeight(.bold)
                            .foregroundColor(Theme.textTertiary)
                    }
                    
                    let progressPercent = Int(record.progressFraction * 100)
                    Text("\(progressPercent)% completed")
                        .font(.caption2)
                        .foregroundColor(Theme.textSecondary)
                }
                
                Spacer()
                
                // Play Resume Button
                Image(systemName: "play.circle.fill")
                    .font(.system(size: 28))
                    .foregroundColor(Theme.accent)
                    .padding(.trailing, 4)
            }
            .padding(10)
            .background(Theme.cardBackground)
            .cornerRadius(Theme.radiusMedium)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.radiusMedium)
                    .stroke(Theme.cardBorder, lineWidth: 0.8)
            )
        }
        .buttonStyle(PlainButtonStyle())
    }
    
    private func loadHistory() async {
        isLoading = true
        do {
            let fetched = try await StreamingBackend.shared.fetchContinueWatching()
            history = fetched
            isLoading = false
        } catch {
            print("[History] Failed to load continue watching: \(error)")
            isLoading = false
        }
    }
}
