import PerpetoKit
import SwiftUI

// Perpeto Mono, built only from PerpetoKit tokens: warm canvas, white rounded
// cards with soft elevation, near-black ink, generous space. System sans for
// everything; monospace only for identifiers.

public enum PerpetoFont {
    /// Page titles: 40 semibold, tight. 32 on narrow screens.
    public static func display(_ size: CGFloat = PerpetoType.display40) -> Font { PerpetoType.display(size) }
    public static func title(_ size: CGFloat = PerpetoType.text20) -> Font { PerpetoType.title(size) }
    /// Card titles.
    public static let heading = PerpetoType.title(PerpetoType.text16)
    public static let body = PerpetoType.text(PerpetoType.text14)
    public static let bodyMedium = PerpetoType.text(PerpetoType.text14, weight: .medium)
    /// Meta text: 13 in `muted`.
    public static let caption = PerpetoType.text(PerpetoType.text13)
    public static let captionMedium = PerpetoType.text(PerpetoType.text13, weight: .medium)
    /// Captions, axis labels and edge counts only.
    public static let small = PerpetoType.text(PerpetoType.text12)
    public static func mono(_ size: CGFloat = PerpetoType.text13) -> Font { PerpetoType.mono(size) }
    /// Metrics: semibold with tabular figures.
    public static func figure(_ size: CGFloat = PerpetoType.text32) -> Font { PerpetoType.title(size).monospacedDigit() }
}

extension View {
    /// Tight display tracking, proportional to size.
    public func displayTracking(_ size: CGFloat = PerpetoType.display40) -> some View {
        tracking(PerpetoType.tracking(forDisplay: size))
    }
}

// MARK: Surfaces

extension View {
    /// A white card: 20 pt continuous corners, soft card elevation, no border.
    /// 28 pt padding, 20 when compact.
    public func card(padding: CGFloat? = nil) -> some View { modifier(CardModifier(padding: padding)) }

    /// Older name for `card()`. Padding follows the card scale, not the argument.
    public func panel(padding: CGFloat = 0) -> some View { modifier(CardModifier(padding: nil)) }

    /// The warm canvas behind a screen.
    public func canvasBackground() -> some View { background(PerpetoColor.canvas) }

    /// Soft elevation for a capsule of the given height.
    func pillElevation(_ elevation: PerpetoElevation, height: CGFloat) -> some View {
        perpetoElevation(elevation, cornerRadius: height / 2)
    }
}

struct CardModifier: ViewModifier {
    var padding: CGFloat?
    @Environment(\.compactLayout) private var compact

    func body(content: Content) -> some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .perpetoCard(padding: padding ?? (compact ? PerpetoLayout.cardPaddingCompact : PerpetoLayout.cardPadding))
    }
}

/// A hairline between list rows. Rules are rare: whitespace separates.
public struct Rule: View {
    var vertical: Bool
    public init(vertical: Bool = false) { self.vertical = vertical }
    public var body: some View {
        Rectangle().fill(PerpetoColor.border)
            .frame(width: vertical ? PerpetoStroke.hairline : nil, height: vertical ? nil : PerpetoStroke.hairline)
    }
}

/// Card head: a 16 pt title on the left and one quiet item on the right,
/// either meta text or a trailing link.
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
        HStack(alignment: .firstTextBaseline, spacing: PerpetoSpacing.x(3)) {
            Text(title).font(PerpetoFont.heading).foregroundStyle(PerpetoColor.ink)
            Spacer(minLength: PerpetoSpacing.x(2))
            if let detail {
                Text(detail).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).lineLimit(1)
            }
            trailing
        }
    }
}

/// A quiet link with a chevron for card heads: "All runs ›".
public struct CardLink: View {
    var title: String
    var action: () -> Void
    public init(_ title: String, action: @escaping () -> Void) {
        self.title = title
        self.action = action
    }
    public var body: some View {
        Button(action: action) {
            HStack(spacing: PerpetoSpacing.x(1.5)) {
                Text(title)
                Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold))
            }
            .font(PerpetoFont.captionMedium)
            .foregroundStyle(PerpetoColor.ink)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// Page header: optional back link, a 40 pt title with an optional status
/// chip, one meta line, and actions aligned to the bottom right. On narrow
/// screens the actions go full width under the meta line.
public struct ScreenHeader<Meta: View, Trailing: View>: View {
    var title: String
    var back: (title: String, action: () -> Void)?
    var status: (String, StatusTone)?
    var meta: Meta
    var trailing: Trailing
    @Environment(\.compactLayout) private var compact

    public init(
        _ title: String, back: (title: String, action: () -> Void)? = nil, status: (String, StatusTone)? = nil,
        @ViewBuilder meta: () -> Meta, @ViewBuilder trailing: () -> Trailing = { EmptyView() }
    ) {
        self.title = title
        self.back = back
        self.status = status
        self.meta = meta()
        self.trailing = trailing()
    }

    public var body: some View {
        if compact {
            VStack(alignment: .leading, spacing: PerpetoSpacing.x(4)) {
                titles
                trailing.controlSize(.large)
            }
        } else {
            HStack(alignment: .bottom, spacing: PerpetoSpacing.x(6)) {
                titles
                Spacer(minLength: 0)
                HStack(spacing: PerpetoSpacing.x(3)) { trailing }
            }
        }
    }

    private var titles: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(2)) {
            if let back {
                Button(action: back.action) {
                    HStack(spacing: PerpetoSpacing.x(1.5)) {
                        Image(systemName: "chevron.left").font(.system(size: 10, weight: .semibold))
                        Text(back.title)
                    }
                    .font(PerpetoFont.caption)
                    .foregroundStyle(PerpetoColor.muted)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.bottom, PerpetoSpacing.x(1))
            }
            HStack(alignment: .center, spacing: PerpetoSpacing.x(3)) {
                let size = compact ? PerpetoType.text32 : PerpetoType.display40
                Text(title).font(PerpetoFont.display(size)).displayTracking(size).foregroundStyle(PerpetoColor.ink)
                    .lineLimit(2)
                if let status { StatusChip(status.0, tone: status.1) }
            }
            meta
                .font(PerpetoType.text(compact ? PerpetoType.text13 : PerpetoType.text14))
                .foregroundStyle(PerpetoColor.muted)
        }
    }
}

extension ScreenHeader where Meta == Text {
    public init(_ title: String, subtitle: String? = nil, back: (title: String, action: () -> Void)? = nil, status: (String, StatusTone)? = nil,
                @ViewBuilder trailing: () -> Trailing = { EmptyView() }) {
        self.init(title, back: back, status: status, meta: { Text(subtitle ?? "") }, trailing: trailing)
    }
}

// MARK: Adaptive layout

extension EnvironmentValues {
    /// True on iPhone and narrow windows. Wide layouts stack instead of
    /// compressing; set once by `RootView` from the detail column's width.
    @Entry public var compactLayout = false
}

/// A main column with a fixed-width side column. Stacks when compact.
public struct AdaptiveColumns<Main: View, Side: View>: View {
    var sideWidth: CGFloat
    var main: Main
    var side: Side
    @Environment(\.compactLayout) private var compact

    public init(sideWidth: CGFloat = 360, @ViewBuilder main: () -> Main, @ViewBuilder side: () -> Side) {
        self.sideWidth = sideWidth
        self.main = main()
        self.side = side()
    }

    public var body: some View {
        if compact {
            VStack(alignment: .leading, spacing: PerpetoSpacing.x(4)) {
                main
                side
            }
        } else {
            HStack(alignment: .top, spacing: PerpetoSpacing.x(6)) {
                VStack(alignment: .leading, spacing: PerpetoSpacing.x(6)) { main }.frame(maxWidth: .infinity)
                VStack(alignment: .leading, spacing: PerpetoSpacing.x(6)) { side }.frame(width: sideWidth)
            }
        }
    }
}

extension View {
    /// Page padding (48, or 24 when compact), content capped at the content
    /// width and centred beside the sidebar.
    public func screenPadding() -> some View { modifier(ScreenPadding()) }
}

struct ScreenPadding: ViewModifier {
    @Environment(\.compactLayout) private var compact
    func body(content: Content) -> some View {
        content
            .padding(.horizontal, compact ? PerpetoLayout.pagePaddingCompact : PerpetoLayout.pagePadding)
            .padding(.top, compact ? PerpetoSpacing.x(4) : PerpetoSpacing.x(10))
            .padding(.bottom, compact ? PerpetoLayout.pagePaddingCompact : PerpetoLayout.pagePadding)
            .frame(maxWidth: PerpetoLayout.contentMax + 2 * PerpetoLayout.pagePadding, alignment: .topLeading)
            .frame(maxWidth: .infinity, alignment: .top)
    }
}

/// Vertical rhythm between cards and sections.
public enum PerpetoGap {
    public static let cards = PerpetoSpacing.x(6)
    public static let section = PerpetoLayout.sectionGap
}

// MARK: Buttons

/// Pill height and label size by control size: 32 small, 40 default, 48 large.
struct PillMetrics {
    var height: CGFloat
    var padding: CGFloat
    var font: Font

    init(_ size: ControlSize) {
        switch size {
        case .mini, .small: self.init(height: PerpetoControl.heightSmall, padding: PerpetoSpacing.x(4), font: PerpetoType.text(PerpetoType.text13, weight: .medium))
        case .large, .extraLarge: self.init(height: PerpetoControl.heightLarge, padding: PerpetoSpacing.x(6), font: PerpetoType.text(PerpetoType.text16, weight: .medium))
        default: self.init(height: PerpetoControl.height, padding: PerpetoSpacing.x(5), font: PerpetoType.text(PerpetoType.text14, weight: .medium))
        }
    }

    init(height: CGFloat, padding: CGFloat, font: Font) {
        self.height = height
        self.padding = padding
        self.font = font
    }
}

/// The black pill: one per view, the main next step.
public struct PrimaryButtonStyle: ButtonStyle {
    public init() {}
    public func makeBody(configuration: Configuration) -> some View { Pill(configuration: configuration, kind: .primary) }
}

/// White pill with card elevation for other actions.
public struct SecondaryButtonStyle: ButtonStyle {
    public init() {}
    public func makeBody(configuration: Configuration) -> some View { Pill(configuration: configuration, kind: .secondary) }
}

/// Text-only pill for cancel, row and card actions.
public struct GhostButtonStyle: ButtonStyle {
    public init() {}
    public func makeBody(configuration: Configuration) -> some View { Pill(configuration: configuration, kind: .ghost) }
}

struct Pill: View {
    enum Kind { case primary, secondary, ghost }
    var configuration: ButtonStyleConfiguration
    var kind: Kind
    @Environment(\.controlSize) private var controlSize
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.fullWidthButtons) private var fullWidth
    @State private var hovering = false

    var body: some View {
        let m = PillMetrics(controlSize)
        configuration.label
            .font(m.font)
            .labelStyle(PillLabelStyle())
            .lineLimit(1)
            .foregroundStyle(foreground)
            .padding(.horizontal, kind == .ghost ? PerpetoSpacing.x(3) : m.padding)
            .frame(height: m.height)
            .frame(maxWidth: fullWidth && kind != .ghost ? .infinity : nil)
            .background(Capsule(style: .continuous).fill(fill))
            .modifier(PillShadow(kind: kind, enabled: isEnabled, hovering: hovering, height: m.height))
            .contentShape(Capsule())
            .scaleEffect(configuration.isPressed && kind != .ghost ? 0.98 : 1)
            .animation(PerpetoMotion.standard(reduceMotion: reduceMotion), value: configuration.isPressed)
            .animation(PerpetoMotion.standard(reduceMotion: reduceMotion), value: hovering)
            .onHover { hovering = $0 }
    }

    private var foreground: Color {
        guard isEnabled else { return PerpetoColor.muted }
        switch kind {
        case .primary: return PerpetoColor.onAction
        case .secondary: return PerpetoColor.ink
        case .ghost: return hovering ? PerpetoColor.ink : PerpetoColor.inkSoft
        }
    }

    private var fill: Color {
        guard isEnabled else { return kind == .ghost ? .clear : PerpetoColor.surfaceSubtle }
        switch kind {
        case .primary: return configuration.isPressed ? PerpetoColor.actionPressed : hovering ? PerpetoColor.actionHover : PerpetoColor.action
        case .secondary: return hovering ? PerpetoColor.surfaceHover : PerpetoColor.surface
        case .ghost: return hovering ? PerpetoColor.canvasStrong : .clear
        }
    }
}

struct PillShadow: ViewModifier {
    var kind: Pill.Kind
    var enabled: Bool
    var hovering: Bool
    var height: CGFloat

    func body(content: Content) -> some View {
        if kind == .secondary && enabled {
            content.pillElevation(hovering ? .raised : .card, height: height)
        } else {
            content
        }
    }
}

/// Icons are 18 pt and leading, 8 pt from the label.
struct PillLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: PerpetoSpacing.x(2)) {
            configuration.icon.font(.system(size: 13, weight: .semibold))
            configuration.title
        }
    }
}

extension ButtonStyle where Self == PrimaryButtonStyle { public static var perpetoPrimary: PrimaryButtonStyle { .init() } }
extension ButtonStyle where Self == SecondaryButtonStyle { public static var perpetoSecondary: SecondaryButtonStyle { .init() } }
extension ButtonStyle where Self == GhostButtonStyle { public static var perpetoGhost: GhostButtonStyle { .init() } }

extension EnvironmentValues {
    /// Primary and secondary pills fill the width, for narrow-screen actions.
    @Entry var fullWidthButtons = false
}

extension View {
    func fullWidthButtons(_ on: Bool = true) -> some View { environment(\.fullWidthButtons, on) }
}

/// Circular icon-only button at the control height, with an accessible label.
public struct IconButton: View {
    var systemImage: String
    var label: String
    var elevated: Bool
    var action: () -> Void
    @State private var hovering = false

    public init(_ systemImage: String, label: String, elevated: Bool = false, action: @escaping () -> Void) {
        self.systemImage = systemImage
        self.label = label
        self.elevated = elevated
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(PerpetoColor.inkSoft)
                .frame(width: PerpetoControl.height, height: PerpetoControl.height)
                .background(Circle().fill(elevated ? PerpetoColor.surface : (hovering ? PerpetoColor.canvasStrong : .clear)))
                .modifier(IconElevation(on: elevated))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityLabel(label)
        .help(label)
    }
}

struct IconElevation: ViewModifier {
    var on: Bool
    func body(content: Content) -> some View {
        if on { content.perpetoElevation(.card, cornerRadius: PerpetoControl.height / 2) } else { content }
    }
}

// MARK: Inputs

/// 40 pt field: white, 1 pt control border, 12 pt corners, 16 pt padding.
/// Focus darkens the border to ink at 2 pt.
public struct FieldModifier: ViewModifier {
    @FocusState private var focused: Bool

    public func body(content: Content) -> some View {
        content
            .textFieldStyle(.plain)
            .font(PerpetoFont.body)
            .focused($focused)
            .padding(.horizontal, PerpetoSpacing.x(4))
            .padding(.vertical, PerpetoSpacing.x(2.5))
            .frame(minHeight: PerpetoControl.height)
            .background(PerpetoColor.surface, in: RoundedRectangle(cornerRadius: PerpetoRadius.control, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: PerpetoRadius.control, style: .continuous)
                    .strokeBorder(focused ? PerpetoColor.ink : PerpetoColor.controlBorder, lineWidth: focused ? 2 : PerpetoStroke.hairline))
            .focusEffectDisabled()
    }
}

extension View {
    public func perpetoField() -> some View { modifier(FieldModifier()) }

    /// Keyboard focus: a 2 pt ink outline with a 2 pt offset.
    public func focusOutline(_ visible: Bool, radius: CGFloat = PerpetoRadius.control) -> some View {
        overlay(
            RoundedRectangle(cornerRadius: radius + PerpetoStroke.focusOffset, style: .continuous)
                .strokeBorder(PerpetoColor.focus, lineWidth: PerpetoStroke.focus)
                .padding(-(PerpetoStroke.focus + PerpetoStroke.focusOffset))
                .opacity(visible ? 1 : 0))
    }

    /// Selection on the drawing: a 1.5 pt ink ring.
    public func selectionOutline(_ visible: Bool, radius: CGFloat = PerpetoRadius.node) -> some View {
        overlay(
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .strokeBorder(PerpetoColor.ink, lineWidth: PerpetoStroke.selection)
                .opacity(visible ? 1 : 0))
    }
}

// MARK: Segmented control

/// A pill track with a white thumb that slides to the selected option.
public struct PillPicker<Value: Hashable>: View {
    var options: [(value: Value, title: String, count: Int?)]
    @Binding var selection: Value
    @Namespace private var thumb
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(_ options: [(value: Value, title: String, count: Int?)], selection: Binding<Value>) {
        self.options = options
        _selection = selection
    }

    public init(_ options: [(Value, String)], selection: Binding<Value>) {
        self.options = options.map { (value: $0.0, title: $0.1, count: nil) }
        _selection = selection
    }

    public var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                let selected = option.value == selection
                Button {
                    withAnimation(PerpetoMotion.easeOut(reduceMotion: reduceMotion)) { selection = option.value }
                } label: {
                    HStack(spacing: PerpetoSpacing.x(1.5)) {
                        Text(option.title).font(PerpetoFont.captionMedium)
                        if let count = option.count { Text("\(count)").font(PerpetoFont.caption.monospacedDigit()) }
                    }
                    .foregroundStyle(selected ? PerpetoColor.ink : PerpetoColor.muted)
                    .padding(.horizontal, PerpetoSpacing.x(4))
                    .frame(height: 34)
                    .background {
                        if selected {
                            Capsule(style: .continuous).fill(PerpetoColor.surface)
                                .pillElevation(.card, height: 34)
                                .matchedGeometryEffect(id: "thumb", in: thumb)
                        }
                    }
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
        .padding(3)
        .background(Capsule(style: .continuous).fill(PerpetoColor.canvasStrong))
        .fixedSize()
    }
}

// MARK: Disclosure

/// Progressive disclosure: "More metrics ⌄". Names what is hidden; the
/// chevron turns and the content expands with the base ease-out.
public struct Disclosure<Content: View>: View {
    var title: String
    @Binding var isExpanded: Bool
    var content: Content
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(_ title: String, isExpanded: Binding<Bool>, @ViewBuilder content: () -> Content) {
        self.title = title
        _isExpanded = isExpanded
        self.content = content()
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(5)) {
            Button {
                withAnimation(PerpetoMotion.easeOut(reduceMotion: reduceMotion)) { isExpanded.toggle() }
            } label: {
                HStack(spacing: PerpetoSpacing.x(1.5)) {
                    Text(title)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 9, weight: .semibold))
                        .rotationEffect(.degrees(isExpanded ? 180 : 0))
                }
                .font(PerpetoFont.captionMedium)
                .foregroundStyle(PerpetoColor.inkSoft)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
            if isExpanded {
                content.transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }
}
