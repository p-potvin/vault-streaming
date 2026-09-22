import SwiftUI

/// Shared design system tokens for the native Vault Streaming iOS app.
/// Implements a dark violet cinematic palette with glassmorphism accents.
public struct Theme {
    // MARK: - Core Palette
    public static let background = Color(hex: 0x0B0813)
    public static let secondaryBackground = Color(hex: 0x120E1F)
    public static let cardBackground = Color(hex: 0x1A152B)
    public static let cardBorder = Color(hex: 0x2E2548)
    
    // MARK: - Brand Accents
    public static let accent = Color(hex: 0xB07CFF)
    public static let accentSecondary = Color(hex: 0x7C4DFF)
    public static let accentGradient = LinearGradient(
        colors: [Color(hex: 0xB07CFF), Color(hex: 0x7C4DFF)],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )
    
    // MARK: - Semantic Colors
    public static let ratingGold = Color(hex: 0xFBBF24)
    public static let frenchAccent = Color(hex: 0x3B82F6)
    public static let frenchBackground = Color(hex: 0x1E3A8A).opacity(0.7)
    public static let successGreen = Color(hex: 0x10B981)
    
    // MARK: - Text Hierarchy
    public static let textPrimary = Color.white
    public static let textSecondary = Color(white: 0.75)
    public static let textTertiary = Color(white: 0.48)
    
    // MARK: - Corner Radii
    public static let radiusSmall: CGFloat = 8
    public static let radiusMedium: CGFloat = 12
    public static let radiusLarge: CGFloat = 16
    public static let radiusPill: CGFloat = 24
}

// MARK: - Color Hex Initializer
public extension Color {
    init(hex: UInt, alpha: Double = 1.0) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255.0,
            green: Double((hex >> 8) & 0xFF) / 255.0,
            blue: Double(hex & 0xFF) / 255.0,
            opacity: alpha
        )
    }
}
