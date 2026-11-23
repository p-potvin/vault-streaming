import SwiftUI
import AVKit

/// Native full-screen AVPlayer experience with HLS streaming, audio track picker,
/// side-loaded WebVTT subtitles & AI transcript, stream switcher / dead-link reload,
/// Up Next card, and Episodes drawer.
public struct NativePlayerView: View {
    @StateObject private var vm: PlayerViewModel
    @ObservedObject private var lang = LanguageManager.shared
    @State private var showControlsBar: Bool = true

    public init(
        item: StreamPlaybackItem,
        serverURL: URL,
        onDismiss: @escaping (_ position: Double, _ duration: Double, _ completed: Bool) -> Void
    ) {
        _vm = StateObject(wrappedValue: PlayerViewModel(item: item, onFinish: onDismiss))
    }

    public var body: some View {
        ZStack {
            Color.black
                .ignoresSafeArea()

            PlayerControllerRepresentable(player: vm.player)
                .ignoresSafeArea()

            // Subtitles Overlay
            if let subText = vm.activeSubtitleText, !subText.isEmpty {
                VStack {
                    Spacer()
                    Text(subText)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundColor(.white)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 7)
                        .background(Color.black.opacity(0.76))
                        .cornerRadius(8)
                        .padding(.horizontal, 24)
                        .padding(.bottom, 86)
                }
                .allowsHitTesting(false)
            }

            // Top Toolbar & Status Banners
            VStack(spacing: 10) {
                topControlsRow
                if let banner = vm.statusBanner {
                    statusPill(banner)
                }
                Spacer()
            }
            .padding(.top, 52)
            .padding(.horizontal, 16)

            // Loading / Error States
            if vm.isLoadingStream && vm.errorMessage == nil {
                VStack(spacing: 10) {
                    ProgressView()
                        .progressViewStyle(CircularProgressViewStyle(tint: Theme.accent))
                        .scaleEffect(1.3)
                    Text(vm.statusBanner ?? tr("Preparing stream…", "Préparation du flux…"))
                        .font(.caption.weight(.medium))
                        .foregroundColor(.white)
                }
                .padding(18)
                .background(Color.black.opacity(0.75))
                .cornerRadius(Theme.radiusMedium)
                .allowsHitTesting(false)
            } else if let error = vm.errorMessage {
                errorCard(error)
            }

            // Up Next Card (Bottom Leading)
            if vm.showUpNextCard, let next = vm.nextEpisode {
                VStack {
                    Spacer()
                    HStack {
                        upNextCard(next: next)
                        Spacer()
                    }
                }
                .padding(.leading, 18)
                .padding(.bottom, 92)
            }

            // Episodes Drawer (Trailing Slide-Over)
            if vm.showEpisodesDrawer && vm.isSeriesEpisode {
                HStack(spacing: 0) {
                    Color.black.opacity(0.45)
                        .ignoresSafeArea()
                        .onTapGesture {
                            withAnimation(.easeInOut(duration: 0.2)) {
                                vm.showEpisodesDrawer = false
                            }
                        }

                    episodesDrawer
                }
                .transition(.move(edge: .trailing))
            }
        }
        .onAppear {
            vm.start()
        }
        .onDisappear {
            vm.cleanup()
        }
    }

    // MARK: - Top Controls Strip

    private var topControlsRow: some View {
        HStack(spacing: 8) {
            Button(action: {
                vm.cleanup()
            }) {
                Image(systemName: "xmark")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundColor(.white)
                    .padding(8)
                    .background(Color.black.opacity(0.65))
                    .clipShape(Circle())
            }

            if showControlsBar {
                Text(vm.headerTitle)
                    .font(.caption.weight(.semibold))
                    .foregroundColor(.white)
                    .lineLimit(1)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(Color.black.opacity(0.6))
                    .cornerRadius(Theme.radiusPill)

                Spacer(minLength: 4)

                HStack(spacing: 6) {
                    if vm.isSeriesEpisode {
                        if let prev = vm.prevEpisode {
                            Button(action: {
                                Task { await vm.playEpisode(season: prev.season, episode: prev.episode) }
                            }) {
                                Image(systemName: "backward.end.fill")
                                    .font(.system(size: 12))
                                    .foregroundColor(.white)
                                    .padding(8)
                                    .background(Color.black.opacity(0.65))
                                    .clipShape(Circle())
                            }
                        }

                        if let next = vm.nextEpisode {
                            Button(action: {
                                Task { await vm.playEpisode(season: next.season, episode: next.episode) }
                            }) {
                                Image(systemName: "forward.end.fill")
                                    .font(.system(size: 12))
                                    .foregroundColor(.white)
                                    .padding(8)
                                    .background(Color.black.opacity(0.65))
                                    .clipShape(Circle())
                            }
                        }

                        Button(action: {
                            withAnimation(.easeInOut(duration: 0.2)) {
                                vm.showEpisodesDrawer.toggle()
                            }
                        }) {
                            Image(systemName: "list.bullet.rectangle")
                                .font(.system(size: 13))
                                .foregroundColor(vm.showEpisodesDrawer ? Theme.accent : .white)
                                .padding(8)
                                .background(Color.black.opacity(0.65))
                                .clipShape(Circle())
                        }
                    }

                    if !vm.audioTracks.isEmpty {
                        audioMenu
                    }

                    subtitlesMenu

                    if vm.currentItem.candidates.count > 1 {
                        streamsMenu
                    }

                    Button(action: {
                        Task { await vm.reloadActiveStream(auto: false) }
                    }) {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 13))
                            .foregroundColor(.white)
                            .padding(8)
                            .background(Color.black.opacity(0.65))
                            .clipShape(Circle())
                    }
                }
            } else {
                Spacer()
            }

            Button(action: {
                withAnimation(.easeInOut(duration: 0.15)) {
                    showControlsBar.toggle()
                }
            }) {
                Image(systemName: showControlsBar ? "chevron.up" : "ellipsis")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(.white)
                    .padding(8)
                    .background(Color.black.opacity(0.65))
                    .clipShape(Circle())
            }
        }
    }

    private var audioMenu: some View {
        Menu {
            ForEach(vm.audioTracks) { track in
                Button(action: { vm.selectAudioTrack(track) }) {
                    let langPart = track.lang.uppercased()
                    let titlePart = track.title ?? track.codec?.uppercased() ?? ""
                    let label = titlePart.isEmpty ? langPart : "\(langPart) · \(titlePart)"
                    if vm.selectedAudioIndex == track.audioIndex {
                        Label(label, systemImage: "checkmark")
                    } else {
                        Text(label)
                    }
                }
            }
        } label: {
            Image(systemName: "waveform")
                .font(.system(size: 13))
                .foregroundColor(.white)
                .padding(8)
                .background(Color.black.opacity(0.65))
                .clipShape(Circle())
        }
    }

    private var subtitlesMenu: some View {
        Menu {
            Button(action: { vm.disableSubtitles() }) {
                if vm.selectedSubtitleId == nil {
                    Label(tr("Off", "Désactivés"), systemImage: "checkmark")
                } else {
                    Text(tr("Off", "Désactivés"))
                }
            }

            if let transcript = vm.transcriptStatus {
                let statusText = transcript.state == "ready"
                    ? tr("AI Transcript", "Transcription IA")
                    : "\(tr("AI Transcript", "Transcription IA")) (\(transcript.state))"
                Button(action: {
                    Task { await vm.selectAiTranscript() }
                }) {
                    if vm.selectedSubtitleId == "ai_transcript" {
                        Label(statusText, systemImage: "checkmark")
                    } else {
                        Text(statusText)
                    }
                }
                .disabled(transcript.state != "ready")
            }

            if !vm.subtitleTracks.isEmpty {
                Divider()
                ForEach(vm.subtitleTracks.prefix(15)) { track in
                    Button(action: {
                        Task { await vm.selectSubtitleTrack(track) }
                    }) {
                        let name = "\(track.language.uppercased()) · \(track.release ?? track.label)"
                        if vm.selectedSubtitleId == track.id {
                            Label(name, systemImage: "checkmark")
                        } else {
                            Text(name)
                        }
                    }
                }
            }

            if vm.selectedSubtitleId != nil {
                Divider()
                Button(tr("Subtitles -0.25s", "Sous-titres -0,25 s")) {
                    vm.shiftSubtitleSync(-0.25)
                }
                Button(tr("Subtitles +0.25s", "Sous-titres +0,25 s")) {
                    vm.shiftSubtitleSync(0.25)
                }
                if vm.subtitleSyncOffset != 0 {
                    Button(tr("Reset Sync (\(String(format: "%.2f", vm.subtitleSyncOffset))s)",
                              "Réinitialiser (\(String(format: "%.2f", vm.subtitleSyncOffset)) s)")) {
                        vm.shiftSubtitleSync(-vm.subtitleSyncOffset)
                    }
                }
            }
        } label: {
            Image(systemName: vm.selectedSubtitleId == nil ? "captions.bubble" : "captions.bubble.fill")
                .font(.system(size: 13))
                .foregroundColor(vm.selectedSubtitleId == nil ? .white : Theme.accent)
                .padding(8)
                .background(Color.black.opacity(0.65))
                .clipShape(Circle())
        }
    }

    private var streamsMenu: some View {
        Menu {
            ForEach(vm.currentItem.candidates.prefix(10)) { cand in
                Button(action: {
                    Task { await vm.switchStreamCandidate(cand) }
                }) {
                    let prefix = cand.isCached ? "⚡ " : ""
                    let frTag = cand.isFrench ? " [FR]" : ""
                    let label = "\(prefix)\(cand.displayQuality)\(frTag) · \(cand.cleanReleaseTitle)"
                    if vm.currentItem.sourceStream?.id == cand.id {
                        Label(label, systemImage: "checkmark")
                    } else {
                        Text(label)
                    }
                }
            }
        } label: {
            Image(systemName: "slider.horizontal.3")
                .font(.system(size: 13))
                .foregroundColor(.white)
                .padding(8)
                .background(Color.black.opacity(0.65))
                .clipShape(Circle())
        }
    }

    private func statusPill(_ text: String) -> some View {
        Text(text)
            .font(.caption.weight(.medium))
            .foregroundColor(.white)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Color.black.opacity(0.75))
            .cornerRadius(Theme.radiusPill)
    }

    private func errorCard(_ error: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 28))
                .foregroundColor(.orange)
            Text(tr("Stream Error", "Erreur de flux"))
                .font(.headline)
                .foregroundColor(.white)
            Text(error)
                .font(.caption)
                .foregroundColor(Theme.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 16)

            HStack(spacing: 12) {
                Button(tr("Reload Stream", "Recharger le flux")) {
                    Task { await vm.reloadActiveStream(auto: false) }
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.accent)
                .foregroundColor(.black)

                Button(L10n.close) {
                    vm.cleanup()
                }
                .buttonStyle(.bordered)
                .foregroundColor(.white)
            }
        }
        .padding(20)
        .background(Theme.cardBackground.opacity(0.95))
        .cornerRadius(Theme.radiusMedium)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.radiusMedium)
                .stroke(Theme.cardBorder, lineWidth: 1)
        )
        .padding(.horizontal, 24)
    }

    // MARK: - Up Next Card

    private func upNextCard(next: (season: Int, episode: Int, info: EpisodeItem?)) -> some View {
        HStack(spacing: 12) {
            if let stillURL = next.info?.stillURL {
                VaultImage(url: stillURL) { phase in
                    if let img = phase.image {
                        img.resizable().scaledToFill()
                    } else {
                        Theme.secondaryBackground
                    }
                }
                .frame(width: 96, height: 58)
                .cornerRadius(6)
                .clipped()
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("\(tr("Up next", "À suivre")) · \(L10n.shortSeasonEpisode(next.season, next.episode))")
                    .font(.caption2.weight(.bold))
                    .foregroundColor(Theme.accent)

                Text(next.info?.name ?? L10n.seasonEpisode(next.season, next.episode))
                    .font(.subheadline.weight(.semibold))
                    .foregroundColor(.white)
                    .lineLimit(1)

                HStack(spacing: 8) {
                    Button(action: {
                        Task { await vm.playEpisode(season: next.season, episode: next.episode) }
                    }) {
                        HStack(spacing: 4) {
                            Image(systemName: "play.fill")
                                .font(.caption2)
                            Text(vm.upNextCountdown.map { L10n.playingIn($0) } ?? L10n.playNow)
                                .font(.caption.weight(.bold))
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(Theme.accentGradient)
                        .foregroundColor(.black)
                        .cornerRadius(6)
                    }

                    Button(action: { vm.dismissUpNextCard() }) {
                        Text(tr("Hide", "Masquer"))
                            .font(.caption)
                            .foregroundColor(Theme.textSecondary)
                    }
                }
            }
        }
        .padding(12)
        .background(Theme.cardBackground.opacity(0.95))
        .cornerRadius(Theme.radiusMedium)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.radiusMedium)
                .stroke(Theme.accent.opacity(0.5), lineWidth: 1)
        )
        .frame(maxWidth: 340)
    }

    // MARK: - Episodes Panel Drawer

    private var episodesDrawer: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Menu {
                    ForEach(vm.seasons) { s in
                        Button(s.name ?? L10n.seasonTitle(s.season_number)) {
                            Task { await vm.loadDrawerSeason(s.season_number) }
                        }
                    }
                } label: {
                    HStack(spacing: 6) {
                        Text(vm.seasons.first(where: { $0.season_number == vm.selectedEpisodeSeason })?.name
                             ?? L10n.seasonTitle(vm.selectedEpisodeSeason))
                            .font(.headline)
                            .foregroundColor(.white)
                        Image(systemName: "chevron.down")
                            .font(.caption)
                            .foregroundColor(Theme.accent)
                    }
                }

                Spacer()

                Button(action: {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        vm.showEpisodesDrawer = false
                    }
                }) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.title3)
                        .foregroundColor(Theme.textSecondary)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 18)

            Divider()
                .background(Theme.cardBorder)

            ScrollView(.vertical, showsIndicators: true) {
                LazyVStack(spacing: 10) {
                    ForEach(vm.seasonEpisodes) { ep in
                        episodeDrawerRow(ep)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 24)
            }
        }
        .frame(width: min(340, UIScreen.main.bounds.width * 0.82))
        .background(Theme.background.opacity(0.97))
        .overlay(
            Rectangle()
                .fill(Theme.cardBorder)
                .frame(width: 1),
            alignment: .leading
        )
    }

    private func episodeDrawerRow(_ ep: EpisodeItem) -> some View {
        let isCurrent = vm.currentItem.season == vm.selectedEpisodeSeason && vm.currentItem.episode == ep.episode_number
        let prog = vm.showProgressMap["\(vm.selectedEpisodeSeason):\(ep.episode_number)"]

        return Button(action: {
            if !isCurrent {
                Task { await vm.playEpisode(season: vm.selectedEpisodeSeason, episode: ep.episode_number) }
            }
        }) {
            HStack(spacing: 10) {
                ZStack(alignment: .bottom) {
                    if let stillURL = ep.stillURL {
                        VaultImage(url: stillURL) { phase in
                            if let img = phase.image {
                                img.resizable().scaledToFill()
                            } else {
                                Theme.cardBackground
                            }
                        }
                    } else {
                        Theme.cardBackground
                    }

                    if let prog, prog.completed || prog.progressFraction > 0 {
                        GeometryReader { geo in
                            VStack {
                                Spacer()
                                ZStack(alignment: .leading) {
                                    Rectangle().fill(Color.black.opacity(0.6)).frame(height: 3)
                                    Rectangle()
                                        .fill(Theme.accent)
                                        .frame(width: geo.size.width * CGFloat(prog.completed ? 1.0 : prog.progressFraction), height: 3)
                                }
                            }
                        }
                    }
                }
                .frame(width: 90, height: 52)
                .cornerRadius(6)
                .clipped()

                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(L10n.episodeShort(ep.episode_number))
                            .font(.caption.weight(.bold))
                            .foregroundColor(Theme.accent)

                        if prog?.completed == true {
                            Image(systemName: "checkmark.circle.fill")
                                .font(.caption2)
                                .foregroundColor(Theme.successGreen)
                        }

                        if isCurrent {
                            Text(tr("Playing", "En cours"))
                                .font(.system(size: 10, weight: .bold))
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1)
                                .background(Theme.accent.opacity(0.2))
                                .foregroundColor(Theme.accent)
                                .cornerRadius(4)
                        }
                    }

                    Text(ep.name ?? "\(tr("Episode", "Épisode")) \(ep.episode_number)")
                        .font(.caption.weight(.semibold))
                        .foregroundColor(.white)
                        .lineLimit(2)

                    if let runtime = ep.runtime, runtime > 0 {
                        Text("\(runtime) min")
                            .font(.caption2)
                            .foregroundColor(Theme.textTertiary)
                    }
                }

                Spacer(minLength: 0)
            }
            .padding(8)
            .background(isCurrent ? Theme.accent.opacity(0.12) : Theme.cardBackground)
            .cornerRadius(Theme.radiusSmall)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.radiusSmall)
                    .stroke(isCurrent ? Theme.accent : Theme.cardBorder, lineWidth: 0.8)
            )
        }
        .buttonStyle(.plain)
    }
}

private struct PlayerControllerRepresentable: UIViewControllerRepresentable {
    let player: AVPlayer?

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let controller = AVPlayerViewController()
        controller.showsPlaybackControls = true
        controller.allowsPictureInPicturePlayback = true
        controller.canStartPictureInPictureAutomaticallyFromInline = true
        controller.player = player
        return controller
    }

    func updateUIViewController(_ uiViewController: AVPlayerViewController, context: Context) {
        if uiViewController.player !== player {
            uiViewController.player = player
        }
    }
}
