import SwiftUI

/// Displays grouped watch history synced with the backend (`watch-history:get-all`),
/// collapsing series into single expandable-context entries with swipe-to-delete and resume.
public struct HistoryView: View {
    public let onResumeProgress: (WatchProgressRecord) -> Void
    public let onSelectMedia: ((MediaItem) -> Void)?

    @ObservedObject private var lang = LanguageManager.shared

    @State private var groupedEntries: [GroupedHistoryEntry] = []
    @State private var isLoading: Bool = false
    @State private var errorMessage: String? = nil

    public init(
        onResumeProgress: @escaping (WatchProgressRecord) -> Void,
        onSelectMedia: ((MediaItem) -> Void)? = nil
    ) {
        self.onResumeProgress = onResumeProgress
        self.onSelectMedia = onSelectMedia
    }

    public var body: some View {
        NavigationStack {
            ZStack {
                Theme.background.ignoresSafeArea()

                if isLoading && groupedEntries.isEmpty {
                    ProgressView()
                        .tint(Theme.accent)
                        .scaleEffect(1.3)
                } else if let errorMessage, groupedEntries.isEmpty {
                    errorState(message: errorMessage)
                } else if groupedEntries.isEmpty {
                    emptyState
                } else {
                    List {
                        ForEach(groupedEntries) { entry in
                            historyRow(entry)
                                .listRowBackground(Color.clear)
                                .listRowSeparator(.hidden)
                                .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                    Button(role: .destructive) {
                                        Task { await deleteEntry(entry) }
                                    } label: {
                                        Label(tr("Remove", "Supprimer"), systemImage: "trash")
                                    }
                                }
                        }
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                    .refreshable {
                        await loadHistory()
                    }
                }
            }
            .navigationTitle(L10n.tabHistory)
            .navigationBarTitleDisplayMode(.large)
            .environment(\.locale, lang.locale)
            .task {
                await loadHistory()
            }
            .onReceive(NotificationCenter.default.publisher(for: .vaultStreamingCredentialsChanged)) { _ in
                Task { await loadHistory() }
            }
            .onReceive(NotificationCenter.default.publisher(for: .vaultStreamingLanguageChanged)) { _ in
                Task { await loadHistory() }
            }
        }
    }

    private func historyRow(_ entry: GroupedHistoryEntry) -> some View {
        let record = entry.primary
        let progressPercent = Int((record.progressFraction * 100).rounded())

        return Button {
            handleTap(entry)
        } label: {
            HStack(spacing: 14) {
                AsyncImage(url: record.posterUrl.flatMap(URL.init(string:))) { phase in
                    switch phase {
                    case .success(let img):
                        img.resizable().aspectRatio(contentMode: .fill)
                    default:
                        Theme.secondaryBackground
                            .overlay(Image(systemName: "film").foregroundColor(Theme.textTertiary))
                    }
                }
                .frame(width: 66, height: 98)
                .clipped()
                .cornerRadius(Theme.radiusSmall)

                VStack(alignment: .leading, spacing: 6) {
                    Text(record.title)
                        .font(.subheadline.bold())
                        .foregroundColor(Theme.textPrimary)
                        .lineLimit(1)

                    HStack(spacing: 8) {
                        if let s = record.season, let e = record.episode {
                            Text(L10n.shortSeasonEpisode(s, e))
                                .font(.caption2.bold())
                                .foregroundColor(Theme.accentSecondary)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Theme.accent.opacity(0.18))
                                .cornerRadius(4)
                        }

                        if record.mediaType == "tv", entry.episodeCount > 1 {
                            Text(L10n.episodeCount(entry.episodeCount))
                                .font(.caption2.weight(.semibold))
                                .foregroundColor(Theme.textSecondary)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Theme.secondaryBackground)
                                .cornerRadius(4)
                        }
                    }

                    ProgressView(value: record.completed ? 1.0 : record.progressFraction)
                        .tint(record.completed ? Theme.successGreen : Theme.accent)

                    HStack {
                        if record.completed {
                            Text(L10n.watched)
                                .font(.caption2.bold())
                                .foregroundColor(Theme.successGreen)
                        } else {
                            Text(L10n.percentCompleted(progressPercent))
                                .font(.caption2)
                                .foregroundColor(Theme.textTertiary)
                        }

                        Spacer()

                        if !record.completed, record.duration > 0, record.duration > record.position {
                            let minsLeft = max(1, Int((record.duration - record.position) / 60))
                            Text(L10n.minutesLeft(minsLeft))
                                .font(.caption2)
                                .foregroundColor(Theme.textTertiary)
                        }
                    }
                }

                Image(systemName: record.completed ? "info.circle" : "play.circle.fill")
                    .font(.title2)
                    .foregroundColor(record.completed ? Theme.accentSecondary : Theme.accent)
            }
            .padding(12)
            .background(Theme.cardBackground)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.radiusMedium)
                    .stroke(Theme.cardBorder, lineWidth: 1)
            )
            .cornerRadius(Theme.radiusMedium)
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button {
                onResumeProgress(record)
            } label: {
                Label(record.completed ? L10n.play : tr("Resume", "Reprendre"), systemImage: "play.fill")
            }

            if let onSelectMedia {
                Button {
                    onSelectMedia(mediaItem(from: record))
                } label: {
                    Label(L10n.details, systemImage: "info.circle")
                }
            }

            Divider()

            Button(role: .destructive) {
                Task { await deleteEntry(entry) }
            } label: {
                Label(tr("Remove from History", "Retirer de l'historique"), systemImage: "trash")
            }
        }
    }

    private func handleTap(_ entry: GroupedHistoryEntry) {
        let primary = entry.primary
        if primary.completed, let onSelectMedia {
            onSelectMedia(mediaItem(from: primary))
        } else {
            onResumeProgress(primary)
        }
    }

    private func mediaItem(from record: WatchProgressRecord) -> MediaItem {
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

    private var emptyState: some View {
        VStack(spacing: 14) {
            Image(systemName: "clock.arrow.circlepath")
                .font(.system(size: 52))
                .foregroundColor(Theme.textTertiary)
            Text(tr("No Watch History", "Aucun historique"))
                .font(.headline)
                .foregroundColor(Theme.textPrimary)
            Text(tr("Your partially watched and completed titles appear here automatically across devices.", "Vos titres commencés et terminés apparaissent automatiquement ici sur tous vos appareils."))
                .font(.subheadline)
                .foregroundColor(Theme.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
        }
    }

    private func errorState(message: String) -> some View {
        VStack(spacing: 14) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 40))
                .foregroundColor(.orange)
            Text(message)
                .font(.caption)
                .foregroundColor(Theme.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            Button {
                Task { await loadHistory() }
            } label: {
                Text(L10n.retry)
                    .font(.subheadline.bold())
                    .foregroundColor(.white)
                    .padding(.horizontal, 24)
                    .padding(.vertical, 10)
                    .background(Theme.accentGradient)
                    .cornerRadius(Theme.radiusMedium)
            }
        }
    }

    private func loadHistory() async {
        isLoading = true
        errorMessage = nil
        do {
            let items = try await Api.shared.fetchWatchHistory(limit: 200)
            groupedEntries = SeriesResumeHelper.groupedHistory(items)
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private func deleteEntry(_ entry: GroupedHistoryEntry) async {
        withAnimation(.easeInOut(duration: 0.2)) {
            groupedEntries.removeAll { $0.id == entry.id }
        }
        for ep in entry.episodes {
            await Api.shared.removeWatchHistory(
                mediaType: ep.mediaType,
                rawId: ep.rawTmdbId,
                title: ep.title,
                season: ep.season,
                episode: ep.episode
            )
        }
    }
}
