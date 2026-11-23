import SwiftUI

/// Native catalog discovery view showing Continue Watching, Featured hero banner,
/// provider/sort filters, adaptive iPhone/iPad grid, and paginated TMDB + RAGGAE results.
public struct DiscoverView: View {
    public let onSelectMedia: (MediaItem) -> Void
    public let onPlayMedia: (MediaItem) -> Void
    public let onResumeProgress: ((WatchProgressRecord) -> Void)?
    public let watchlistIds: Set<Int>
    public let onToggleWatchlist: (MediaItem) -> Void

    @ObservedObject private var lang = LanguageManager.shared

    @State private var feedGeneration: Int = 0   // bumped by every reset: an older load's page is dropped
    @State private var selectedCategory: String = "movie"
    @State private var selectedProvider: String = "all"
    @State private var selectedSort: String = "popularity.desc"
    @State private var items: [MediaItem] = []
    @State private var continueWatching: [WatchProgressRecord] = []
    @State private var currentPage: Int = 1
    @State private var hasMorePages: Bool = true
    @State private var isLoading: Bool = false
    @State private var isLoadingMore: Bool = false
    @State private var errorMessage: String? = nil

    private struct ProviderFilter: Identifiable {
        let id: String
        let labelEn: String
        let labelFr: String
    }

    private struct SortOption: Identifiable {
        let id: String
        let labelEn: String
        let labelFr: String
    }

    private var providers: [ProviderFilter] {
        [
            ProviderFilter(id: "all", labelEn: "All", labelFr: "Tous"),
            ProviderFilter(id: "8", labelEn: "Netflix", labelFr: "Netflix"),
            ProviderFilter(id: "337", labelEn: "Disney+", labelFr: "Disney+"),
            ProviderFilter(id: "350", labelEn: "Apple TV+", labelFr: "Apple TV+"),
            ProviderFilter(id: "119", labelEn: "Prime Video", labelFr: "Prime Video")
        ]
    }

    private var sortOptions: [SortOption] {
        [
            SortOption(id: "popularity.desc", labelEn: "Popular", labelFr: "Populaire"),
            SortOption(id: "vote_average.desc", labelEn: "Top Rated", labelFr: "Mieux notés"),
            SortOption(id: "primary_release_date.desc", labelEn: "Newest", labelFr: "Plus récents")
        ]
    }

    public init(
        onSelectMedia: @escaping (MediaItem) -> Void,
        onPlayMedia: @escaping (MediaItem) -> Void,
        onResumeProgress: ((WatchProgressRecord) -> Void)? = nil,
        watchlistIds: Set<Int>,
        onToggleWatchlist: @escaping (MediaItem) -> Void
    ) {
        self.onSelectMedia = onSelectMedia
        self.onPlayMedia = onPlayMedia
        self.onResumeProgress = onResumeProgress
        self.watchlistIds = watchlistIds
        self.onToggleWatchlist = onToggleWatchlist
    }

    public var body: some View {
        NavigationStack {
            ZStack {
                Theme.background.ignoresSafeArea()

                GeometryReader { geo in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 20) {
                            categoryAndSortRow
                            providerFilterRow

                            if AppConfig.showContinueWatchingOnDiscover && !continueWatching.isEmpty {
                                continueWatchingSection
                            }

                            if isLoading && items.isEmpty {
                                feedLoadingView
                            } else if let errorMessage, items.isEmpty {
                                feedErrorView(message: errorMessage)
                            } else {
                                if let hero = items.first {
                                    featuredHeroBanner(hero)
                                }
                                mediaGrid(width: geo.size.width - 32)
                                loadMoreFooter
                            }
                        }
                        .padding(.bottom, 32)
                    }
                    .refreshable {
                        await loadFeed(reset: true)
                    }
                }
            }
            .navigationTitle(L10n.tabDiscover)
            .navigationBarTitleDisplayMode(.large)
            .environment(\.locale, lang.locale)
            .task {
                if items.isEmpty {
                    await loadFeed(reset: true)
                } else {
                    await loadContinueWatching()
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: .vaultStreamingCredentialsChanged)) { _ in
                Task { await loadFeed(reset: true) }
            }
            .onReceive(NotificationCenter.default.publisher(for: .vaultStreamingLanguageChanged)) { _ in
                Task { await loadFeed(reset: true) }
            }
            .onChange(of: selectedCategory) { _ in
                Task { await loadFeed(reset: true) }
            }
            .onChange(of: selectedProvider) { _ in
                Task { await loadFeed(reset: true) }
            }
            .onChange(of: selectedSort) { _ in
                Task { await loadFeed(reset: true) }
            }
        }
    }

    // MARK: - Controls

    private var categoryAndSortRow: some View {
        HStack(spacing: 12) {
            Picker(tr("Category", "Catégorie"), selection: $selectedCategory) {
                Text(L10n.movies).tag("movie")
                Text(L10n.series).tag("tv")
            }
            .pickerStyle(.segmented)

            Menu {
                ForEach(sortOptions) { opt in
                    Button {
                        selectedSort = opt.id
                    } label: {
                        HStack {
                            Text(tr(opt.labelEn, opt.labelFr))
                            if selectedSort == opt.id {
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                }
            } label: {
                let current = sortOptions.first(where: { $0.id == selectedSort })
                HStack(spacing: 5) {
                    Image(systemName: "arrow.up.arrow.down")
                        .font(.caption.weight(.semibold))
                    Text(tr(current?.labelEn ?? "Popular", current?.labelFr ?? "Populaire"))
                        .font(.caption.weight(.semibold))
                        .lineLimit(1)
                }
                .foregroundColor(Theme.textPrimary)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Theme.cardBackground)
                .overlay(RoundedRectangle(cornerRadius: Theme.radiusSmall).stroke(Theme.cardBorder, lineWidth: 1))
                .cornerRadius(Theme.radiusSmall)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
    }

    private var providerFilterRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(providers) { provider in
                    let isSelected = selectedProvider == provider.id
                    Button {
                        selectedProvider = provider.id
                    } label: {
                        Text(tr(provider.labelEn, provider.labelFr))
                            .font(.caption.weight(.semibold))
                            .foregroundColor(isSelected ? .white : Theme.textSecondary)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 7)
                            .background(isSelected ? Theme.accent : Theme.cardBackground)
                            .overlay(
                                RoundedRectangle(cornerRadius: Theme.radiusPill)
                                    .stroke(isSelected ? Theme.accent : Theme.cardBorder, lineWidth: 1)
                            )
                            .cornerRadius(Theme.radiusPill)
                    }
                }
            }
            .padding(.horizontal, 16)
        }
    }

    // MARK: - Continue Watching Strip

    private var continueWatchingSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(tr("Continue Watching", "Continuer à regarder"))
                .font(.headline.bold())
                .foregroundColor(Theme.textPrimary)
                .padding(.horizontal, 16)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 12) {
                    ForEach(continueWatching) { rec in
                        continueWatchingCard(rec)
                    }
                }
                .padding(.horizontal, 16)
            }
        }
    }

    private func continueWatchingCard(_ rec: WatchProgressRecord) -> some View {
        Button {
            if let onResumeProgress {
                onResumeProgress(rec)
            } else {
                let item = MediaItem(
                    id: rec.tmdbId ?? abs(rec.title.hashValue),
                    rawId: rec.rawTmdbId.isEmpty ? rec.title : rec.rawTmdbId,
                    tmdbId: rec.tmdbId,
                    title: rec.mediaType == "movie" ? rec.title : nil,
                    name: rec.mediaType == "tv" ? rec.title : nil,
                    poster: rec.posterUrl,
                    year: rec.year,
                    media_type: rec.mediaType
                )
                onSelectMedia(item)
            }
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                ZStack(alignment: .bottomLeading) {
                    VaultImage(url: rec.posterUrl.flatMap(URL.init(string:))) { phase in
                        switch phase {
                        case .success(let img):
                            img.resizable().aspectRatio(contentMode: .fill)
                        default:
                            Theme.cardBackground
                                .overlay(Image(systemName: "play.tv").foregroundColor(Theme.textTertiary))
                        }
                    }
                    .frame(width: 146, height: 96)
                    .clipped()
                    .overlay(
                        LinearGradient(
                            colors: [.clear, Color.black.opacity(0.65)],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )

                    HStack {
                        if let s = rec.season, let e = rec.episode {
                            Text(L10n.shortSeasonEpisode(s, e))
                                .font(.caption2.bold())
                                .foregroundColor(.white)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Theme.accent.opacity(0.9))
                                .cornerRadius(4)
                        }
                        Spacer()
                        Image(systemName: "play.circle.fill")
                            .font(.title3)
                            .foregroundColor(.white)
                    }
                    .padding(8)

                    VStack {
                        Spacer()
                        GeometryReader { g in
                            ZStack(alignment: .leading) {
                                Rectangle().fill(Color.white.opacity(0.25))
                                Rectangle().fill(Theme.accent).frame(width: g.size.width * rec.progressFraction)
                            }
                        }
                        .frame(height: 3)
                    }
                }
                .frame(width: 146, height: 96)
                .cornerRadius(Theme.radiusMedium)
                .overlay(RoundedRectangle(cornerRadius: Theme.radiusMedium).stroke(Theme.cardBorder, lineWidth: 1))

                Text(rec.title)
                    .font(.caption.weight(.semibold))
                    .foregroundColor(Theme.textPrimary)
                    .lineLimit(1)
                    .frame(width: 146, alignment: .leading)
            }
        }
        .buttonStyle(.plain)
    }

    // MARK: - Featured Hero Banner

    private func featuredHeroBanner(_ item: MediaItem) -> some View {
        ZStack(alignment: .bottomLeading) {
            VaultImage(url: item.backdropURL ?? item.posterURL) { phase in
                switch phase {
                case .success(let image):
                    image
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                default:
                    Theme.secondaryBackground
                }
            }
            .frame(height: AdaptiveGrid.isPad ? 280 : 210)
            .clipped()
            .overlay(
                LinearGradient(
                    colors: [.clear, Theme.background.opacity(0.65), Theme.background],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )

            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text(L10n.featured)
                        .font(.caption2.bold())
                        .tracking(1.1)
                        .foregroundColor(Theme.accentSecondary)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Theme.accent.opacity(0.25))
                        .cornerRadius(4)

                    if item.formattedRating != "—" {
                        HStack(spacing: 3) {
                            Image(systemName: "star.fill")
                                .font(.caption2)
                                .foregroundColor(Theme.ratingGold)
                            Text(item.formattedRating)
                                .font(.caption.bold())
                                .foregroundColor(.white)
                        }
                    }
                }

                Text(item.displayTitle)
                    .font(.title3.bold())
                    .foregroundColor(.white)
                    .lineLimit(1)

                if let overview = item.overview, !overview.isEmpty {
                    Text(overview)
                        .font(.caption)
                        .foregroundColor(Theme.textSecondary)
                        .lineLimit(2)
                }

                HStack(spacing: 10) {
                    Button {
                        onPlayMedia(item)
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "play.fill")
                            Text(L10n.playNow)
                        }
                        .font(.caption.bold())
                        .foregroundColor(.white)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
                        .background(Theme.accentGradient)
                        .cornerRadius(Theme.radiusSmall)
                    }

                    Button {
                        onSelectMedia(item)
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "info.circle")
                            Text(L10n.moreDetails)
                        }
                        .font(.caption.bold())
                        .foregroundColor(Theme.textPrimary)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background(Theme.cardBackground.opacity(0.9))
                        .overlay(RoundedRectangle(cornerRadius: Theme.radiusSmall).stroke(Theme.cardBorder, lineWidth: 1))
                        .cornerRadius(Theme.radiusSmall)
                    }
                }
                .padding(.top, 4)
            }
            .padding(16)
        }
        .cornerRadius(Theme.radiusLarge)
        .padding(.horizontal, 16)
        .onTapGesture {
            onSelectMedia(item)
        }
    }

    // MARK: - Responsive Grid & Pagination

    private func mediaGrid(width: CGFloat) -> some View {
        let gridItems = items.count > 1 ? Array(items.dropFirst()) : items
        let columns = AdaptiveGrid.posterColumns(for: max(width, 300), spacing: 14)

        return LazyVGrid(columns: columns, spacing: 18) {
            ForEach(gridItems) { item in
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
    }

    @ViewBuilder
    private var loadMoreFooter: some View {
        if hasMorePages && !items.isEmpty {
            Button {
                Task { await loadFeed(reset: false) }
            } label: {
                HStack(spacing: 8) {
                    if isLoadingMore {
                        ProgressView().tint(.white).scaleEffect(0.85)
                    }
                    Text(isLoadingMore ? L10n.loading : L10n.loadMore)
                        .font(.subheadline.bold())
                        .foregroundColor(.white)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .background(Theme.cardBackground)
                .overlay(RoundedRectangle(cornerRadius: Theme.radiusMedium).stroke(Theme.cardBorder, lineWidth: 1))
                .cornerRadius(Theme.radiusMedium)
            }
            .disabled(isLoadingMore)
            .padding(.horizontal, 16)
        }
    }

    // MARK: - States

    private var feedLoadingView: some View {
        VStack(spacing: 16) {
            ProgressView()
                .tint(Theme.accent)
                .scaleEffect(1.3)
            Text(tr("Fetching latest releases...", "Chargement des dernières sorties…"))
                .font(.subheadline)
                .foregroundColor(Theme.textSecondary)
        }
        .frame(maxWidth: .infinity, minHeight: 320)
    }

    private func feedErrorView(message: String) -> some View {
        VStack(spacing: 14) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 40))
                .foregroundColor(.orange)

            Text(tr("Could Not Load Feed", "Impossible de charger le catalogue"))
                .font(.headline)
                .foregroundColor(Theme.textPrimary)

            Text(message)
                .font(.caption)
                .foregroundColor(Theme.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)

            Button {
                Task { await loadFeed(reset: true) }
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
        .frame(maxWidth: .infinity, minHeight: 320)
    }

    // MARK: - Data Fetch

    private func reloadContinueWatchingIfNeeded(_ reset: Bool) async {
        guard reset else { return }
        await loadContinueWatching()
    }

    private func loadContinueWatching() async {
        guard AppConfig.showContinueWatchingOnDiscover else {
            continueWatching = []
            return
        }
        // as js/continue-watching.js: each series' most recent episode, finished or not (the unfinished-only list
        // dropped a just-finished episode and offered an older one), grouped before anything is left out; a
        // finished series card opens on its next episode (ContentView.resumeHistoryPlayback)
        if let raw = try? await Api.shared.fetchWatchHistory(limit: 500) {
            let latest = SeriesResumeHelper.latestPerTitle(raw).filter { $0.mediaType == "tv" || !$0.completed }
            continueWatching = Array(latest.prefix(4))
        }
    }

    private func loadFeed(reset: Bool) async {
        if reset {
            feedGeneration += 1
            isLoading = true
            isLoadingMore = false
            errorMessage = nil
            currentPage = 1
            hasMorePages = true
        } else {
            guard !isLoadingMore, hasMorePages else { return }
            isLoadingMore = true
            currentPage += 1
        }
        // a category / provider / sort change while this page loads makes it another list's page
        let generation = feedGeneration
        let requestedPage = currentPage

        async let cwTask: Void = reloadContinueWatchingIfNeeded(reset)

        do {
            let fetched = try await Api.shared.fetchDiscover(
                mediaType: selectedCategory,
                page: requestedPage,
                providerId: selectedProvider,
                sort: selectedSort
            )
            guard generation == feedGeneration else { return }

            if reset {
                items = fetched
                hasMorePages = !fetched.isEmpty
            } else {
                let existingIds = Set(items.map(\.id))
                let fresh = fetched.filter { !existingIds.contains($0.id) }
                items.append(contentsOf: fresh)
                hasMorePages = !fetched.isEmpty
            }
        } catch {
            guard generation == feedGeneration else { return }
            if reset {
                errorMessage = error.localizedDescription
            } else {
                currentPage = max(1, currentPage - 1)
            }
        }

        _ = await cwTask
        if reset {
            isLoading = false
        } else {
            isLoadingMore = false
        }
    }
}
