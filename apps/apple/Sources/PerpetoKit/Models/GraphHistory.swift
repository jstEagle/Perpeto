import Foundation

/// Undo and redo for the hand editor. Stores whole graphs, which are small,
/// so every edit (move, connect, add, delete, inspector change) undoes the
/// same way. Rapid edits with the same key, such as typing in one field,
/// coalesce into one step.
public struct GraphHistory: Sendable {
    public struct Entry: Sendable {
        public var graph: WorkflowGraph
        public var name: String
    }

    public static let limit = 200
    public static let coalesceInterval: TimeInterval = 1

    public private(set) var undoStack: [Entry] = []
    public private(set) var redoStack: [Entry] = []
    private var lastKey: String?
    private var lastAt: Date?

    public init() {}

    public var canUndo: Bool { !undoStack.isEmpty }
    public var canRedo: Bool { !redoStack.isEmpty }
    public var undoName: String? { undoStack.last?.name }
    public var redoName: String? { redoStack.last?.name }

    /// Records the graph as it was before a change.
    public mutating func record(_ previous: WorkflowGraph, name: String, coalesceKey: String? = nil, at now: Date = Date()) {
        if let coalesceKey, coalesceKey == lastKey, let lastAt, now.timeIntervalSince(lastAt) < Self.coalesceInterval {
            self.lastAt = now
            return
        }
        undoStack.append(Entry(graph: previous, name: name))
        if undoStack.count > Self.limit { undoStack.removeFirst(undoStack.count - Self.limit) }
        redoStack.removeAll()
        lastKey = coalesceKey
        lastAt = now
    }

    /// Returns the graph to show after undoing, given the one on screen.
    public mutating func undo(from current: WorkflowGraph) -> WorkflowGraph? {
        guard let entry = undoStack.popLast() else { return nil }
        redoStack.append(Entry(graph: current, name: entry.name))
        lastKey = nil
        return entry.graph
    }

    public mutating func redo(from current: WorkflowGraph) -> WorkflowGraph? {
        guard let entry = redoStack.popLast() else { return nil }
        undoStack.append(Entry(graph: current, name: entry.name))
        lastKey = nil
        return entry.graph
    }
}
