import SwiftUI

/// Native iOS Search View featuring full-width searchable input,
/// live debounced query execution, category filters, and a responsive 2-column grid.
public struct SearchView: View {
    let onSelectMedia: (MediaItem) -> Void
    let onPlayMedia: (MediaItem) -> Void
    let watchlistIds: Set<Int>
    let onToggleWatchlist: (MediaItem) -> Void
    
    @State private var query: String = ""
    @State private var searchFilter: String = "all"
    @State private var results: [MediaItem] = []
    @State private var isSearching: Bool = false
    @State private var errorMessage: String? = nil
    @State private var searchTask: Task<Void, Never>? = nil
    
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
                
                VStack(spacing: 0) {
                    // Custom Search Bar with Clear Button
                    searchBarHeader
                    
                    // Filter Chips
                    filterChipsRow
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
                    
                    // Results Container
                    ScrollView(.vertical, showsIndicators: false) {
                        if isSearching {
                            searchingIndicator
                        } else if let error = errorMessage {
                            searchErrorView(error)
                        } else if results.isEmpty && !query.isEmpty {
                            emptyResultsView
                        } else if results.isEmpty {
                            initialPromptView
                        } else {
                            resultsGrid
                                .padding(.horizontal, 16)
                                .padding(.top, 10)
                                .padding(.bottom, 24)
                        }
                    }
                }
            }
            .navigationTitle("Search")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
    
    // MARK: - Subviews
    
    private var searchBarHeader: some View {
        HStack(spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .foregroundColor(Theme.accent)
                    .font(.system(size: 16))
                
                TextField("Search movies, TV shows...", text: $query)
                    .foregroundColor(.white)
                    .autocapitalization(.none)
                    .disableAutocorrection(true)
                    .onChange(of: query) { newQuery in
                        scheduleSearch(newQuery)
                    }
                
                if !query.isEmpty {
                    Button(action: {
                        query = ""
                        results = []
                    }) {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundColor(Theme.textTertiary)
                            .font(.system(size: 16))
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(Theme.cardBackground)
            .cornerRadius(Theme.radiusMedium)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.radiusMedium)
                    .stroke(Theme.cardBorder, lineWidth: 0.8)
            )
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
    }
    
    private var filterChipsRow: some View {
        HStack(spacing: 10) {
            chipButton(title: "All", id: "all")
            chipButton(title: "Movies", id: "movie")
            chipButton(title: "Series", id: "tv")
            Spacer()
        }
    }
    
    private func chipButton(title: String, id: String) -> some View {
        let isSelected = (searchFilter == id)
        return Button(action: {
            searchFilter = id
            scheduleSearch(query)
        }) {
            Text(title)
                .font(.system(size: 12, weight: .semibold))
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(isSelected ? Theme.accent : Theme.cardBackground)
                .foregroundColor(isSelected ? .black : .white)
                .cornerRadius(Theme.radiusPill)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.radiusPill)
                        .stroke(isSelected ? Theme.accent : Theme.cardBorder, lineWidth: 0.8)
                )
        }
        .buttonStyle(PlainButtonStyle())
    }
    
    private var resultsGrid: some View {
        LazyVGrid(columns: columns, spacing: 18) {
            ForEach(filteredResults) { item in
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
    
    private var filteredResults: [MediaItem] {
        if searchFilter == "all" { return results }
        return results.filter { $0.effectiveMediaType == searchFilter }
    }
    
    private var searchingIndicator: some View {
        VStack(spacing: 12) {
            ProgressView()
                .progressViewStyle(CircularProgressViewStyle(tint: Theme.accent))
                .scaleEffect(1.2)
            Text("Searching catalog...")
                .font(.subheadline)
                .foregroundColor(Theme.textTertiary)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 60)
    }
    
    private var initialPromptView: some View {
        VStack(spacing: 12) {
            Image(systemName: "sparkle.magnifyingglass")
                .font(.system(size: 40))
                .foregroundColor(Theme.accent.opacity(0.6))
            Text("Find Anything")
                .font(.headline)
                .foregroundColor(.white)
            Text("Search across TMDB, Comet streams, and indexers.")
                .font(.caption)
                .foregroundColor(Theme.textTertiary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 80)
    }
    
    private var emptyResultsView: some View {
        VStack(spacing: 12) {
            Image(systemName: "film.stack")
                .font(.system(size: 40))
                .foregroundColor(Theme.textTertiary)
            Text("No results found for \"\(query)\"")
                .font(.headline)
                .foregroundColor(.white)
            Text("Try searching with different keywords or title spelling.")
                .font(.caption)
                .foregroundColor(Theme.textTertiary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 60)
        .padding(.horizontal, 24)
    }
    
    private func searchErrorView(_ error: String) -> some View {
        VStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 32))
                .foregroundColor(.orange)
            Text("Search Error")
                .font(.headline)
                .foregroundColor(.white)
            Text(error)
                .font(.caption)
                .foregroundColor(Theme.textTertiary)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 60)
    }
    
    // MARK: - Search Scheduling & Debounce
    
    private func scheduleSearch(_ text: String) {
        searchTask?.cancel()
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            results = []
            isSearching = false
            return
        }
        
        searchTask = Task {
            // Debounce 300ms
            try? await Task.sleep(nanoseconds: 300_000_000)
            if Task.isCancelled { return }
            
            await MainActor.run { isSearching = true }
            do {
                let fetched = try await StreamingBackend.shared.searchMedia(query: trimmed)
                if !Task.isCancelled {
                    await MainActor.run {
                        results = fetched
                        isSearching = false
                        errorMessage = nil
                    }
                }
            } catch {
                if !Task.isCancelled {
                    await MainActor.run {
                        errorMessage = error.localizedDescription
                        isSearching = false
                    }
                }
            }
        }
    }
}
