import Foundation

/// Decodes an array, skipping elements that do not decode. Used only for
/// open-ended hub fields such as `project.docs` and `job.artifacts`.
struct Lossy<Element: Decodable>: Decodable {
    var elements: [Element]

    init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        var elements: [Element] = []
        while !container.isAtEnd {
            if let element = try? container.decode(Element.self) {
                elements.append(element)
            } else {
                _ = try container.decode(JSONValue.self)
            }
        }
        self.elements = elements
    }
}
