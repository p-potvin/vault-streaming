import SwiftUI
import AVKit

/// Inline trailer player shown at the top of `MovieDetailsSheet`, using the server's
/// `/trailers/<id>.h264.mp4` route with automatic fallback to `.mp4` or YouTube thumbnail.
public struct TrailerPlayerView: View {
    let rawId: String
    let mediaType: String
    let title: String
    let fallbackImageURL: URL?
    var onTrailerResolved: ((String?) -> Void)?

    @State private var player: AVPlayer? = nil
    @State private var isMuted: Bool = AppConfig.muteTrailers
    @State private var trailerKey: String? = nil
    @State private var isLoading: Bool = true
    @State private var playbackFailed: Bool = false
    @State private var triedNonH264Fallback: Bool = false
    @State private var loadTask: Task<Void, Never>? = nil
    @State private var statusObservation: NSKeyValueObservation? = nil

    public init(
        rawId: String,
        mediaType: String,
        title: String,
        fallbackImageURL: URL?,
        onTrailerResolved: ((String?) -> Void)? = nil
    ) {
        self.rawId = rawId
        self.mediaType = mediaType
        self.title = title
        self.fallbackImageURL = fallbackImageURL
        self.onTrailerResolved = onTrailerResolved
    }

    public var body: some View {
        ZStack(alignment: .bottomTrailing) {
            if let player, !playbackFailed {
                VideoPlayer(player: player)
                    .frame(height: 240)
                    .clipped()
            } else {
                fallbackView
            }

            // Bottom fade into sheet background when not actively showing video controls
            if player == nil || playbackFailed {
                LinearGradient(
                    colors: [Color.clear, Theme.background],
                    startPoint: .center,
                    endPoint: .bottom
                )
                .frame(height: 120)
                .allowsHitTesting(false)
            }

            if isLoading {
                VStack {
                    Spacer()
                    HStack {
                        Spacer()
                        ProgressView()
                            .progressViewStyle(CircularProgressViewStyle(tint: Theme.accent))
                            .padding(10)
                            .background(Color.black.opacity(0.6))
                            .clipShape(Circle())
                        Spacer()
                    }
                    Spacer()
                }
            }

            if let player, !playbackFailed {
                Button(action: {
                    isMuted.toggle()
                    player.isMuted = isMuted
                }) {
                    Image(systemName: isMuted ? "speaker.slash.fill" : "speaker.wave.2.fill")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(.white)
                        .padding(8)
                        .background(Color.black.opacity(0.7))
                        .clipShape(Circle())
                }
                .padding(.trailing, 14)
                .padding(.bottom, 48)
                .accessibilityLabel(isMuted ? tr("Unmute Trailer", "Activer le son") : tr("Mute Trailer", "Couper le son"))
            }
        }
        .frame(height: 240)
        .background(Color.black)
        .onAppear {
            startLoading()
        }
        .onDisappear {
            teardown()
        }
    }

    @ViewBuilder
    private var fallbackView: some View {
        ZStack {
            if let key = trailerKey, playbackFailed,
               let thumbURL = URL(string: "https://img.youtube.com/vi/\(key)/hqdefault.jpg") {
                AsyncImage(url: thumbURL) { phase in
                    if let img = phase.image {
                        img.resizable().scaledToFill().opacity(0.45)
                    } else {
                        backdropImage
                    }
                }
                .frame(height: 240)
                .clipped()

                Button(action: {
                    if let ytURL = URL(string: "https://www.youtube.com/watch?v=\(key)") {
                        UIApplication.shared.open(ytURL)
                    }
                }) {
                    HStack(spacing: 8) {
                        Image(systemName: "play.rectangle.fill")
                        Text(tr("Watch Trailer on YouTube", "Voir la bande-annonce sur YouTube"))
                            .font(.caption.weight(.semibold))
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(Color.black.opacity(0.8))
                    .foregroundColor(.white)
                    .cornerRadius(Theme.radiusSmall)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.radiusSmall)
                            .stroke(Theme.accent, lineWidth: 0.8)
                    )
                }
            } else {
                backdropImage
            }
        }
    }

    @ViewBuilder
    private var backdropImage: some View {
        if let url = fallbackImageURL {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image
                        .resizable()
                        .scaledToFill()
                        .frame(height: 240)
                        .clipped()
                default:
                    Theme.cardBackground
                        .frame(height: 240)
                }
            }
        } else {
            Theme.cardBackground
                .frame(height: 240)
        }
    }

    private func startLoading() {
        guard loadTask == nil else { return }
        isLoading = true
        playbackFailed = false

        loadTask = Task {
            let result = await Api.shared.fetchTrailer(id: rawId, mediaType: mediaType, title: title)
            guard !Task.isCancelled else { return }

            guard let result, let key = result.effectiveKey else {
                await MainActor.run {
                    self.isLoading = false
                    self.onTrailerResolved?(nil)
                }
                return
            }

            await MainActor.run {
                self.trailerKey = key
                self.onTrailerResolved?(key)
            }

            guard result.success == true else {
                await MainActor.run {
                    self.isLoading = false
                    self.playbackFailed = true
                }
                return
            }

            let skipIntro = AppConfig.trailerSkipIntro && result.provider == "kinocheck"
            await MainActor.run {
                self.attachStream(youtubeId: key, h264: true, skipIntro: skipIntro)
            }
        }
    }

    @MainActor
    private func attachStream(youtubeId: String, h264: Bool, skipIntro: Bool) {
        guard let url = Api.shared.trailerURL(youtubeId: youtubeId, h264: h264) else {
            isLoading = false
            playbackFailed = true
            return
        }

        statusObservation?.invalidate()
        statusObservation = nil

        let asset = AVURLAsset(url: url, options: ["AVURLAssetHTTPHeaderFieldsKey": Api.shared.authHeaders])
        let item = AVPlayerItem(asset: asset)
        let avPlayer = player ?? AVPlayer()
        avPlayer.isMuted = isMuted
        avPlayer.volume = 0.8
        avPlayer.replaceCurrentItem(with: item)
        player = avPlayer

        statusObservation = item.observe(\.status, options: [.new]) { observedItem, _ in
            DispatchQueue.main.async {
                switch observedItem.status {
                case .readyToPlay:
                    self.isLoading = false
                    if skipIntro {
                        let start = CMTime(seconds: 3.0, preferredTimescale: 600)
                        avPlayer.seek(to: start, toleranceBefore: .zero, toleranceAfter: .zero) { _ in
                            avPlayer.play()
                        }
                    } else {
                        avPlayer.play()
                    }
                case .failed:
                    if h264 && !self.triedNonH264Fallback {
                        self.triedNonH264Fallback = true
                        self.attachStream(youtubeId: youtubeId, h264: false, skipIntro: skipIntro)
                    } else {
                        self.isLoading = false
                        self.playbackFailed = true
                    }
                default:
                    break
                }
            }
        }
    }

    private func teardown() {
        loadTask?.cancel()
        loadTask = nil
        statusObservation?.invalidate()
        statusObservation = nil
        player?.pause()
        player?.replaceCurrentItem(with: nil)
        player = nil
    }
}
