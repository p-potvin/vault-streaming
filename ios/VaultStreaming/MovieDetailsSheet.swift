import SwiftUI

/// Native iOS sheet displaying rich metadata, inline H.264 trailer, external links,
/// cast carousel, series resume & episodes, skip intro/outro timers, Comet stream
/// candidates, and OpenSubtitles / AI subtitle tracks.
public struct MovieDetailsSheet: View {
    public let item: MediaItem
    public let isWatchlisted: Bool
    public let onPlayStream: (TorrentStream) -> Void
    public let onPlayAuto: ((MediaItem, Int?, Int?, Double?) -> Void)?
    public let onPlayEpisodeStream: ((TorrentStream, Int?, Int?) -> Void)?
    public let onToggleWatchlist: () -> Void
    public let onDismiss: () -> Void

    @ObservedObject private var lang = LanguageManager.shared
    @Environment(\.openURL) private var openURL

    @State private var details: MediaDetails? = nil
    @State private var streams: [TorrentStream] = []
    @State private var subtitles: [SubtitleTrack] = []
    @State private var showProgress: [WatchProgressRecord] = []
    @State private var movieProgress: WatchProgressRecord? = nil

    @State private var selectedSeason: Int = 1
    @State private var activeEpisodeNumber: Int = 1
    @State private var episodes: [EpisodeItem] = []
    @State private var isLoadingEpisodes: Bool = false

    @State private var isLoadingDetails: Bool = true
    @State private var isLoadingStreams: Bool = true
    @State private var isLoadingSubtitles: Bool = false
    @State private var streamError: String? = nil
    @State private var filterFrenchOnly: Bool = false
    @State private var resolvedTrailerKey: String? = nil

    @State private var skipIntroSec: Int = 0
    @State private var skipOutroSec: Int = 0
    @State private var showSkipConfig: Bool = false

    public init(
        item: MediaItem,
        isWatchlisted: Bool,
        onPlayStream: @escaping (TorrentStream) -> Void,
        onPlayAuto: ((MediaItem, Int?, Int?, Double?) -> Void)? = nil,
        onPlayEpisodeStream: ((TorrentStream, Int?, Int?) -> Void)? = nil,
        onToggleWatchlist: @escaping () -> Void,
        onDismiss: @escaping () -> Void
    ) {
        self.item = item
        self.isWatchlisted = isWatchlisted
        self.onPlayStream = onPlayStream
        self.onPlayAuto = onPlayAuto
        self.onPlayEpisodeStream = onPlayEpisodeStream
        self.onToggleWatchlist = onToggleWatchlist
        self.onDismiss = onDismiss
    }

    private var isTV: Bool {
        item.effectiveMediaType == "tv"
    }

    private var availableSeasons: [SeasonSummary] {
        let fromDetails = (details?.seasons ?? [])
            .filter { $0.season_number > 0 && ($0.episode_count ?? 0) > 0 }
            .sorted { $0.season_number < $1.season_number }
        if !fromDetails.isEmpty { return fromDetails }
        let count = max(1, details?.number_of_seasons ?? 1)
        return (1...count).map { SeasonSummary(season_number: $0, name: nil, episode_count: nil, air_date: nil, poster_path: nil) }
    }

    private var resumeTarget: SeriesResumeTarget? {
        guard isTV else { return nil }
        return SeriesResumeHelper.pickResumeTarget(items: showProgress, seasons: availableSeasons)
    }

    private var filteredStreams: [TorrentStream] {
        if filterFrenchOnly {
            return streams.filter { $0.isFrench }
        }
        return streams
    }

    private var displayTitle: String {
        details?.displayTitle ?? item.displayTitle
    }

    public var body: some View {
        ZStack(alignment: .top) {
            Theme.background.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    trailerHeader

                    VStack(alignment: .leading, spacing: 20) {
                        metadataHeader
                        externalBadgesRow
                        actionButtonsRow
                        synopsisSection

                        if let cast = details?.displayCast, !cast.isEmpty {
                            castSection(cast)
                        }

                        if isTV {
                            seriesSection
                        }

                        streamsSection
                        subtitlesSection
                    }
                    .padding(.horizontal, 20)
                    .padding(.bottom, 40)
                }
            }
            .ignoresSafeArea(edges: .top)
        }
        .preferredColorScheme(.dark)
        .environment(\.locale, lang.locale)
        .task(id: item.rawId) {
            let skip = AppConfig.seriesSkip(for: item.rawId)
            skipIntroSec = skip.intro
            skipOutroSec = skip.outro
            await loadData()
        }
    }

    // MARK: - Inline Trailer / Backdrop Header

    private var trailerHeader: some View {
        ZStack(alignment: .topTrailing) {
            TrailerPlayerView(
                rawId: item.rawId,
                mediaType: item.effectiveMediaType,
                title: displayTitle,
                fallbackImageURL: details?.backdropURL ?? item.backdropURL,
                onTrailerResolved: { key in
                    resolvedTrailerKey = key
                }
            )
            .frame(maxWidth: .infinity)
            .frame(height: 240)
            .clipped()

            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundColor(.white)
                    .frame(width: 34, height: 34)
                    .background(Color.black.opacity(0.65))
                    .clipShape(Circle())
                    .overlay(Circle().stroke(Color.white.opacity(0.25), lineWidth: 1))
            }
            .accessibilityLabel(L10n.close)
            .padding(.top, 16)
            .padding(.trailing, 16)
        }
    }

    // MARK: - Metadata Header

    private var metadataHeader: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(displayTitle)
                .font(.title2.bold())
                .foregroundColor(Theme.textPrimary)

            HStack(spacing: 10) {
                if !item.releaseYear.isEmpty {
                    Text(item.releaseYear)
                        .font(.subheadline.weight(.semibold))
                        .foregroundColor(Theme.textSecondary)
                }

                if item.formattedRating != "—" {
                    HStack(spacing: 4) {
                        Image(systemName: "star.fill")
                            .font(.caption2)
                            .foregroundColor(Theme.ratingGold)
                        Text(item.formattedRating)
                            .font(.subheadline.bold())
                            .foregroundColor(Theme.textPrimary)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Theme.cardBackground)
                    .cornerRadius(Theme.radiusSmall)
                }

                if let runtime = details?.formattedRuntime {
                    Text(runtime)
                        .font(.caption.weight(.medium))
                        .foregroundColor(Theme.textSecondary)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Theme.cardBackground)
                        .cornerRadius(Theme.radiusSmall)
                }

                if isTV, let seasons = details?.number_of_seasons, seasons > 0 {
                    Text(tr("\(seasons) \(seasons == 1 ? "Season" : "Seasons")", "\(seasons) \(seasons == 1 ? "Saison" : "Saisons")"))
                        .font(.caption.weight(.medium))
                        .foregroundColor(Theme.accentSecondary)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Theme.cardBackground)
                        .cornerRadius(Theme.radiusSmall)
                }
            }

            if let genres = details?.genres, !genres.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(genres) { g in
                            Text(g.name)
                                .font(.caption2.weight(.semibold))
                                .foregroundColor(Theme.textSecondary)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 4)
                                .background(Theme.secondaryBackground)
                                .overlay(
                                    RoundedRectangle(cornerRadius: Theme.radiusPill)
                                        .stroke(Theme.cardBorder, lineWidth: 1)
                                )
                                .cornerRadius(Theme.radiusPill)
                        }
                    }
                }
            }
        }
    }

    // MARK: - External Badges

    private var externalBadgesRow: some View {
        let encodedTitle = displayTitle.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? displayTitle
        let imdbId = details?.imdb_id ?? item.imdb_id

        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                if let key = resolvedTrailerKey, let ytURL = URL(string: "https://www.youtube.com/watch?v=\(key)") {
                    externalBadgeButton(
                        title: "YouTube",
                        icon: "play.rectangle.fill",
                        tint: Color(hex: 0xFF3B30),
                        url: ytURL
                    )
                }

                if let imdbId, !imdbId.isEmpty,
                   let imdbURL = URL(string: "https://www.imdb.com/title/\(imdbId)/") {
                    let ratingText = item.formattedRating != "—" ? "IMDb \(item.formattedRating)" : "IMDb"
                    externalBadgeButton(
                        title: ratingText,
                        icon: "star.circle.fill",
                        tint: Theme.ratingGold,
                        url: imdbURL
                    )
                }

                if Int(item.rawId) != nil,
                   let tmdbURL = URL(string: "https://www.themoviedb.org/\(isTV ? "tv" : "movie")/\(item.rawId)") {
                    externalBadgeButton(
                        title: "TMDB",
                        icon: "film.stack",
                        tint: Theme.accentSecondary,
                        url: tmdbURL
                    )
                }

                if let jwURL = URL(string: "https://www.justwatch.com/ca/search?q=\(encodedTitle)") {
                    externalBadgeButton(
                        title: "JustWatch",
                        icon: "tv.and.mediabox",
                        tint: Theme.ratingGold,
                        url: jwURL
                    )
                }

                if let appleURL = URL(string: "https://tv.apple.com/ca/search?term=\(encodedTitle)") {
                    externalBadgeButton(
                        title: "Apple TV",
                        icon: "appletv.fill",
                        tint: Theme.textPrimary,
                        url: appleURL
                    )
                }
            }
        }
    }

    private func externalBadgeButton(title: String, icon: String, tint: Color, url: URL) -> some View {
        Button {
            openURL(url)
        } label: {
            HStack(spacing: 5) {
                Image(systemName: icon)
                    .font(.caption.weight(.semibold))
                    .foregroundColor(tint)
                Text(title)
                    .font(.caption.weight(.semibold))
                    .foregroundColor(Theme.textPrimary)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Theme.cardBackground)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.radiusSmall)
                    .stroke(Theme.cardBorder, lineWidth: 1)
            )
            .cornerRadius(Theme.radiusSmall)
        }
    }

    // MARK: - Action Buttons Row

    private var actionButtonsRow: some View {
        HStack(spacing: 12) {
            Button {
                triggerPrimaryPlay()
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "play.fill")
                    Text(primaryPlayButtonTitle)
                        .font(.subheadline.bold())
                        .lineLimit(1)
                }
                .foregroundColor(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(Theme.accentGradient)
                .cornerRadius(Theme.radiusMedium)
            }
            .disabled(onPlayAuto == nil && streams.isEmpty)
            .opacity((onPlayAuto == nil && streams.isEmpty) ? 0.55 : 1.0)

            Button(action: onToggleWatchlist) {
                VStack(spacing: 4) {
                    Image(systemName: isWatchlisted ? "bookmark.fill" : "bookmark")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundColor(isWatchlisted ? Theme.accentSecondary : Theme.textPrimary)
                    Text(isWatchlisted ? L10n.saved : L10n.tabLibrary)
                        .font(.caption2.weight(.semibold))
                        .foregroundColor(isWatchlisted ? Theme.accentSecondary : Theme.textSecondary)
                }
                .frame(width: 86, height: 48)
                .background(Theme.cardBackground)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.radiusMedium)
                        .stroke(isWatchlisted ? Theme.accentSecondary : Theme.cardBorder, lineWidth: 1)
                )
                .cornerRadius(Theme.radiusMedium)
            }
        }
    }

    private var primaryPlayButtonTitle: String {
        if isTV {
            if let target = resumeTarget {
                let code = L10n.shortSeasonEpisode(target.season, target.episode)
                if target.kind == .resume {
                    return target.positionSec > 5
                        ? tr("Resume \(code) (\(L10n.clock(target.positionSec)))", "Reprendre \(code) (\(L10n.clock(target.positionSec)))")
                        : tr("Resume \(code)", "Reprendre \(code)")
                } else {
                    return tr("Next: \(code)", "Suivant : \(code)")
                }
            }
            let firstSeason = availableSeasons.first?.season_number ?? 1
            return tr("Play \(L10n.shortSeasonEpisode(firstSeason, 1))", "Lire \(L10n.shortSeasonEpisode(firstSeason, 1))")
        }

        if let prog = movieProgress, !prog.completed, prog.position > 5 {
            return tr("Resume (\(L10n.clock(prog.position)))", "Reprendre (\(L10n.clock(prog.position)))")
        }
        return L10n.playNow
    }

    private func triggerPrimaryPlay() {
        if isTV {
            let targetSeason = resumeTarget?.season ?? availableSeasons.first?.season_number ?? selectedSeason
            let targetEpisode = resumeTarget?.episode ?? activeEpisodeNumber
            let targetPos = (resumeTarget?.kind == .resume) ? resumeTarget?.positionSec : 0
            if let onPlayAuto {
                onPlayAuto(item, targetSeason, targetEpisode, targetPos)
                return
            }
        } else if let onPlayAuto {
            let pos = (movieProgress?.completed == false && (movieProgress?.position ?? 0) > 5) ? movieProgress?.position : nil
            onPlayAuto(item, nil, nil, pos)
            return
        }

        if let top = filteredStreams.first ?? streams.first {
            if isTV {
                onPlayEpisodeStream?(top, selectedSeason, activeEpisodeNumber)
            }
            if onPlayEpisodeStream == nil || !isTV {
                onPlayStream(top)
            }
        }
    }

    // MARK: - Synopsis Section

    private var synopsisSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let tagline = details?.tagline, !tagline.isEmpty {
                Text("\"\(tagline)\"")
                    .font(.subheadline.italic())
                    .foregroundColor(Theme.accentSecondary)
            }

            let overview = details?.overview ?? item.overview ?? ""
            Text(overview.isEmpty ? L10n.noDesc : overview)
                .font(.subheadline)
                .foregroundColor(Theme.textSecondary)
                .lineSpacing(4)
        }
    }

    // MARK: - Cast Carousel

    private func castSection(_ cast: [CastMember]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(tr("Cast", "Distribution"))
                .font(.headline.bold())
                .foregroundColor(Theme.textPrimary)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 12) {
                    ForEach(cast) { member in
                        VStack(spacing: 6) {
                            AsyncImage(url: member.profileURL) { phase in
                                switch phase {
                                case .success(let image):
                                    image
                                        .resizable()
                                        .aspectRatio(contentMode: .fill)
                                default:
                                    ZStack {
                                        Theme.cardBackground
                                        Image(systemName: "person.fill")
                                            .font(.title3)
                                            .foregroundColor(Theme.textTertiary)
                                    }
                                }
                            }
                            .frame(width: 72, height: 72)
                            .clipShape(Circle())
                            .overlay(Circle().stroke(Theme.cardBorder, lineWidth: 1))

                            Text(member.name)
                                .font(.caption.weight(.semibold))
                                .foregroundColor(Theme.textPrimary)
                                .lineLimit(1)

                            if let role = member.displayCharacter, !role.isEmpty {
                                Text(role)
                                    .font(.caption2)
                                    .foregroundColor(Theme.textSecondary)
                                    .lineLimit(1)
                            }
                        }
                        .frame(width: 82)
                    }
                }
            }
        }
    }

    // MARK: - Series Section (Skip Timers, Seasons & Episodes)

    private var seriesSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text(tr("Episodes", "Épisodes"))
                    .font(.headline.bold())
                    .foregroundColor(Theme.textPrimary)

                Spacer()

                Button {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        showSkipConfig.toggle()
                    }
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "forward.end.alt")
                            .font(.caption)
                        let hasSkip = skipIntroSec > 0 || skipOutroSec > 0
                        Text(hasSkip
                             ? tr("Skip +\(skipIntroSec)s / -\(skipOutroSec)s", "Saut +\(skipIntroSec) s / -\(skipOutroSec) s")
                             : tr("Skip Intro / Outro", "Passer intro / fin"))
                            .font(.caption.weight(.semibold))
                    }
                    .foregroundColor((skipIntroSec > 0 || skipOutroSec > 0) ? Theme.accentSecondary : Theme.textSecondary)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(Theme.cardBackground)
                    .overlay(RoundedRectangle(cornerRadius: Theme.radiusPill).stroke(Theme.cardBorder, lineWidth: 1))
                    .cornerRadius(Theme.radiusPill)
                }
            }

            if showSkipConfig {
                skipConfigCard
            }

            // Season pills
            if availableSeasons.count > 1 {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(availableSeasons) { season in
                            let selected = season.season_number == selectedSeason
                            Button {
                                guard selectedSeason != season.season_number else { return }
                                selectedSeason = season.season_number
                                activeEpisodeNumber = 1
                                Task { await loadSeasonAndEpisodeStreams(seasonNumber: season.season_number, episodeNumber: 1) }
                            } label: {
                                Text(L10n.seasonTitle(season.season_number))
                                    .font(.caption.weight(.bold))
                                    .foregroundColor(selected ? .white : Theme.textSecondary)
                                    .padding(.horizontal, 14)
                                    .padding(.vertical, 7)
                                    .background(selected ? Theme.accent : Theme.cardBackground)
                                    .overlay(
                                        RoundedRectangle(cornerRadius: Theme.radiusPill)
                                            .stroke(selected ? Theme.accent : Theme.cardBorder, lineWidth: 1)
                                    )
                                    .cornerRadius(Theme.radiusPill)
                            }
                        }
                    }
                }
            }

            if isLoadingEpisodes {
                HStack(spacing: 10) {
                    ProgressView().tint(Theme.accent)
                    Text(L10n.loading)
                        .font(.caption)
                        .foregroundColor(Theme.textSecondary)
                }
                .padding(.vertical, 12)
            } else if episodes.isEmpty {
                Text(tr("No episodes found for this season.", "Aucun épisode trouvé pour cette saison."))
                    .font(.caption)
                    .foregroundColor(Theme.textSecondary)
            } else {
                LazyVStack(spacing: 10) {
                    ForEach(episodes) { ep in
                        episodeRow(ep)
                    }
                }
            }
        }
    }

    private var skipConfigCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(tr("Skip intro (seconds from start)", "Passer l'intro (secondes du début)"))
                    .font(.caption.weight(.medium))
                    .foregroundColor(Theme.textSecondary)
                Spacer()
                Stepper(
                    value: Binding(
                        get: { skipIntroSec },
                        set: { newVal in
                            skipIntroSec = min(900, max(0, newVal))
                            AppConfig.setSeriesSkip(for: item.rawId, intro: skipIntroSec, outro: skipOutroSec)
                        }
                    ),
                    in: 0...900,
                    step: 5
                ) {
                    Text("\(skipIntroSec) s")
                        .font(.caption.bold().monospacedDigit())
                        .foregroundColor(Theme.textPrimary)
                }
            }

            HStack {
                Text(tr("Skip outro (seconds before end)", "Passer le générique (secondes avant la fin)"))
                    .font(.caption.weight(.medium))
                    .foregroundColor(Theme.textSecondary)
                Spacer()
                Stepper(
                    value: Binding(
                        get: { skipOutroSec },
                        set: { newVal in
                            skipOutroSec = min(900, max(0, newVal))
                            AppConfig.setSeriesSkip(for: item.rawId, intro: skipIntroSec, outro: skipOutroSec)
                        }
                    ),
                    in: 0...900,
                    step: 5
                ) {
                    Text("\(skipOutroSec) s")
                        .font(.caption.bold().monospacedDigit())
                        .foregroundColor(Theme.textPrimary)
                }
            }
        }
        .padding(12)
        .background(Theme.cardBackground)
        .overlay(RoundedRectangle(cornerRadius: Theme.radiusMedium).stroke(Theme.cardBorder, lineWidth: 1))
        .cornerRadius(Theme.radiusMedium)
    }

    private func episodeRow(_ ep: EpisodeItem) -> some View {
        let prog = showProgress.first {
            $0.season == selectedSeason && $0.episode == ep.episode_number
        }
        let resumePos = (prog != nil && prog?.completed == false && (prog?.position ?? 0) > 5) ? prog?.position : nil
        let isSelectedForStreams = activeEpisodeNumber == ep.episode_number

        return HStack(spacing: 12) {
            ZStack(alignment: .bottomLeading) {
                AsyncImage(url: ep.stillURL) { phase in
                    switch phase {
                    case .success(let img):
                        img.resizable().aspectRatio(contentMode: .fill)
                    default:
                        Theme.secondaryBackground
                            .overlay(Image(systemName: "play.tv").foregroundColor(Theme.textTertiary))
                    }
                }
                .frame(width: 112, height: 64)
                .clipped()
                .cornerRadius(Theme.radiusSmall)

                if let prog, prog.progressFraction > 0 {
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Rectangle().fill(Color.black.opacity(0.6))
                            Rectangle().fill(Theme.accent).frame(width: geo.size.width * prog.progressFraction)
                        }
                    }
                    .frame(height: 3)
                }
            }
            .frame(width: 112, height: 64)

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(L10n.shortSeasonEpisode(selectedSeason, ep.episode_number))
                        .font(.caption2.bold())
                        .foregroundColor(Theme.accentSecondary)

                    if prog?.completed == true {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.caption2)
                            .foregroundColor(Theme.successGreen)
                    }

                    if let rt = ep.runtime, rt > 0 {
                        Text("\(rt)m")
                            .font(.caption2)
                            .foregroundColor(Theme.textTertiary)
                    }
                }

                Text(ep.name ?? L10n.episodeShort(ep.episode_number))
                    .font(.subheadline.weight(.semibold))
                    .foregroundColor(Theme.textPrimary)
                    .lineLimit(1)

                if let ov = ep.overview, !ov.isEmpty {
                    Text(ov)
                        .font(.caption)
                        .foregroundColor(Theme.textSecondary)
                        .lineLimit(2)
                }
            }

            Spacer()

            VStack(spacing: 6) {
                Button {
                    activeEpisodeNumber = ep.episode_number
                    if let onPlayAuto {
                        onPlayAuto(item, selectedSeason, ep.episode_number, resumePos)
                    } else if let first = filteredStreams.first ?? streams.first {
                        onPlayEpisodeStream?(first, selectedSeason, ep.episode_number)
                        if onPlayEpisodeStream == nil {
                            onPlayStream(first)
                        }
                    }
                } label: {
                    Image(systemName: "play.circle.fill")
                        .font(.title2)
                        .foregroundColor(Theme.accent)
                }

                Button {
                    activeEpisodeNumber = ep.episode_number
                    Task { await reloadStreamsAndSubtitles(season: selectedSeason, episode: ep.episode_number) }
                } label: {
                    Text(L10n.sourcesShort)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(isSelectedForStreams ? Theme.accentSecondary : Theme.textTertiary)
                }
            }
        }
        .padding(10)
        .background(Theme.cardBackground)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.radiusMedium)
                .stroke(isSelectedForStreams ? Theme.accentSecondary.opacity(0.6) : Theme.cardBorder, lineWidth: 1)
        )
        .cornerRadius(Theme.radiusMedium)
    }

    // MARK: - Comet Streams Section

    private var streamsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(tr("Available Streams", "Sources disponibles"))
                        .font(.headline.bold())
                        .foregroundColor(Theme.textPrimary)
                    if isTV {
                        Text(L10n.shortSeasonEpisode(selectedSeason, activeEpisodeNumber))
                            .font(.caption2.weight(.semibold))
                            .foregroundColor(Theme.accentSecondary)
                    }
                }

                Spacer()

                if streams.contains(where: { $0.isFrench }) {
                    Button {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            filterFrenchOnly.toggle()
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Text("FR / VFQ / Multi")
                                .font(.caption2.bold())
                        }
                        .foregroundColor(filterFrenchOnly ? .white : Theme.frenchAccent)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(filterFrenchOnly ? Theme.frenchAccent : Theme.frenchBackground)
                        .cornerRadius(Theme.radiusPill)
                    }
                }
            }

            if isLoadingStreams {
                HStack(spacing: 12) {
                    ProgressView().tint(Theme.accent)
                    Text(tr("Searching Comet & Real-Debrid indexers...", "Recherche sur Comet et Real-Debrid…"))
                        .font(.subheadline)
                        .foregroundColor(Theme.textSecondary)
                }
                .padding(.vertical, 16)
            } else if let streamError {
                Text(streamError)
                    .font(.caption)
                    .foregroundColor(.orange)
                    .padding(.vertical, 8)
            } else if filteredStreams.isEmpty {
                Text(tr("No cached streams matched for this filter.", "Aucune source en cache pour ce filtre."))
                    .font(.subheadline)
                    .foregroundColor(Theme.textSecondary)
                    .padding(.vertical, 12)
            } else {
                LazyVStack(spacing: 10) {
                    ForEach(filteredStreams) { stream in
                        streamRow(stream)
                    }
                }
            }
        }
    }

    private func streamRow(_ stream: TorrentStream) -> some View {
        Button {
            if isTV, let onPlayEpisodeStream {
                onPlayEpisodeStream(stream, selectedSeason, activeEpisodeNumber)
            } else {
                onPlayStream(stream)
            }
        } label: {
            HStack(spacing: 12) {
                VStack(spacing: 4) {
                    Text(stream.displayQuality)
                        .font(.caption.bold())
                        .foregroundColor(.white)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(stream.displayQuality == "4K" ? Theme.accent : Theme.accentSecondary.opacity(0.8))
                        .cornerRadius(6)

                    if stream.isFrench {
                        Text("FR")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundColor(Theme.frenchAccent)
                    }
                }
                .frame(width: 58)

                VStack(alignment: .leading, spacing: 4) {
                    Text(stream.cleanReleaseTitle)
                        .font(.caption.weight(.medium))
                        .foregroundColor(Theme.textPrimary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)

                    HStack(spacing: 10) {
                        if let size = stream.size, !size.isEmpty {
                            Text(size)
                                .font(.caption2)
                                .foregroundColor(Theme.textSecondary)
                        }
                        if let seeds = stream.seeds, !seeds.isEmpty {
                            Text(tr("Seeds: \(seeds)", "Sources : \(seeds)"))
                                .font(.caption2)
                                .foregroundColor(Theme.textTertiary)
                        }
                        if stream.isCached {
                            Text(L10n.cached)
                                .font(.caption2.bold())
                                .foregroundColor(Theme.successGreen)
                        }
                    }
                }

                Spacer()

                Image(systemName: "play.circle.fill")
                    .font(.title2)
                    .foregroundColor(Theme.accent)
            }
            .padding(12)
            .background(Theme.cardBackground)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.radiusMedium)
                    .stroke(Theme.cardBorder, lineWidth: 1)
            )
            .cornerRadius(Theme.radiusMedium)
        }
    }

    // MARK: - Subtitles Section (OpenSubtitles + Local AI)

    private var subtitlesSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(tr("Subtitles", "Sous-titres"))
                    .font(.headline.bold())
                    .foregroundColor(Theme.textPrimary)
                if isLoadingSubtitles {
                    ProgressView()
                        .scaleEffect(0.75)
                        .tint(Theme.accent)
                }
            }

            if subtitles.isEmpty && !isLoadingSubtitles {
                Text(tr("No external subtitles matched yet. OpenSubtitles tracks are also loaded inside the player.", "Aucun sous-titre trouvé pour l'instant. Les pistes OpenSubtitles sont aussi disponibles dans le lecteur."))
                    .font(.caption)
                    .foregroundColor(Theme.textSecondary)
            } else {
                LazyVStack(spacing: 8) {
                    ForEach(subtitles.prefix(8)) { track in
                        HStack(spacing: 10) {
                            Text(track.language.uppercased())
                                .font(.caption2.bold())
                                .foregroundColor(.white)
                                .padding(.horizontal, 7)
                                .padding(.vertical, 3)
                                .background(track.isAi ? Theme.accentSecondary : Theme.accent)
                                .cornerRadius(5)

                            VStack(alignment: .leading, spacing: 2) {
                                Text(track.release ?? track.label)
                                    .font(.caption.weight(.semibold))
                                    .foregroundColor(Theme.textPrimary)
                                    .lineLimit(1)

                                HStack(spacing: 8) {
                                    Text(track.isAi ? "Whisper AI" : (track.isOpenSubtitles ? "OpenSubtitles" : tr("Local", "Local")))
                                        .font(.caption2)
                                        .foregroundColor(Theme.textSecondary)
                                    if track.hearingImpaired {
                                        Text("HI")
                                            .font(.caption2.bold())
                                            .foregroundColor(Theme.accentSecondary)
                                    }
                                    if let dl = track.downloads, dl > 0 {
                                        Text("↓ \(dl)")
                                            .font(.caption2)
                                            .foregroundColor(Theme.textTertiary)
                                    }
                                }
                            }

                            Spacer()
                        }
                        .padding(10)
                        .background(Theme.cardBackground)
                        .cornerRadius(Theme.radiusSmall)
                    }
                }
            }
        }
    }

    // MARK: - Data Loading

    private func loadData() async {
        isLoadingDetails = true
        isLoadingStreams = true
        isLoadingSubtitles = true

        async let fetchedDetails = Api.shared.fetchDetails(mediaType: item.effectiveMediaType, id: item.rawId)
        async let fetchedShowProg = loadShowProgressIfNeeded()
        async let fetchedMovieProg = loadMovieProgressIfNeeded()

        if let d = try? await fetchedDetails {
            details = d
        }
        showProgress = await fetchedShowProg
        movieProgress = await fetchedMovieProg
        isLoadingDetails = false

        if isTV {
            let seasonsList = availableSeasons
            let target = SeriesResumeHelper.pickResumeTarget(items: showProgress, seasons: seasonsList)
            let initialSeason = target?.season ?? seasonsList.first?.season_number ?? 1
            let initialEpisode = target?.episode ?? 1
            selectedSeason = initialSeason
            activeEpisodeNumber = initialEpisode
            await loadSeasonAndEpisodeStreams(seasonNumber: initialSeason, episodeNumber: initialEpisode)
        } else {
            await reloadStreamsAndSubtitles(season: nil, episode: nil)
        }
    }

    private func loadSeasonAndEpisodeStreams(seasonNumber: Int, episodeNumber: Int) async {
        isLoadingEpisodes = true
        episodes = await SeriesResumeHelper.episodesOf(rawId: item.rawId, season: seasonNumber)
        isLoadingEpisodes = false
        await reloadStreamsAndSubtitles(season: seasonNumber, episode: episodeNumber)
    }

    private func reloadStreamsAndSubtitles(season: Int?, episode: Int?) async {
        isLoadingStreams = true
        isLoadingSubtitles = true
        streamError = nil

        let yearInt = Int(item.releaseYear)
        async let fetchedSubtitles = Api.shared.fetchSubtitles(
            mediaType: item.effectiveMediaType,
            tmdbId: item.tmdbId,
            rawId: item.rawId,
            title: item.displayTitle,
            year: yearInt,
            season: season,
            episode: episode,
            langs: "en,fr"
        )

        do {
            let fetchedStreams = try await Api.shared.fetchStreams(
                mediaType: item.effectiveMediaType,
                tmdbId: item.tmdbId,
                rawId: item.rawId,
                title: item.displayTitle,
                year: yearInt,
                season: season,
                episode: episode
            )
            streams = fetchedStreams
        } catch {
            streamError = error.localizedDescription
        }
        isLoadingStreams = false

        subtitles = await fetchedSubtitles
        isLoadingSubtitles = false
    }

    private func loadShowProgressIfNeeded() async -> [WatchProgressRecord] {
        guard isTV else { return [] }
        return await Api.shared.fetchShowProgress(rawId: item.rawId, title: item.displayTitle)
    }

    private func loadMovieProgressIfNeeded() async -> WatchProgressRecord? {
        guard !isTV else { return nil }
        return await Api.shared.fetchWatchProgress(mediaType: "movie", rawId: item.rawId, title: item.displayTitle)
    }
}

private extension L10n {
    static var sourcesShort: String {
        tr("Sources", "Sources")
    }
}
