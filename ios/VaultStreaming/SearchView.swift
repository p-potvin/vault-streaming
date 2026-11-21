import SwiftUI

/// Native Search view supporting debounced live catalog queries across TMDB and RAGGAE,
/// media type filters (`all` / `movie` / `tv`), live localization, and responsive iPad/iPhone grids.
public struct SearchView: View {
    public let onSelectMedia: (MediaItem) -> Void
    public let onPlayMedia: (MediaItem) -> Void
    public let watchlistIds: Set<Int>
    public let onToggleWatchlist: (MediaItem) -> Void

    @ObservedObject private var lang = LanguageManager.shared

    @State private var query: String = ""
    @State private var selectedFilter: String = "all"
    @State private var results: [MediaItem] = []
    @State private var isSearching: Bool = false
    @State private var errorMessage: String? = nil
    @State private var searchTask: Task<Void, Never>? = nil

    private var filteredResults: [MediaItem] {
        switch selectedFilter {
        case "movie":
            return results.filter { $0.effectiveMediaType == "movie" }
        case "tv":
            return results.filter { $0.effectiveMediaType == "tv" }
        default:
            return results
        }
    }

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
                Theme.background.ignoresSafeArea()

                VStack(spacing: 0) {
                    if !results.isEmpty {
                        filterChipsRow
                    }

                    if isSearching && results.isEmpty {
                        searchingIndicator
                    } else if let errorMessage, results.isEmpty {
                        searchErrorView(message: errorMessage)
                    } else if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && results.isEmpty {
                        initialPromptView
                    } else if filteredResults.isEmpty && !isSearching {
                        emptyResultsView
                    } else {
                        resultsGrid
                    }
                }
            }
            .navigationTitle(L10n.tabSearch)
            .navigationBarTitleDisplayMode(.large)
            .searchable(
                text: $query,
                placement: .navigationBarDrawer(displayMode: .always),
                prompt: Text(tr("Search movies, series...", "Rechercher films, séries…"))
            )
            .autocorrectionDisabled(true)
            .textInputAutocapitalization(.never)
            .environment(\.locale, lang.locale)
            .onChange(of: query) { newValue in
                scheduleSearch(for: newValue)
            }
            .onSubmit(of: .search) {
                scheduleSearch(for: query, immediate: true)
            }
            .onReceive(NotificationCenter.default.publisher(for: .vaultStreamingLanguageChanged)) { _ in
                if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    scheduleSearch(for: query, immediate: true)
                }
            }
        }
    }

    // MARK: - Subviews

    private var filterChipsRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                filterChip(id: "all", label: L10n.all)
                filterChip(id: "movie", label: L10n.movies)
                filterChip(id: "tv", label: L10n.series)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
        }
    }

    private func filterChip(id: String, label: String) -> some View {
        let isSelected = selectedFilter == id
        return Button {
            withAnimation(.easeInOut(duration: 0.2)) {
                selectedFilter = id
            }
        } label: {
            Text(label)
                .font(.caption.bold())
                .foregroundColor(isSelected ? .white : Theme.textSecondary)
                .padding(.horizontal, 16)
                .padding(.vertical, 7)
                .background(isSelected ? Theme.accent : Theme.cardBackground)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.radiusPill)
                        .stroke(isSelected ? Theme.accent : Theme.cardBorder, lineWidth: 1)
                )
                .cornerRadius(Theme.radiusPill)
        }
    }

    private var resultsGrid: some View {
        GeometryReader { geo in
            let columns = AdaptiveGrid.posterColumns(for: max(geo.size.width - 32, 300), spacing: 14)
            ScrollView {
                LazyVGrid(columns: columns, spacing: 18) {
                    ForEach(filteredResults) { item in
                        MediaCardView(
                            item: item,
                            isWatchlisted: watchlistIds.contains(item.id),
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

    private var searchingIndicator: some View {
        VStack(spacing: 16) {
            Spacer()
            ProgressView()
                .tint(Theme.accent)
                .scaleEffect(1.3)
            Text(tr("Searching catalog...", "Recherche dans le catalogue…"))
                .font(.subheadline)
                .foregroundColor(Theme.textSecondary)
            Spacer()
        }
    }

    private var initialPromptView: some View {
        VStack(spacing: 14) {
            Spacer()
            Image(systemName: "magnifyingglass.circle.fill")
                .font(.system(size: 56))
                .foregroundColor(Theme.accent.opacity(0.6))
            Text(tr("Find Anything", "Trouvez n'importe quoi"))
                .font(.headline)
                .foregroundColor(Theme.textPrimary)
            Text(tr("Search across TMDB, Comet streams, and indexers.", "Recherchez sur TMDB, Comet et les indexeurs."))
                .font(.subheadline)
                .foregroundColor(Theme.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
            Spacer()
        }
    }

    private var emptyResultsView: some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "film.stack")
                .font(.system(size: 44))
                .foregroundColor(Theme.textTertiary)
            Text(tr("No Results Found", "Aucun résultat trouvé"))
                .font(.headline)
                .foregroundColor(Theme.textPrimary)
            Text(tr("Try another keyword or adjust the category filter.", "Essayez un autre mot-clé ou changez le filtre."))
                .font(.caption)
                .foregroundColor(Theme.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
            Spacer()
        }
    }

    private func searchErrorView(message: String) -> some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 40))
                .foregroundColor(.orange)
            Text(message)
                .font(.caption)
                .foregroundColor(Theme.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            Spacer()
        }
    }

    // MARK: - Search Debounce

    private func scheduleSearch(for text: String, immediate: Bool = false) {
        searchTask?.cancel()
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !trimmed.isEmpty else {
            results = []
            isSearching = false
            errorMessage = nil
            return
        }

        searchTask = Task {
            if !immediate {
                try? await Task.sleep(nanoseconds: 300_000_000)
            }
            if Task.isCancelled { return }

            await MainActor.run {
                isSearching = true
                errorMessage = nil
            }

            do {
                let fetched = try await Api.shared.searchMedia(query: trimmed, page: 1)
                if Task.isCancelled { return }
                await MainActor.run {
                    results = fetched
                    isSearching = false
                }
            } catch {
                if Task.isCancelled { return }
                await MainActor.run {
                    errorMessage = error.localizedDescription
                    isSearching = false
                }
            }
        }
    }
}
