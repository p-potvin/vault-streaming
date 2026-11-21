import SwiftUI

/// Responsive poster grid layout for iPhone (2–3 columns) and iPad (4–5 columns).
public enum AdaptiveGrid {
    public static var isPad: Bool {
        UIDevice.current.userInterfaceIdiom == .pad
    }

    public static func columnCount(for width: CGFloat, isPad: Bool = Self.isPad) -> Int {
        if isPad {
            return width >= 1024 ? 5 : 4
        }
        return width >= 540 ? 3 : 2
    }

    public static func posterColumns(for width: CGFloat, spacing: CGFloat = 14, isPad: Bool = Self.isPad) -> [GridItem] {
        let count = columnCount(for: width, isPad: isPad)
        return Array(repeating: GridItem(.flexible(), spacing: spacing), count: count)
    }
}
