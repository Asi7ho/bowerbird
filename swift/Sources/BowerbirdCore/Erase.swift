import Foundation

/// The eraser, ported from the Electron app's `eraseAt`
/// (`board-input.ts`) and `splitStrokeByEraser` /
/// `strokesWithin` (`model.ts`): the eraser works like the
/// pen — it lifts only the ink it touches. Points inside
/// the eraser circle (radius + half the stroke's width)
/// are gone, and the stroke breaks into the contiguous
/// runs that remain; a segment that crosses the circle
/// with both ends outside it still cuts the run, or a
/// fast sweep through a stroke's middle would leave it
/// whole. A run of one point cannot draw, so it is
/// dropped. Pressures travel with their points, so a
/// split stroke keeps its thick and thin parts. The
/// board is not saved here: the drag saves once, on
/// mouseup, so a whole sweep is one undo step.
public enum BoardErase {
    /// The eraser's radius, in world pixels (the Electron
    /// app's ERASER_RADIUS).
    public static let radius: Double = 12

    /// One surviving run of a split stroke: its points,
    /// and their pressures when the stroke carried any.
    public struct SplitRun {
        public var points: [Pt]
        public var pressures: [Double]?
    }

    /// The width a pressure makes a stroke, in world
    /// pixels (the Electron app's `pressureWidth`: twice
    /// the base width times the pressure, clamped to
    /// 1…8).
    public static func pressureWidth(base: Double, pressure: Double) -> Double {
        min(8, max(1, 2 * base * pressure))
    }

    /// The widest a stroke gets, for hit-testing and the
    /// eraser: its base width, or the widest its
    /// pressures make it (the Electron app's
    /// `strokeMaxWidth`).
    public static func maxWidth(of stroke: StrokePayload) -> Double {
        guard let pressures = stroke.pressures, !pressures.isEmpty else { return stroke.width }
        var max = stroke.width
        for pressure in pressures {
            max = Swift.max(max, pressureWidth(base: stroke.width, pressure: pressure))
        }
        return max
    }

    /// The stroke ids whose path the eraser touches at
    /// this point.
    public static func strokesWithin(board: Board, at world: Pt, radius: Double = BoardErase.radius) -> [Int] {
        var out: [Int] = []
        for item in board.items {
            guard case .stroke(let stroke) = item.kind else { continue }
            let tolerance = radius + maxWidth(of: stroke) / 2
            if distanceToPolyline(stroke.points, world) <= tolerance {
                out.append(item.id)
            }
        }
        return out
    }

    /// Split a stroke where the eraser passes (the
    /// Electron app's `splitStrokeByEraser`): the runs
    /// that survive the eraser circle at `center`, in
    /// order. `halfWidth` is half the stroke's widest
    /// width — the circle's tolerance is radius plus
    /// that, so the eraser overlaps the visible stroke.
    public static func splitStroke(
        points: [Pt],
        pressures: [Double]?,
        center: Pt,
        radius: Double = BoardErase.radius,
        halfWidth: Double
    ) -> [SplitRun] {
        let tolerance = radius + halfWidth
        var runs: [SplitRun] = []
        var current: [Pt] = []
        var currentPressures: [Double] = []
        let hasPressures = pressures != nil && pressures?.count == points.count
        func flush() {
            guard current.count >= 2 else {
                current = []
                currentPressures = []
                return
            }
            runs.append(SplitRun(
                points: current,
                pressures: hasPressures ? currentPressures : nil
            ))
            current = []
            currentPressures = []
        }
        for i in 0..<points.count {
            let point = points[i]
            if hypot(point.x - center.x, point.y - center.y) <= tolerance {
                flush()
                continue
            }
            // The segment from the previous point crosses
            // the eraser circle: the run breaks here even
            // though both ends survive.
            if !current.isEmpty, distanceToSegment(center, points[i - 1], point) <= tolerance {
                flush()
            }
            current.append(point)
            if hasPressures { currentPressures.append(pressures![i]) }
        }
        flush()
        return runs
    }

    /// Erases the ink the eraser touches at this point:
    /// every touched stroke is removed and replaced by
    /// its surviving runs, as new items (the Electron
    /// app's `eraseAt`: the pieces are added silent, like
    /// the removed stroke was). Returns true when at
    /// least one stroke changed.
    @discardableResult
    public static func erase(_ board: inout Board, at world: Pt, radius: Double = BoardErase.radius) -> Bool {
        let ids = strokesWithin(board: board, at: world, radius: radius)
        guard !ids.isEmpty else { return false }
        var changed = false
        for id in ids {
            guard let index = board.items.firstIndex(where: { $0.id == id }),
                  case .stroke(let stroke) = board.items[index].kind else { continue }
            let runs = splitStroke(
                points: stroke.points,
                pressures: stroke.pressures,
                center: world,
                radius: radius,
                halfWidth: maxWidth(of: stroke) / 2
            )
            board.items.remove(at: index)
            for run in runs {
                let xs = run.points.map(\.x), ys = run.points.map(\.y)
                let pos = Pt(x: xs.min() ?? 0, y: ys.min() ?? 0)
                let size = Size(
                    w: max(1, (xs.max() ?? 0) - pos.x),
                    h: max(1, (ys.max() ?? 0) - pos.y)
                )
                // next_id is the last allocated id — a
                // fresh id comes from allocId (see
                // BoardStroke.add).
                let newId = allocId(&board)
                let piece = StrokePayload(
                    points: run.points,
                    color: stroke.color,
                    width: stroke.width,
                    marker: stroke.marker,
                    pressures: run.pressures?.isEmpty == false ? run.pressures : nil,
                    pencil: stroke.pencil
                )
                board.items.append(Item(id: newId, pos: pos, size: size, group: nil, kind: .stroke(piece), rotation: nil))
            }
            changed = true
        }
        return changed
    }

    private static func distanceToPolyline(_ points: [Pt], _ p: Pt) -> Double {
        guard points.count >= 2 else {
            return points.first.map { hypot(p.x - $0.x, p.y - $0.y) } ?? .infinity
        }
        var best = Double.infinity
        for i in 0..<(points.count - 1) {
            best = min(best, distanceToSegment(p, points[i], points[i + 1]))
        }
        return best
    }

    private static func distanceToSegment(_ p: Pt, _ a: Pt, _ b: Pt) -> Double {
        let dx = b.x - a.x, dy = b.y - a.y
        let len2 = dx * dx + dy * dy
        var t: Double = 0
        if len2 > 0 {
            t = max(0, min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
        }
        return hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
    }
}
