import SwiftUI
import AVFoundation
import MediaPlayer

/// Coordinates `AVPlayer` HLS playback, audio track selection, WebVTT subtitles & AI transcripts,
/// dead-link auto-reload, Keep-Warm / Moments indexing, and series episode flow.
@MainActor
public final class PlayerViewModel: NSObject, ObservableObject {
    @Published public var currentItem: StreamPlaybackItem
    @Published public var player: AVPlayer? = nil

    @Published public var isLoadingStream: Bool = true
    @Published public var statusBanner: String? = nil
    @Published public var errorMessage: String? = nil

    @Published public var currentPosition: Double = 0
    @Published public var currentDuration: Double = 0
    @Published public var isPlaying: Bool = false

    // Audio
    @Published public var audioTracks: [AudioTrackInfo] = []
    @Published public var selectedAudioIndex: Int? = nil

    // Subtitles & Transcript
    @Published public var subtitleTracks: [SubtitleTrack] = []
    @Published public var selectedSubtitleId: String? = nil // nil = off, "ai_transcript" = AI
    @Published public var activeSubtitleText: String? = nil
    @Published public var subtitleSyncOffset: Double = 0
    @Published public var transcriptStatus: TranscriptStatus? = nil

    // Series Flow
    @Published public var seasons: [SeasonSummary] = []
    @Published public var selectedEpisodeSeason: Int = 1
    @Published public var seasonEpisodes: [EpisodeItem] = []
    @Published public var showProgressMap: [String: WatchProgressRecord] = [:]
    @Published public var prevEpisode: (season: Int, episode: Int, info: EpisodeItem?)? = nil
    @Published public var nextEpisode: (season: Int, episode: Int, info: EpisodeItem?)? = nil
    @Published public var currentEpisodeName: String? = nil

    // Up Next Overlay
    @Published public var showUpNextCard: Bool = false
    @Published public var upNextCountdown: Int? = nil
    @Published public var showEpisodesDrawer: Bool = false

    private var activeCues: [SubtitleCue] = []
    private var timeObserverToken: Any?
    private var statusObserver: NSKeyValueObservation?
    private var rateObserver: NSKeyValueObservation?
    private var endObserverToken: Any?
    private var failureObserverToken: Any?

    private var lastProgressSaveAt: Date = .distantPast
    private var lastKeepWarmAt: Date = .distantPast
    private var playedSeconds: Double = 0
    private var momentsIndexed: Bool = false
    private var introSkipDone: Bool = false
    private var preloadedNext: Bool = false
    private var upNextDismissed: Bool = false
    private var creditsDone: Bool = false
    private var hasEnded: Bool = false

    private var autoReloadCount: Int = 0
    private var lastGoodPosition: Double = 0
    private var lastReloadAt: Date? = nil
    private var countdownTask: Task<Void, Never>? = nil
    private var transcriptPollTask: Task<Void, Never>? = nil
    private var artworkTask: Task<Void, Never>? = nil
    private var cachedArtwork: MPMediaItemArtwork? = nil
    private var remoteCommandCleanups: [() -> Void] = []
    private var hasCleanedUp: Bool = false

    public let onFinish: (_ position: Double, _ duration: Double, _ completed: Bool) -> Void

    public init(
        item: StreamPlaybackItem,
        onFinish: @escaping (_ position: Double, _ duration: Double, _ completed: Bool) -> Void
    ) {
        self.currentItem = item
        self.currentPosition = item.startPosition
        self.lastGoodPosition = item.startPosition
        self.selectedEpisodeSeason = item.season ?? 1
        self.onFinish = onFinish
        super.init()
    }

    public var effectiveRawId: String {
        if let r = currentItem.rawId, !r.isEmpty { return r }
        if let t = currentItem.tmdbId, t > 0 { return String(t) }
        return currentItem.title
    }

    public var isSeriesEpisode: Bool {
        currentItem.mediaType == "tv" && currentItem.season != nil && currentItem.episode != nil
    }

    public var headerTitle: String {
        if isSeriesEpisode, let s = currentItem.season, let e = currentItem.episode {
            var parts = [currentItem.title, L10n.shortSeasonEpisode(s, e)]
            if let epName = currentEpisodeName, !epName.isEmpty {
                parts.append(epName)
            }
            return parts.joined(separator: " · ")
        }
        return currentItem.title
    }

    // MARK: - Lifecycle

    public func start() {
        configureAudioSession()
        UIApplication.shared.isIdleTimerDisabled = true
        setupRemoteControls()
        loadCurrentItem(resumeAt: currentItem.startPosition, audioIndex: nil)
    }

    public func cleanup() {
        guard !hasCleanedUp else { return }
        hasCleanedUp = true

        countdownTask?.cancel()
        countdownTask = nil
        transcriptPollTask?.cancel()
        transcriptPollTask = nil
        artworkTask?.cancel()
        artworkTask = nil

        for remove in remoteCommandCleanups {
            remove()
        }
        remoteCommandCleanups.removeAll()

        detachPlayerObservers()
        player?.pause()
        player?.replaceCurrentItem(with: nil)
        player = nil

        UIApplication.shared.isIdleTimerDisabled = false
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil

        let finalCompleted = creditsDone || AppConfig.isWatchedAt(position: currentPosition, duration: currentDuration)
        let pos = currentPosition
        let dur = currentDuration
        let item = currentItem
        let rawId = effectiveRawId

        Task {
            if finalCompleted {
                await Api.shared.markWatched(
                    mediaType: item.mediaType ?? "movie",
                    rawId: rawId,
                    title: item.title,
                    posterUrl: item.posterUrl,
                    year: item.year,
                    season: item.season,
                    episode: item.episode
                )
            } else if dur > 0 && pos > 1 {
                await Api.shared.recordProgress(
                    mediaType: item.mediaType ?? "movie",
                    tmdbId: item.tmdbId,
                    rawId: rawId,
                    title: item.title,
                    position: pos,
                    duration: dur,
                    completed: false,
                    posterUrl: item.posterUrl,
                    year: item.year,
                    season: item.season,
                    episode: item.episode,
                    lastSource: item.sourceStream
                )
            }
        }

        onFinish(pos, dur, finalCompleted)
    }

    // MARK: - Stream Loading

    private func configureAudioSession() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .moviePlayback, policy: .longFormVideo)
            try session.setActive(true)
        } catch {
            print("[NativePlayer] Failed to set AVAudioSession category: \(error)")
        }
    }

    private func loadCurrentItem(resumeAt: Double, audioIndex: Int?, cacheBust: Bool = false) {
        detachPlayerObservers()
        isLoadingStream = true
        errorMessage = nil

        let sourceURLString = currentItem.url.absoluteString
        let targetURL: URL
        if let hls = Api.shared.hlsURL(for: sourceURLString, audioIndex: audioIndex, maxHeight: AppConfig.maxStreamHeight) {
            if cacheBust, var comps = URLComponents(url: hls, resolvingAgainstBaseURL: false) {
                var items = comps.queryItems ?? []
                items.append(URLQueryItem(name: "reload", value: String(Int(Date().timeIntervalSince1970))))
                comps.queryItems = items
                targetURL = comps.url ?? hls
            } else {
                targetURL = hls
            }
        } else {
            targetURL = currentItem.url
        }

        let asset = AVURLAsset(url: targetURL, options: ["AVURLAssetHTTPHeaderFieldsKey": Api.shared.authHeaders])
        let playerItem = AVPlayerItem(asset: asset)

        let avPlayer = player ?? AVPlayer()
        avPlayer.replaceCurrentItem(with: playerItem)
        self.player = avPlayer

        attachObservers(for: avPlayer, item: playerItem, resumeAt: resumeAt)

        // Reset per-episode tasks on fresh episode load (not on audio switch / reload)
        if audioIndex == nil && !cacheBust {
            playedSeconds = 0
            momentsIndexed = false
            introSkipDone = false
            preloadedNext = false
            upNextDismissed = false
            creditsDone = false
            hasEnded = false
            showUpNextCard = false
            upNextCountdown = nil
            countdownTask?.cancel()
            activeCues = []
            activeSubtitleText = nil
            selectedSubtitleId = nil
            currentEpisodeName = nil
            loadPosterArtworkOnce()

            Task { await probeAudioAndAutoSelect() }
            Task { await loadSubtitlesAndTranscript() }
            if isSeriesEpisode {
                Task { await loadSeriesContext() }
            }
        }
    }

    private func detachPlayerObservers() {
        statusObserver?.invalidate()
        statusObserver = nil
        rateObserver?.invalidate()
        rateObserver = nil
        if let endToken = endObserverToken {
            NotificationCenter.default.removeObserver(endToken)
            endObserverToken = nil
        }
        if let fToken = failureObserverToken {
            NotificationCenter.default.removeObserver(fToken)
            failureObserverToken = nil
        }
        if let tToken = timeObserverToken {
            player?.removeTimeObserver(tToken)
            timeObserverToken = nil
        }
    }

    private func attachObservers(for avPlayer: AVPlayer, item: AVPlayerItem, resumeAt: Double) {
        statusObserver = item.observe(\.status, options: [.new]) { [weak self] observed, _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                switch observed.status {
                case .readyToPlay:
                    self.isLoadingStream = false
                    self.statusBanner = nil
                    let dur = observed.duration.seconds
                    if dur.isFinite && dur > 0 {
                        self.currentDuration = dur
                        // Provider error status clip check (< 60 s for a movie)
                        if !self.isSeriesEpisode && dur < 60 && self.autoReloadCount < 1 {
                            await self.tryNextCandidateOnFailure()
                            return
                        }
                    }

                    var seekTarget = resumeAt
                    if seekTarget <= 5, !self.introSkipDone, self.isSeriesEpisode {
                        self.introSkipDone = true
                        let skip = AppConfig.seriesSkip(for: self.effectiveRawId).intro
                        if skip > 0 && (self.currentDuration <= 0 || Double(skip) < self.currentDuration - 60) {
                            seekTarget = Double(skip)
                            self.showTransientBanner(tr("Intro skipped (\(skip) s)", "Intro passée (\(skip) s)"))
                        }
                    }

                    if seekTarget > 1 && (self.currentDuration <= 0 || seekTarget < self.currentDuration - 3) {
                        let target = CMTime(seconds: seekTarget, preferredTimescale: 600)
                        _ = await avPlayer.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero)
                    }
                    avPlayer.play()

                case .failed:
                    self.isLoadingStream = false
                    await self.handleStreamFailure(error: observed.error)

                default:
                    break
                }
            }
        }

        rateObserver = avPlayer.observe(\.timeControlStatus, options: [.new]) { [weak self] p, _ in
            Task { @MainActor [weak self] in
                self?.isPlaying = (p.timeControlStatus == .playing)
                self?.updateNowPlaying()
            }
        }

        endObserverToken = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: item,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.handleEpisodeEnded()
            }
        }

        failureObserverToken = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemFailedToPlayToEndTime,
            object: item,
            queue: .main
        ) { [weak self] notification in
            let err = notification.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error
            Task { @MainActor [weak self] in
                await self?.handleStreamFailure(error: err)
            }
        }

        let interval = CMTime(seconds: 0.5, preferredTimescale: 600)
        timeObserverToken = avPlayer.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self] time in
            Task { @MainActor [weak self] in
                self?.onTimeTick(seconds: time.seconds)
            }
        }
    }

    private func onTimeTick(seconds: Double) {
        guard seconds.isFinite else { return }
        currentPosition = max(0, seconds)

        if let dur = player?.currentItem?.duration.seconds, dur.isFinite && dur > 0 {
            currentDuration = dur
        }

        if isPlaying && currentPosition > 1 {
            lastGoodPosition = currentPosition
            playedSeconds += 0.5
            if let lastReloadAt, Date().timeIntervalSince(lastReloadAt) >= 60 {
                autoReloadCount = 0
                self.lastReloadAt = nil
            }
        }

        // Update active subtitle cue
        activeSubtitleText = WebVTTParser.activeCue(in: activeCues, at: currentPosition, offset: subtitleSyncOffset)

        let now = Date()

        // Progress save every 10 s
        if isPlaying && now.timeIntervalSince(lastProgressSaveAt) >= 10 && currentDuration > 0 && currentPosition > 1 && !creditsDone {
            lastProgressSaveAt = now
            let completed = AppConfig.isWatchedAt(position: currentPosition, duration: currentDuration)
            let item = currentItem
            let rawId = effectiveRawId
            let pos = currentPosition
            let dur = currentDuration
            Task {
                await Api.shared.recordProgress(
                    mediaType: item.mediaType ?? "movie",
                    tmdbId: item.tmdbId,
                    rawId: rawId,
                    title: item.title,
                    position: pos,
                    duration: dur,
                    completed: completed,
                    posterUrl: item.posterUrl,
                    year: item.year,
                    season: item.season,
                    episode: item.episode,
                    lastSource: item.sourceStream
                )
            }
        }

        // Keep-warm while paused every 60 s
        if !isPlaying && now.timeIntervalSince(lastKeepWarmAt) >= 60 {
            lastKeepWarmAt = now
            let urlStr = currentItem.url.absoluteString
            Task { await Api.shared.keepStreamWarm(url: urlStr) }
        }

        // Moments indexing after 2 minutes of playback
        if !momentsIndexed && playedSeconds >= 120 {
            momentsIndexed = true
            let idx = selectedAudioIndex ?? 0
            let track = audioTracks.first { $0.audioIndex == idx }
            let item = currentItem
            let rawId = effectiveRawId
            let dur = currentDuration > 0 ? currentDuration : nil
            Task {
                await Api.shared.indexMomentsPlayback(
                    url: item.url.absoluteString,
                    title: item.title,
                    rawId: rawId,
                    mediaType: item.mediaType ?? "movie",
                    season: item.season,
                    episode: item.episode,
                    audioIndex: idx,
                    language: track?.lang ?? "und",
                    languageSource: track?.langSource ?? "none",
                    durationSec: dur,
                    sourceRelease: item.sourceStream?.cleanReleaseTitle
                )
            }
        }

        // Series Up Next, Preload, and Credits End
        if isSeriesEpisode && currentDuration >= 60 {
            let end = effectiveEndSeconds
            let remaining = end - currentPosition

            if !preloadedNext && remaining <= NextEpisodePreloader.preloadBeforeEndSeconds && remaining > 0,
               let next = nextEpisode {
                preloadedNext = true
                NextEpisodePreloader.shared.preload(
                    mediaTitle: currentItem.title,
                    rawId: effectiveRawId,
                    tmdbId: currentItem.tmdbId,
                    season: next.season,
                    episode: next.episode
                )
            }

            let upNextThreshold = Double(AppConfig.upNextSeconds)
            if upNextThreshold > 0 && !showUpNextCard && !upNextDismissed && !hasEnded && remaining <= upNextThreshold && remaining > 0,
               nextEpisode != nil {
                showUpNextCard = true
            }

            if !hasEnded && currentPosition >= min(end, currentDuration - 1) {
                creditsDone = true
                handleEpisodeEnded()
            }
        }

        updateNowPlaying()
    }

    private var effectiveEndSeconds: Double {
        guard currentDuration > 0 else { return .infinity }
        let outro = AppConfig.seriesSkip(for: effectiveRawId).outro
        if outro > 0 && Double(outro) < currentDuration - 30 {
            return currentDuration - Double(outro)
        }
        return currentDuration
    }

    // MARK: - Audio Track Choice

    private func probeAudioAndAutoSelect() async {
        let preferred = AppConfig.preferredStreamLang
        guard let result = await Api.shared.probeAudioTracks(
            url: currentItem.url.absoluteString,
            preferredLang: preferred
        ), let tracks = result.tracks, !tracks.isEmpty else {
            return
        }

        self.audioTracks = tracks
        var chosenIndex = result.chosenAudioIndex ?? tracks[0].audioIndex

        // If preferred language is specific and undetermined tracks exist, run Nemotron detection
        if result.needsDetection == true, let undetermined = result.undetermined, !undetermined.isEmpty {
            for idx in undetermined.prefix(2) {
                if let detectedLang = await Api.shared.detectAudioLanguage(
                    url: currentItem.url.absoluteString,
                    audioIndex: idx,
                    durationSeconds: result.durationSeconds
                ), detectedLang == preferred {
                    chosenIndex = idx
                    break
                }
            }
        }

        if selectedAudioIndex == nil {
            selectedAudioIndex = chosenIndex
            // the first load asked HLS for no audio index, which plays a:0 whatever track the file marks default
            if chosenIndex != 0 {
                loadCurrentItem(resumeAt: lastGoodPosition, audioIndex: chosenIndex)
            }
        }
    }

    public func selectAudioTrack(_ track: AudioTrackInfo) {
        guard selectedAudioIndex != track.audioIndex else { return }
        selectedAudioIndex = track.audioIndex
        let pos = currentPosition > 1 ? currentPosition : lastGoodPosition
        loadCurrentItem(resumeAt: pos, audioIndex: track.audioIndex)
    }

    // MARK: - Subtitles & AI Transcript

    private func loadSubtitlesAndTranscript() async {
        let tracks = await Api.shared.fetchSubtitles(
            mediaType: currentItem.mediaType ?? "movie",
            tmdbId: currentItem.tmdbId,
            rawId: effectiveRawId,
            title: currentItem.title,
            year: currentItem.year.flatMap(Int.init),
            season: currentItem.season,
            episode: currentItem.episode,
            langs: "en,fr"
        )
        self.subtitleTracks = tracks

        // Check AI transcript status & poll while preparing
        await refreshTranscriptStatus()
        startTranscriptPollingIfNeeded()

        // Auto-select default subtitle language
        let pref = AppConfig.defaultSubtitleLang
        guard pref != "none", pref != "off", !pref.isEmpty else { return }

        if let best = tracks.first(where: {
            $0.language.lowercased().hasPrefix(pref.lowercased()) && !$0.machineTranslated
        }) ?? tracks.first(where: { $0.language.lowercased().hasPrefix(pref.lowercased()) }) {
            await selectSubtitleTrack(best)
        } else if let st = transcriptStatus, st.state == "ready",
                  (st.lang ?? "").lowercased().hasPrefix(pref.lowercased()) {
            await selectAiTranscript()
        }
    }

    private func refreshTranscriptStatus() async {
        if let st = try? await Api.shared.fetchTranscript(
            mediaType: currentItem.mediaType ?? "movie",
            rawId: effectiveRawId,
            season: currentItem.season,
            episode: currentItem.episode
        ) {
            self.transcriptStatus = st
        }
    }

    private func startTranscriptPollingIfNeeded() {
        transcriptPollTask?.cancel()
        transcriptPollTask = Task { [weak self] in
            // up to 2 h (a transcript grows with the film); cleanup() cancels it when the player closes
            for _ in 0..<480 {
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                guard !Task.isCancelled, let self else { return }
                let cuesBefore = self.transcriptStatus?.cues ?? 0
                await self.refreshTranscriptStatus()
                guard let st = self.transcriptStatus else { continue }
                // the transcript grows while the server reads the source ("ready" + partial): reload the shown
                // captions as cues are added, and keep polling until it is complete
                if st.state == "ready", self.selectedSubtitleId == "ai_transcript", (st.cues ?? 0) > cuesBefore {
                    await self.selectAiTranscript()
                }
                if st.state == "failed" || (st.state == "ready" && st.partial != true) {
                    return
                }
            }
        }
    }

    public func disableSubtitles() {
        selectedSubtitleId = nil
        activeCues = []
        activeSubtitleText = nil
    }

    public func selectAiTranscript() async {
        guard let st = transcriptStatus, st.state == "ready",
              let path = st.path,
              let url = Api.shared.mediaFileURL(serverPath: path) else {
            return
        }
        await loadVTT(from: url, trackId: "ai_transcript")
    }

    public func selectSubtitleTrack(_ track: SubtitleTrack) async {
        do {
            let url: URL
            if let fileId = track.fileId {
                url = try await Api.shared.downloadSubtitleTrack(fileId: fileId)
            } else if let uStr = track.url, let parsed = URL(string: uStr) {
                url = parsed
            } else {
                return
            }
            await loadVTT(from: url, trackId: track.id)
        } catch {
            showTransientBanner(tr("Subtitle download failed.", "Échec du téléchargement des sous-titres."))
        }
    }

    private func loadVTT(from url: URL, trackId: String) async {
        do {
            let data = try await Api.shared.fetchData(from: url)
            guard let text = String(data: data, encoding: .utf8)
                ?? String(data: data, encoding: .isoLatin1) else {
                return
            }
            self.activeCues = WebVTTParser.parse(text)
            self.selectedSubtitleId = trackId
            self.activeSubtitleText = WebVTTParser.activeCue(
                in: self.activeCues,
                at: self.currentPosition,
                offset: self.subtitleSyncOffset
            )
        } catch {
            showTransientBanner(tr("Could not read subtitle file.", "Impossible de lire ce fichier de sous-titres."))
        }
    }

    public func shiftSubtitleSync(_ delta: Double) {
        subtitleSyncOffset = (subtitleSyncOffset + delta).rounded(toPlaces: 2)
        activeSubtitleText = WebVTTParser.activeCue(in: activeCues, at: currentPosition, offset: subtitleSyncOffset)
    }

    // MARK: - Stream Switching & Dead-Link Reload

    public func switchStreamCandidate(_ candidate: TorrentStream) async {
        let resumeAt = currentPosition > 1 ? currentPosition : lastGoodPosition
        isLoadingStream = true
        showTransientBanner(tr("Switching source…", "Changement de source…"))
        do {
            if let resolved = try await Api.shared.resolveStream(candidate),
               resolved.success == true,
               let uStr = resolved.streamUrl,
               let url = URL(string: uStr) {
                currentItem = StreamPlaybackItem(
                    url: url,
                    title: currentItem.title,
                    posterUrl: currentItem.posterUrl,
                    year: currentItem.year,
                    startPosition: resumeAt,
                    mediaType: currentItem.mediaType,
                    tmdbId: currentItem.tmdbId,
                    rawId: currentItem.rawId,
                    season: currentItem.season,
                    episode: currentItem.episode,
                    sourceStream: candidate,
                    candidates: currentItem.candidates
                )
                selectedAudioIndex = nil
                loadCurrentItem(resumeAt: resumeAt, audioIndex: nil, cacheBust: false)
                return
            }
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoadingStream = false
    }

    public func reloadActiveStream(auto: Bool = false) async {
        let resumeAt = currentPosition > 1 ? currentPosition : lastGoodPosition
        lastReloadAt = Date()
        showTransientBanner(tr("Reloading stream…", "Rechargement du flux…"))

        if let src = currentItem.sourceStream,
           let resolved = try? await Api.shared.resolveStream(src),
           resolved.success == true,
           let uStr = resolved.streamUrl,
           let url = URL(string: uStr) {
            currentItem = StreamPlaybackItem(
                url: url,
                title: currentItem.title,
                posterUrl: currentItem.posterUrl,
                year: currentItem.year,
                startPosition: resumeAt,
                mediaType: currentItem.mediaType,
                tmdbId: currentItem.tmdbId,
                rawId: currentItem.rawId,
                season: currentItem.season,
                episode: currentItem.episode,
                sourceStream: src,
                candidates: currentItem.candidates
            )
            loadCurrentItem(resumeAt: resumeAt, audioIndex: selectedAudioIndex, cacheBust: true)
            return
        }

        if auto {
            loadCurrentItem(resumeAt: resumeAt, audioIndex: selectedAudioIndex, cacheBust: true)
        } else {
            await tryNextCandidateOnFailure()
        }
    }

    private func handleStreamFailure(error: Error?) async {
        if autoReloadCount < 3 {
            autoReloadCount += 1
            await reloadActiveStream(auto: true)
            return
        }
        await tryNextCandidateOnFailure(fallbackError: error)
    }

    private func tryNextCandidateOnFailure(fallbackError: Error? = nil) async {
        let currentId = currentItem.sourceStream?.id
        let remaining = currentItem.candidates.filter { $0.id != currentId && $0.url != nil }
        for candidate in remaining.prefix(4) {
            if let resolved = try? await Api.shared.resolveStream(candidate),
               resolved.success == true,
               let uStr = resolved.streamUrl,
               let url = URL(string: uStr) {
                autoReloadCount = 0
                // the new source has its own tracks: probe and choose again (a stale index kept the old label while
                // a:0 played, and stopped the probe from choosing)
                selectedAudioIndex = nil
                let pos = lastGoodPosition
                currentItem = StreamPlaybackItem(
                    url: url,
                    title: currentItem.title,
                    posterUrl: currentItem.posterUrl,
                    year: currentItem.year,
                    startPosition: pos,
                    mediaType: currentItem.mediaType,
                    tmdbId: currentItem.tmdbId,
                    rawId: currentItem.rawId,
                    season: currentItem.season,
                    episode: currentItem.episode,
                    sourceStream: candidate,
                    candidates: remaining
                )
                loadCurrentItem(resumeAt: pos, audioIndex: nil, cacheBust: false)
                return
            }
        }
        errorMessage = fallbackError?.localizedDescription
            ?? tr("Stream playback failed.", "Erreur lors de la lecture du flux.")
    }

    // MARK: - Series Flow (Adjacent Episodes, Up Next, Episodes Panel)

    private func loadSeriesContext() async {
        guard let season = currentItem.season, let episode = currentItem.episode else { return }
        let rawId = effectiveRawId

        async let fetchedSeasons = SeriesResumeHelper.seasonsOf(rawId: rawId)
        async let fetchedNext = SeriesResumeHelper.adjacentEpisode(rawId: rawId, season: season, episode: episode, direction: +1)
        async let fetchedPrev = SeriesResumeHelper.adjacentEpisode(rawId: rawId, season: season, episode: episode, direction: -1)
        async let fetchedCur = SeriesResumeHelper.episodeInfo(rawId: rawId, season: season, episode: episode)
        async let fetchedProgress = Api.shared.fetchShowProgress(rawId: rawId, title: currentItem.title)

        let (sList, nxt, prv, curInfo, progList) = await (fetchedSeasons, fetchedNext, fetchedPrev, fetchedCur, fetchedProgress)

        self.seasons = sList
        self.nextEpisode = nxt
        self.prevEpisode = prv
        self.currentEpisodeName = curInfo?.name
        self.selectedEpisodeSeason = season

        var map: [String: WatchProgressRecord] = [:]
        for p in progList {
            if let ps = p.season, let pe = p.episode {
                map["\(ps):\(pe)"] = p
            }
        }
        self.showProgressMap = map
        self.seasonEpisodes = await SeriesResumeHelper.episodesOf(rawId: rawId, season: season)
    }

    public func loadDrawerSeason(_ season: Int) async {
        selectedEpisodeSeason = season
        seasonEpisodes = await SeriesResumeHelper.episodesOf(rawId: effectiveRawId, season: season)
    }

    public func dismissUpNextCard() {
        upNextDismissed = true
        showUpNextCard = false
        upNextCountdown = nil
        countdownTask?.cancel()
    }

    private func handleEpisodeEnded() {
        guard !hasEnded else { return }
        hasEnded = true

        if isSeriesEpisode {
            let item = currentItem
            let rawId = effectiveRawId
            Task {
                await Api.shared.markWatched(
                    mediaType: "tv",
                    rawId: rawId,
                    title: item.title,
                    posterUrl: item.posterUrl,
                    year: item.year,
                    season: item.season,
                    episode: item.episode
                )
            }
        }

        guard isSeriesEpisode, let next = nextEpisode else { return }
        showUpNextCard = true

        guard AppConfig.autoplayNextEpisode else {
            upNextCountdown = nil
            return
        }

        var remaining = 5
        upNextCountdown = remaining
        countdownTask?.cancel()
        countdownTask = Task { [weak self] in
            while remaining > 0 {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard !Task.isCancelled, let self, !self.upNextDismissed else { return }
                remaining -= 1
                self.upNextCountdown = remaining
            }
            guard !Task.isCancelled, let self, !self.upNextDismissed else { return }
            // playEpisode cancels countdownTask, which is this task: let go of it first, or the next episode's
            // lookup (cancellation-aware URLSession) is cancelled with it
            self.countdownTask = nil
            await self.playEpisode(season: next.season, episode: next.episode)
        }
    }

    public func playEpisode(season: Int, episode: Int) async {
        countdownTask?.cancel()
        showUpNextCard = false
        showEpisodesDrawer = false
        isLoadingStream = true
        statusBanner = tr("Loading next episode…", "Chargement de l'épisode suivant…")

        // Save current progress before switching
        let prevItem = currentItem
        let prevRawId = effectiveRawId
        let prevPos = currentPosition
        let prevDur = currentDuration
        let prevDone = creditsDone || AppConfig.isWatchedAt(position: prevPos, duration: prevDur)
        if prevDur > 0 && prevPos > 1 {
            Task {
                if prevDone {
                    await Api.shared.markWatched(
                        mediaType: "tv",
                        rawId: prevRawId,
                        title: prevItem.title,
                        posterUrl: prevItem.posterUrl,
                        year: prevItem.year,
                        season: prevItem.season,
                        episode: prevItem.episode
                    )
                } else {
                    await Api.shared.recordProgress(
                        mediaType: "tv",
                        tmdbId: prevItem.tmdbId,
                        rawId: prevRawId,
                        title: prevItem.title,
                        position: prevPos,
                        duration: prevDur,
                        completed: false,
                        posterUrl: prevItem.posterUrl,
                        year: prevItem.year,
                        season: prevItem.season,
                        episode: prevItem.episode,
                        lastSource: prevItem.sourceStream
                    )
                }
            }
        }

        do {
            let outcome: ResolvedPlayOutcome
            if let preloaded = await NextEpisodePreloader.shared.takePreloaded(
                rawId: prevRawId,
                title: prevItem.title,
                season: season,
                episode: episode
            ) {
                outcome = preloaded
            } else {
                outcome = try await StreamResolver.shared.resolvePlayableStream(
                    mediaType: "tv",
                    tmdbId: prevItem.tmdbId,
                    rawId: prevRawId,
                    title: prevItem.title,
                    year: prevItem.year.flatMap(Int.init),
                    season: season,
                    episode: episode
                ) { [weak self] msg in
                    Task { @MainActor [weak self] in
                        self?.statusBanner = msg
                    }
                }
            }

            currentItem = StreamPlaybackItem(
                url: outcome.streamURL,
                title: prevItem.title,
                posterUrl: prevItem.posterUrl,
                year: prevItem.year,
                startPosition: outcome.startPosition,
                mediaType: "tv",
                tmdbId: prevItem.tmdbId,
                rawId: prevItem.rawId,
                season: season,
                episode: episode,
                sourceStream: outcome.stream,
                candidates: outcome.candidates
            )
            currentPosition = outcome.startPosition
            lastGoodPosition = outcome.startPosition
            selectedAudioIndex = nil
            loadCurrentItem(resumeAt: outcome.startPosition, audioIndex: nil, cacheBust: false)
        } catch {
            isLoadingStream = false
            statusBanner = nil
            errorMessage = error.localizedDescription
        }
    }

    private func showTransientBanner(_ message: String) {
        statusBanner = message
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            if self?.statusBanner == message {
                self?.statusBanner = nil
            }
        }
    }

    // MARK: - Lock Screen / Remote Controls

    private func loadPosterArtworkOnce() {
        artworkTask?.cancel()
        cachedArtwork = nil
        guard let pStr = currentItem.posterUrl, let url = URL(string: pStr) else { return }
        artworkTask = Task { [weak self] in
            guard let (data, _) = try? await URLSession.shared.data(from: url),
                  let image = UIImage(data: data),
                  !Task.isCancelled else {
                return
            }
            self?.cachedArtwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
            self?.updateNowPlaying()
        }
    }

    private func setupRemoteControls() {
        let commandCenter = MPRemoteCommandCenter.shared()

        commandCenter.playCommand.isEnabled = true
        let playToken = commandCenter.playCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.player?.play() }
            return .success
        }

        commandCenter.pauseCommand.isEnabled = true
        let pauseToken = commandCenter.pauseCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.player?.pause() }
            return .success
        }

        commandCenter.togglePlayPauseCommand.isEnabled = true
        let toggleToken = commandCenter.togglePlayPauseCommand.addTarget { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let player = self?.player else { return }
                if player.timeControlStatus == .playing {
                    player.pause()
                } else {
                    player.play()
                }
            }
            return .success
        }

        commandCenter.skipForwardCommand.isEnabled = true
        commandCenter.skipForwardCommand.preferredIntervals = [10]
        let fwdToken = commandCenter.skipForwardCommand.addTarget { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let player = self?.player else { return }
                let target = CMTimeAdd(player.currentTime(), CMTime(seconds: 10, preferredTimescale: 600))
                _ = await player.seek(to: target)
            }
            return .success
        }

        commandCenter.skipBackwardCommand.isEnabled = true
        commandCenter.skipBackwardCommand.preferredIntervals = [10]
        let bwdToken = commandCenter.skipBackwardCommand.addTarget { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let player = self?.player else { return }
                let target = CMTimeSubtract(player.currentTime(), CMTime(seconds: 10, preferredTimescale: 600))
                _ = await player.seek(to: target)
            }
            return .success
        }

        commandCenter.changePlaybackPositionCommand.isEnabled = true
        let seekToken = commandCenter.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let posEvent = event as? MPChangePlaybackPositionCommandEvent else {
                return .commandFailed
            }
            Task { @MainActor [weak self] in
                guard let player = self?.player else { return }
                _ = await player.seek(to: CMTime(seconds: posEvent.positionTime, preferredTimescale: 600))
            }
            return .success
        }

        remoteCommandCleanups = [
            { commandCenter.playCommand.removeTarget(playToken) },
            { commandCenter.pauseCommand.removeTarget(pauseToken) },
            { commandCenter.togglePlayPauseCommand.removeTarget(toggleToken) },
            { commandCenter.skipForwardCommand.removeTarget(fwdToken) },
            { commandCenter.skipBackwardCommand.removeTarget(bwdToken) },
            { commandCenter.changePlaybackPositionCommand.removeTarget(seekToken) }
        ]
    }

    private func updateNowPlaying() {
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: currentItem.title,
            MPMediaItemPropertyPlaybackDuration: currentDuration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: currentPosition,
            MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? 1.0 : 0.0
        ]
        if let sub = currentItem.subtitleDisplay {
            info[MPMediaItemPropertyAlbumTitle] = sub
        }
        if let cachedArtwork {
            info[MPMediaItemPropertyArtwork] = cachedArtwork
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }
}

private extension Double {
    func rounded(toPlaces places: Int) -> Double {
        let divisor = pow(10.0, Double(places))
        return (self * divisor).rounded() / divisor
    }
}
