import PerpetoKit
import SwiftUI

// Workshop styling built only from PerpetoKit tokens. System font for all
// interface text; monospace only for identifiers, paths, timestamps and logs.

public enum PerpetoFont {
    /// Display: bold, tightly spaced, sentence case.
    public static func display(_ size: CGFloat = PerpetoType.text32) -> Font { .system(size: size, weight: .bold) }
    public static func title(_ size: CGFloat = PerpetoType.text20) -> Font { .system(size: size, weight: .semibold) }
    public static let heading = Font.system(size: PerpetoType.text16, weight: .semibold)
    public static let body = Font.system(size: PerpetoType.text14)
    public static let bodyMedium = Font.system(size: PerpetoType.text14, weight: .medium)
    public static let caption = Font.system(size: PerpetoType.text12)
    public static let captionMedium = Font.system(size: PerpetoType.text12, weight: .medium)
    public static func mono(_ size: CGFloat = PerpetoType.text12) -> Font { .system(size: size, design: .monospaced) }
    /// Numbers that update in place keep stable widths.
    public static func figure(_ size: CGFloat = PerpetoType.text24) -> Font { .system(size: size, weight: .semibold).monospacedDigit() }
}

extension View {
    /// Tight display tracking, proportional to size.
    public func displayTracking(_ size: CGFloat = PerpetoType.text32) -> some View {
        tracking(size * PerpetoType.displayTracking)
    }
}

// MARK: Surfaces

/// White work surface with a subtle rule and 12 pt radius.
public struct PanelModifier: ViewModifier {
    var padding: CGFloat

    public func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(PerpetoColor.surface, in: RoundedRectangle(cornerRadius: PerpetoRadius.panel, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: PerpetoRadius.panel, style: .continuous).strokeBorder(PerpetoColor.border))
    }
}

extension View {
    public func panel(padding: CGFloat = PerpetoSpacing.x(4)) -> some View { modifier(PanelModifier(padding: padding)) }

    /// Paper canvas behind a screen.
    public func canvasBackground() -> some View { background(PerpetoColor.canvas) }
}

/// A hairline separator in the subtle border token.
public struct Rule: View {
    var vertical: Bool
    public init(vertical: Bool = false) { self.vertical = vertical }
    public var body: some View {
        Rectangle().fill(PerpetoColor.border)
            .frame(width: vertical ? 1 : nil, height: vertical ? nil : 1)
    }
}

/// Section title. Titles stand on their own: no kickers or numbered labels.
public struct SectionTitle<Trailing: View>: View {
    var title: String
    var detail: String?
    var trailing: Trailing

    public init(_ title: String, detail: String? = nil, @ViewBuilder trailing: () -> Trailing = { EmptyView() }) {
        self.title = title
        self.detail = detail
        self.trailing = trailing()
    }

    public var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: PerpetoSpacing.x(2)) {
            Text(title).font(PerpetoFont.heading).foregroundStyle(PerpetoColor.ink)
            if let detail {
                Text(detail).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
            }
            Spacer(minLength: 0)
            trailing
        }
    }
}

/// Screen header: display title with an optional one-line description.
public struct ScreenHeader<Trailing: View>: View {
    var title: String
    var subtitle: String?
    var trailing: Trailing

    public init(_ title: String, subtitle: String? = nil, @ViewBuilder trailing: () -> Trailing = { EmptyView() }) {
        self.title = title
        self.subtitle = subtitle
        self.trailing = trailing()
    }

    public var body: some View {
        HStack(alignment: .bottom, spacing: PerpetoSpacing.x(4)) {
            VStack(alignment: .leading, spacing: PerpetoSpacing.x(1)) {
                Text(title)
                    .font(PerpetoFont.display(PerpetoType.text24))
                    .displayTracking(PerpetoType.text24)
                    .foregroundStyle(PerpetoColor.ink)
                if let subtitle {
                    Text(subtitle).font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted)
                }
            }
            Spacer(minLength: 0)
            trailing
        }
    }
}

// MARK: Buttons

/// Filled primary action: darker action token with white text.
public struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    public init() {}
    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(PerpetoFont.bodyMedium)
            .foregroundStyle(PerpetoColor.onAction)
            .padding(.horizontal, PerpetoSpacing.x(3))
            .frame(minHeight: PerpetoControl.heightSmall)
            .background((configuration.isPressed ? PerpetoColor.actionPressed : PerpetoColor.action).opacity(isEnabled ? 1 : 0.4),
                        in: RoundedRectangle(cornerRadius: PerpetoRadius.control, style: .continuous))
            .contentShape(Rectangle())
    }
}

/// Secondary action: white surface with the interactive border.
public struct SecondaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    public init() {}
    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(PerpetoFont.bodyMedium)
            .foregroundStyle(PerpetoColor.ink.opacity(isEnabled ? 1 : 0.4))
            .padding(.horizontal, PerpetoSpacing.x(3))
            .frame(minHeight: PerpetoControl.heightSmall)
            .background(configuration.isPressed ? PerpetoColor.surfaceHover : PerpetoColor.surface,
                        in: RoundedRectangle(cornerRadius: PerpetoRadius.control, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: PerpetoRadius.control, style: .continuous).strokeBorder(PerpetoColor.controlBorder))
            .contentShape(Rectangle())
    }
}

/// Quiet text action.
public struct GhostButtonStyle: ButtonStyle {
    public init() {}
    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(PerpetoFont.bodyMedium)
            .foregroundStyle(PerpetoColor.ink)
            .padding(.horizontal, PerpetoSpacing.x(2))
            .frame(minHeight: PerpetoControl.heightSmall)
            .background(configuration.isPressed ? PerpetoColor.canvas : .clear,
                        in: RoundedRectangle(cornerRadius: PerpetoRadius.control, style: .continuous))
            .contentShape(Rectangle())
    }
}

extension ButtonStyle where Self == PrimaryButtonStyle { public static var perpetoPrimary: PrimaryButtonStyle { .init() } }
extension ButtonStyle where Self == SecondaryButtonStyle { public static var perpetoSecondary: SecondaryButtonStyle { .init() } }
extension ButtonStyle where Self == GhostButtonStyle { public static var perpetoGhost: GhostButtonStyle { .init() } }

// MARK: Text field

public struct FieldModifier: ViewModifier {
    @FocusState private var focused: Bool
    public func body(content: Content) -> some View {
        content
            .textFieldStyle(.plain)
            .font(PerpetoFont.body)
            .foregroundStyle(PerpetoColor.ink)
            .focused($focused)
            .padding(.horizontal, PerpetoSpacing.x(2))
            .padding(.vertical, PerpetoSpacing.x(1.5))
            .background(PerpetoColor.surface, in: RoundedRectangle(cornerRadius: PerpetoRadius.control, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: PerpetoRadius.control, style: .continuous).strokeBorder(PerpetoColor.controlBorder))
            .overlay(
                RoundedRectangle(cornerRadius: PerpetoRadius.control + 2, style: .continuous)
                    .strokeBorder(PerpetoColor.focus, lineWidth: 2)
                    .padding(-3)
                    .opacity(focused ? 1 : 0))
    }
}

extension View {
    public func perpetoField() -> some View { modifier(FieldModifier()) }

    /// Blue focus outline with an offset, as brand.md specifies.
    public func focusOutline(_ visible: Bool, radius: CGFloat = PerpetoRadius.control) -> some View {
        overlay(
            RoundedRectangle(cornerRadius: radius + 3, style: .continuous)
                .strokeBorder(PerpetoColor.focus, lineWidth: 2)
                .padding(-4)
                .opacity(visible ? 1 : 0))
    }
}
