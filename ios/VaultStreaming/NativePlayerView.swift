import SwiftUI
import AVKit
import MediaPlayer

/// A native iOS media player view with hardware-accelerated decoding,
/// Picture-in-Picture, Lock Screen / Now Playing media controls,
/// AirPlay 2 support, and background playback.
public struct NativePlayerView: UIViewControllerRepresentable {
    let item: StreamPlaybackItem
    let serverURL: URL
    let onDismiss: (_ position: Double, _ duration: Double, _ completed: Bool) -> Void

    public init(
        item: StreamPlaybackItem,
        serverURL: URL,
        onDismiss: @escaping (_ position: Double, _ duration: Double, _ completed: Bool) -> Void
    ) {
        self.item = item
        self.serverURL = serverURL
        self.onDismiss = onDismiss
    }

    public func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    public func makeUIViewController(context: Context) -> AVPlayerViewController {
        let controller = AVPlayerViewController()
        controller.showsPlaybackControls = true
        controller.allowsPictureInPicturePlayback = true
        controller.canStartPictureInPictureAutomaticallyFromInline = true
        controller.delegate = context.coordinator

        // Configure audio session for background and movie playback
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .moviePlayback, policy: .longFormVideo)
            try session.setActive(true)
        } catch {
            print("[NativePlayer] Failed to set AVAudioSession category: \(error)")
        }

        // Keep screen awake while playing
        UIApplication.shared.isIdleTimerDisabled = true

        // Resolve playback URL: if source is MKV, route through on-the-fly Direct-Stream remuxer
        let playURL = resolvePlayableURL(for: item.url, startTime: item.startPosition)
        let player = AVPlayer(url: playURL)
        controller.player = player
        context.coordinator.player = player
        context.coordinator.setupRemoteControls()

        // Seek to initial resume position if direct
        if item.startPosition > 0 && !playURL.absoluteString.contains("/api/stream/remux") {
            let targetTime = CMTime(seconds: item.startPosition, preferredTimescale: 600)
            player.seek(to: targetTime, toleranceBefore: .zero, toleranceAfter: .zero)
        }

        // Setup time observer for Now Playing and progress tracking
        context.coordinator.setupTimeObserver()
        context.coordinator.setupErrorObserver()

        player.play()
        return controller
    }

    public func updateUIViewController(_ uiViewController: AVPlayerViewController, context: Context) {}

    public static func dismantleUIViewController(_ uiViewController: AVPlayerViewController, coordinator: Coordinator) {
        coordinator.cleanup()
        UIApplication.shared.isIdleTimerDisabled = false
    }

    /// Determines whether the URL can be played directly by AVPlayer or needs the Direct-Stream transmuxer.
    private func resolvePlayableURL(for sourceURL: URL, startTime: Double) -> URL {
        let pathLower = sourceURL.path.lowercased()
        let isMKV = pathLower.hasSuffix(".mkv") || pathLower.contains(".mkv?") || sourceURL.absoluteString.lowercased().contains("mkv")

        if isMKV {
            // Direct-Stream transmuxer URL on the Vault Streaming server
            var components = URLComponents(url: serverURL, resolvingAgainstBaseURL: false) ?? URLComponents()
            components.path = "/api/stream/remux"
            var queryItems = components.queryItems ?? []
            queryItems.removeAll { $0.name == "url" || $0.name == "startTime" }
            queryItems.append(URLQueryItem(name: "url", value: sourceURL.absoluteString))
            queryItems.append(URLQueryItem(name: "startTime", value: String(startTime)))
            components.queryItems = queryItems
            if let remuxURL = components.url {
                print("[NativePlayer] MKV container detected; routing through Direct-Stream transmuxer: \(remuxURL)")
                return remuxURL
            }
        }
        return sourceURL
    }

    // MARK: - Coordinator
    public class Coordinator: NSObject, AVPlayerViewControllerDelegate {
        var parent: NativePlayerView
        weak var player: AVPlayer?
        var timeObserverToken: Any?
        var statusObserver: NSKeyValueObservation?
        var failureObserverToken: Any?
        var currentDuration: Double = 0
        var currentPosition: Double = 0
        var hasReportedDismiss = false

        init(_ parent: NativePlayerView) {
            self.parent = parent
            self.currentPosition = parent.item.startPosition
        }

        func setupErrorObserver() {
            guard let player = player else { return }
            statusObserver = player.currentItem?.observe(\.status, options: [.new]) { item, _ in
                if item.status == .failed {
                    print("[NativePlayer] AVPlayerItem status failed: \(String(describing: item.error))")
                }
            }
            failureObserverToken = NotificationCenter.default.addObserver(
                forName: .AVPlayerItemFailedToPlayToEndTime,
                object: player.currentItem,
                queue: .main
            ) { notification in
                let error = notification.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error
                print("[NativePlayer] AVPlayerItem failed to play to end time: \(String(describing: error))")
            }
        }

        func setupTimeObserver() {
            guard let player = player else { return }
            let interval = CMTime(seconds: 1.0, preferredTimescale: 600)
            timeObserverToken = player.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self] time in
                guard let self = self else { return }
                self.currentPosition = time.seconds
                if let currentItem = self.player?.currentItem {
                    let dur = currentItem.duration.seconds
                    if dur.isFinite && dur > 0 {
                        self.currentDuration = dur
                    }
                }
                self.updateNowPlaying()
            }
        }

        func setupRemoteControls() {
            let commandCenter = MPRemoteCommandCenter.shared()

            commandCenter.playCommand.isEnabled = true
            commandCenter.playCommand.addTarget { [weak self] _ in
                self?.player?.play()
                return .success
            }

            commandCenter.pauseCommand.isEnabled = true
            commandCenter.pauseCommand.addTarget { [weak self] _ in
                self?.player?.pause()
                return .success
            }

            commandCenter.togglePlayPauseCommand.isEnabled = true
            commandCenter.togglePlayPauseCommand.addTarget { [weak self] _ in
                guard let self = self, let player = self.player else { return .commandFailed }
                if player.timeControlStatus == .playing {
                    player.pause()
                } else {
                    player.play()
                }
                return .success
            }

            commandCenter.skipForwardCommand.isEnabled = true
            commandCenter.skipForwardCommand.preferredIntervals = [10]
            commandCenter.skipForwardCommand.addTarget { [weak self] _ in
                guard let self = self, let player = self.player else { return .commandFailed }
                let newTime = CMTimeAdd(player.currentTime(), CMTime(seconds: 10, preferredTimescale: 600))
                player.seek(to: newTime)
                return .success
            }

            commandCenter.skipBackwardCommand.isEnabled = true
            commandCenter.skipBackwardCommand.preferredIntervals = [10]
            commandCenter.skipBackwardCommand.addTarget { [weak self] _ in
                guard let self = self, let player = self.player else { return .commandFailed }
                let newTime = CMTimeSubtract(player.currentTime(), CMTime(seconds: 10, preferredTimescale: 600))
                player.seek(to: newTime)
                return .success
            }

            commandCenter.changePlaybackPositionCommand.isEnabled = true
            commandCenter.changePlaybackPositionCommand.addTarget { [weak self] event in
                guard let self = self, let posEvent = event as? MPChangePlaybackPositionCommandEvent, let player = self.player else {
                    return .commandFailed
                }
                let targetTime = CMTime(seconds: posEvent.positionTime, preferredTimescale: 600)
                player.seek(to: targetTime)
                return .success
            }

            updateNowPlaying()
        }

        func updateNowPlaying() {
            var info = [String: Any]()
            info[MPMediaItemPropertyTitle] = parent.item.title
            if let sub = parent.item.subtitleDisplay {
                info[MPMediaItemPropertyAlbumTitle] = sub
            }
            info[MPMediaItemPropertyPlaybackDuration] = currentDuration
            info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = currentPosition
            info[MPNowPlayingInfoPropertyPlaybackRate] = (player?.timeControlStatus == .playing) ? 1.0 : 0.0

            // Async load poster artwork if available
            if let posterStr = parent.item.posterUrl, let posterURL = URL(string: posterStr) {
                URLSession.shared.dataTask(with: posterURL) { data, _, _ in
                    guard let data = data, let image = UIImage(data: data) else { return }
                    DispatchQueue.main.async {
                        var current = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [String: Any]()
                        current[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
                        MPNowPlayingInfoCenter.default().nowPlayingInfo = current
                    }
                }.resume()
            }

            MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        }

        func cleanup() {
            statusObserver?.invalidate()
            statusObserver = nil
            if let fToken = failureObserverToken {
                NotificationCenter.default.removeObserver(fToken)
                failureObserverToken = nil
            }
            if let token = timeObserverToken {
                player?.removeTimeObserver(token)
                timeObserverToken = nil
            }
            player?.pause()
            player = nil

            // Clear Now Playing
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil

            // Report final progress back to parent once
            if !hasReportedDismiss {
                hasReportedDismiss = true
                let isCompleted = (currentDuration > 0 && currentPosition >= (currentDuration - 30))
                parent.onDismiss(currentPosition, currentDuration, isCompleted)
            }
        }

        deinit {
            cleanup()
        }
    }
}
