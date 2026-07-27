import Foundation

public enum HorizontalDragAutoScrollDirection: Equatable, Sendable {
    case backward
    case forward
}

public struct HorizontalDragAutoScrollCommand: Equatable, Sendable {
    public let direction: HorizontalDragAutoScrollDirection
    public let interval: TimeInterval

    public init(
        direction: HorizontalDragAutoScrollDirection,
        interval: TimeInterval
    ) {
        self.direction = direction
        self.interval = interval
    }
}

public struct HorizontalDragAutoScrollPolicy: Equatable, Sendable {
    public let viewportWidth: Double
    public let activationWidth: Double
    public let slowestInterval: TimeInterval
    public let fastestInterval: TimeInterval

    public init(
        viewportWidth: Double,
        activationWidth: Double? = nil,
        slowestInterval: TimeInterval = 0.74,
        fastestInterval: TimeInterval = 0.38
    ) {
        self.viewportWidth = max(0, viewportWidth)
        self.activationWidth = min(
            max(72, activationWidth ?? viewportWidth * 0.22),
            min(96, max(0, viewportWidth / 2))
        )
        self.slowestInterval = max(slowestInterval, fastestInterval)
        self.fastestInterval = max(0.25, min(fastestInterval, slowestInterval))
    }

    public func command(
        forHorizontalLocation location: Double
    ) -> HorizontalDragAutoScrollCommand? {
        guard viewportWidth > 0, activationWidth > 0 else { return nil }

        if location < activationWidth {
            return command(
                direction: .backward,
                distanceFromEdge: max(0, location)
            )
        }

        let rightActivationStart = viewportWidth - activationWidth
        guard location > rightActivationStart else { return nil }
        return command(
            direction: .forward,
            distanceFromEdge: max(0, viewportWidth - location)
        )
    }

    private func command(
        direction: HorizontalDragAutoScrollDirection,
        distanceFromEdge: Double
    ) -> HorizontalDragAutoScrollCommand {
        let proximity = min(1, max(0, 1 - distanceFromEdge / activationWidth))
        let smoothedProximity = proximity * proximity * (3 - 2 * proximity)
        let interval = slowestInterval
            - (slowestInterval - fastestInterval) * smoothedProximity
        return HorizontalDragAutoScrollCommand(
            direction: direction,
            interval: interval
        )
    }
}
