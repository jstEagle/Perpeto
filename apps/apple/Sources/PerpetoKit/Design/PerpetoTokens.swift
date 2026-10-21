// Workshop design tokens, transcribed from brand/tokens.css.
//
// Placeholder until packages/design-tokens/swift/PerpetoTokens.swift is generated.
// The names here match that generated file exactly so it can replace this one
// without changes elsewhere. Do not add colors outside this file.

import SwiftUI

public enum PerpetoColor {
    /// Warm paper canvas. --canvas #f4f2ed
    public static let canvas = Color(hex: 0xF4F2ED)
    /// White work surface. --surface #ffffff
    public static let surface = Color(hex: 0xFFFFFF)
    /// Primary text. --ink #202521
    public static let ink = Color(hex: 0x202521)
    /// Secondary text. --muted #62665f
    public static let muted = Color(hex: 0x62665F)
    /// Nonessential separators. --border #d9dcd3
    public static let border = Color(hex: 0xD9DCD3)
    /// Interactive boundaries. --control-border #797e74
    public static let controlBorder = Color(hex: 0x797E74)
    /// Signal orange: brand and decoration, never text on white. --accent #f05a28
    public static let accent = Color(hex: 0xF05A28)
    /// Filled primary buttons and orange text. --action #ad360f
    public static let action = Color(hex: 0xAD360F)
    /// Text on action fills. --on-action #ffffff
    public static let onAction = Color(hex: 0xFFFFFF)
    /// Focus outline. --focus #2459c4
    public static let focus = Color(hex: 0x2459C4)
    /// --success #286140
    public static let success = Color(hex: 0x286140)
    /// --warning #805500
    public static let warning = Color(hex: 0x805500)
    /// --error #ad3030
    public static let error = Color(hex: 0xAD3030)
}

public enum PerpetoSpacing {
    /// --space-unit 4px
    public static let unit: CGFloat = 4
    /// Multiples of the 4 pt base unit.
    public static func x(_ multiple: CGFloat) -> CGFloat { unit * multiple }
}

public enum PerpetoRadius {
    /// --radius-control 6px
    public static let control: CGFloat = 6
    /// --radius-panel 12px
    public static let panel: CGFloat = 12
}

public enum PerpetoType {
    public static let size12: CGFloat = 12
    public static let size14: CGFloat = 14
    public static let size16: CGFloat = 16
    public static let size20: CGFloat = 20
    public static let size24: CGFloat = 24
    public static let size32: CGFloat = 32
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}
