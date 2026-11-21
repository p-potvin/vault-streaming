import Foundation
import Combine

/// Tracks the active UI language (`en-US` or `fr-CA`) and provides live localization
/// aligned with `js/translations.fr.js` and `Localizable.xcstrings`.
public final class LanguageManager: ObservableObject {
    public static let shared = LanguageManager()

    @Published public private(set) var appLanguage: String
    @Published public private(set) var effectiveLanguage: String

    private var observer: NSObjectProtocol?

    private init() {
        self.appLanguage = AppConfig.appLanguage
        self.effectiveLanguage = AppConfig.effectiveLanguage
        self.observer = NotificationCenter.default.addObserver(
            forName: .vaultStreamingLanguageChanged,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            self.appLanguage = AppConfig.appLanguage
            self.effectiveLanguage = AppConfig.effectiveLanguage
        }
    }

    deinit {
        if let observer {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    public var isFrench: Bool {
        effectiveLanguage.lowercased().hasPrefix("fr")
    }

    public var locale: Locale {
        Locale(identifier: effectiveLanguage)
    }
}

/// Returns the Quebec French string (`fr-CA`) when French is active, otherwise English.
public func tr(_ en: String, _ fr: String) -> String {
    LanguageManager.shared.isFrench ? fr : en
}

public enum L10n {
    // MARK: - Navigation & Tabs
    public static var tabDiscover: String { tr("Discover", "Découvrir") }
    public static var tabSearch: String { tr("Search", "Rechercher") }
    public static var tabLibrary: String { tr("Library", "Bibliothèque") }
    public static var tabHistory: String { tr("History", "Historique") }
    public static var tabSettings: String { tr("Settings", "Paramètres") }

    // MARK: - Common
    public static var movies: String { tr("Movies", "Films") }
    public static var series: String { tr("Series", "Séries") }
    public static var movie: String { tr("Movie", "Film") }
    public static var tvSeries: String { tr("TV Series", "Série") }
    public static var all: String { tr("All", "Tous") }
    public static var featured: String { tr("FEATURED", "À LA UNE") }
    public static var play: String { tr("Play", "Lire") }
    public static var playNow: String { tr("Play now", "Lire maintenant") }
    public static var details: String { tr("Details", "Détails") }
    public static var moreDetails: String { tr("More Details", "Plus de détails") }
    public static var cancel: String { tr("Cancel", "Annuler") }
    public static var close: String { tr("Close", "Fermer") }
    public static var save: String { tr("Save", "Enregistrer") }
    public static var retry: String { tr("Retry", "Réessayer") }
    public static var loading: String { tr("Loading...", "Chargement…") }
    public static var loadMore: String { tr("Load More", "Afficher plus") }
    public static var saved: String { tr("Saved", "Enregistré") }
    public static var cached: String { tr("Cached", "En cache") }
    public static var watched: String { tr("Watched", "Vu") }
    public static var untitled: String { tr("Untitled", "Sans titre") }
    public static var noDesc: String { tr("No description available.", "Aucune description disponible.") }

    // MARK: - Formatting Helpers
    public static func seasonEpisode(_ season: Int, _ episode: Int) -> String {
        tr("Season \(season) · Episode \(episode)", "Saison \(season) · Épisode \(episode)")
    }

    public static func shortSeasonEpisode(_ season: Int, _ episode: Int) -> String {
        String(format: "S%02dE%02d", season, episode)
    }

    public static func percentCompleted(_ percent: Int) -> String {
        tr("\(percent)% completed", "\(percent) % terminé")
    }

    public static func playingIn(_ seconds: Int) -> String {
        tr("Playing in \(seconds) s", "Lecture dans \(seconds) s")
    }

    public static func minutesLeft(_ minutes: Int) -> String {
        tr("\(minutes) min left", "\(minutes) min restantes")
    }

    public static func episodeCount(_ count: Int) -> String {
        tr("\(count) episodes", "\(count) épisodes")
    }

    public static func seasonTitle(_ seasonNumber: Int) -> String {
        tr("Season \(seasonNumber)", "Saison \(seasonNumber)")
    }

    public static func episodeShort(_ number: Int) -> String {
        "E\(number)"
    }

    public static func clock(_ seconds: Double) -> String {
        let s = max(0, Int(seconds))
        let h = s / 3600
        let m = (s % 3600) / 60
        let r = s % 60
        if h > 0 {
            return String(format: "%d:%02d:%02d", h, m, r)
        }
        return String(format: "%d:%02d", m, r)
    }
}
