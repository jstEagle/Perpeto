import SwiftUI

/// The eight-arm Spindle symbol, drawn from the master SVG geometry.
///
/// Fills its frame while preserving the square aspect ratio. Color it with
/// `.foregroundStyle(...)` using a token: ink by default, accent for brand
/// moments, surface on dark fills.
public struct SpindleShape: Shape {
    public init() {}

    public func path(in rect: CGRect) -> Path {
        LogoGeometry.spindle.fitted(in: rect)
    }
}

/// The lowercase bold **perpeto** wordmark, drawn from its outlined SVG.
public struct WordmarkShape: Shape {
    public init() {}

    /// Width divided by height of the tight glyph bounds.
    public static var aspectRatio: CGFloat {
        let box = LogoGeometry.wordmark.bounds
        return box.width / box.height
    }

    public func path(in rect: CGRect) -> Path {
        LogoGeometry.wordmark.fitted(in: rect)
    }
}

/// Symbol plus wordmark, proportioned like brand/identity/perpeto-lockup.svg:
/// wordmark glyph height is 0.75 of the symbol, gap 0.14, vertically centered.
public struct PerpetoLockup: View {
    var height: CGFloat
    var symbolColor: Color
    var wordmarkColor: Color

    public init(height: CGFloat = 20, symbolColor: Color = PerpetoColor.ink, wordmarkColor: Color = PerpetoColor.ink) {
        self.height = height
        self.symbolColor = symbolColor
        self.wordmarkColor = wordmarkColor
    }

    public var body: some View {
        HStack(alignment: .center, spacing: height * 0.14) {
            SpindleShape()
                .fill(symbolColor)
                .frame(width: height, height: height)
            WordmarkShape()
                .fill(wordmarkColor)
                .frame(width: height * 0.75 * WordmarkShape.aspectRatio, height: height * 0.75)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("perpeto")
    }
}

enum LogoGeometry {
    static let spindle: NormalizedPath = {
        var path = Path()
        for arm in LogoPathData.spindleArms {
            path.addPath(SVGPathParser.parse(arm))
        }
        // Group transform from the SVG: translate(0 1254) scale(.1 -.1).
        let transformed = path.applying(CGAffineTransform(a: 0.1, b: 0, c: 0, d: -0.1, tx: 0, ty: 1254))
        // Use the SVG's square viewBox so the mark keeps its designed clearspace balance.
        return NormalizedPath(path: transformed, bounds: CGRect(x: 219, y: 186, width: 816, height: 816))
    }()

    static let wordmark: NormalizedPath = {
        let path = SVGPathParser.parse(LogoPathData.wordmark)
            .applying(CGAffineTransform(translationX: -54, y: 672))
        return NormalizedPath(path: path, bounds: path.boundingRect)
    }()
}

struct NormalizedPath: Sendable {
    let path: Path
    let bounds: CGRect

    func fitted(in rect: CGRect) -> Path {
        guard bounds.width > 0, bounds.height > 0 else { return Path() }
        let scale = min(rect.width / bounds.width, rect.height / bounds.height)
        let width = bounds.width * scale
        let height = bounds.height * scale
        let originX = rect.minX + (rect.width - width) / 2
        let originY = rect.minY + (rect.height - height) / 2
        let transform = CGAffineTransform(translationX: -bounds.minX, y: -bounds.minY)
            .concatenating(CGAffineTransform(scaleX: scale, y: scale))
            .concatenating(CGAffineTransform(translationX: originX, y: originY))
        return path.applying(transform)
    }
}

/// Minimal SVG path-data parser covering the commands used by the identity
/// assets (M, L, H, V, C, Q, Z in absolute and relative forms).
enum SVGPathParser {
    static func parse(_ data: String) -> Path {
        var path = Path()
        var tokens = Tokenizer(data)
        var command: Character = "M"
        var current = CGPoint.zero
        var start = CGPoint.zero

        while let next = tokens.peek() {
            if case .command(let c) = next {
                command = c
                tokens.advance()
                if c == "Z" || c == "z" {
                    path.closeSubpath()
                    current = start
                    continue
                }
            }
            let relative = command.isLowercase
            func point() -> CGPoint? {
                guard let x = tokens.number(), let y = tokens.number() else { return nil }
                return relative ? CGPoint(x: current.x + x, y: current.y + y) : CGPoint(x: x, y: y)
            }
            switch command.uppercased() {
            case "M":
                guard let p = point() else { return path }
                path.move(to: p)
                current = p
                start = p
                // Subsequent pairs after a moveto are implicit linetos.
                command = relative ? "l" : "L"
            case "L":
                guard let p = point() else { return path }
                path.addLine(to: p)
                current = p
            case "H":
                guard let x = tokens.number() else { return path }
                current = CGPoint(x: relative ? current.x + x : x, y: current.y)
                path.addLine(to: current)
            case "V":
                guard let y = tokens.number() else { return path }
                current = CGPoint(x: current.x, y: relative ? current.y + y : y)
                path.addLine(to: current)
            case "C":
                guard let c1 = point(), let c2 = point(), let p = point() else { return path }
                path.addCurve(to: p, control1: c1, control2: c2)
                current = p
            case "Q":
                guard let c = point(), let p = point() else { return path }
                path.addQuadCurve(to: p, control: c)
                current = p
            default:
                return path
            }
        }
        return path
    }

    enum Token: Equatable {
        case command(Character)
        case number(CGFloat)
    }

    struct Tokenizer {
        private var tokens: [Token] = []
        private var index = 0

        init(_ source: String) {
            var buffer = ""
            func flush() {
                if !buffer.isEmpty, let value = Double(buffer) { tokens.append(.number(CGFloat(value))) }
                buffer = ""
            }
            for ch in source {
                if ch.isLetter && ch != "e" && ch != "E" {
                    flush()
                    tokens.append(.command(ch))
                } else if ch == "-" && !buffer.isEmpty && buffer.last != "e" && buffer.last != "E" {
                    flush()
                    buffer.append(ch)
                } else if ch == "." && buffer.contains(".") {
                    flush()
                    buffer.append(ch)
                } else if ch == " " || ch == "," || ch == "\n" || ch == "\t" {
                    flush()
                } else {
                    buffer.append(ch)
                }
            }
            flush()
        }

        func peek() -> Token? { index < tokens.count ? tokens[index] : nil }
        mutating func advance() { index += 1 }
        mutating func number() -> CGFloat? {
            guard case .number(let value)? = peek() else { return nil }
            index += 1
            return value
        }
    }
}
