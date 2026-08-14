import Foundation

/// A compact, platform-neutral RGB value used to persist colors extracted from a custom
/// background. Keeping the extraction math in TaskifyCore makes the PWA-parity behavior
/// deterministic and independently testable without UIKit.
public struct TaskifyRGBColor: Codable, Hashable, Sendable, Identifiable {
    public let red: UInt8
    public let green: UInt8
    public let blue: UInt8

    public init(red: UInt8, green: UInt8, blue: UInt8) {
        self.red = red
        self.green = green
        self.blue = blue
    }

    public var id: String { hex }

    public var hex: String {
        String(format: "#%02X%02X%02X", red, green, blue)
    }

    public var relativeLuminance: Double {
        func linearize(_ channel: UInt8) -> Double {
            let value = Double(channel) / 255
            return value <= 0.03928
                ? value / 12.92
                : pow((value + 0.055) / 1.055, 2.4)
        }

        return 0.2126 * linearize(red)
            + 0.7152 * linearize(green)
            + 0.0722 * linearize(blue)
    }

    /// Mirrors the PWA's `--accent-on` threshold so controls remain legible over a
    /// photo-derived accent fill.
    public var prefersDarkForeground: Bool {
        relativeLuminance > 0.62
    }
}

/// Extracts the most useful accent colors from a small raster sample. This is a Swift port of
/// the PWA palette implementation: weighted Lab-space clustering favors saturated, mid-tone
/// colors, then normalizes each result into a color that remains usable for controls and text.
public enum TaskifyBackgroundPaletteExtractor {
    private static let maximumSampleCount = 2_200
    private static let targetClusterCount = 6
    private static let minimumClusterDistance = 14.0

    public static func suggestedAccents(
        from pixels: [TaskifyRGBColor],
        count requestedCount: Int = 3
    ) -> [TaskifyRGBColor] {
        guard requestedCount > 0 else { return [] }

        let sampledPixels = evenlySample(pixels, limit: maximumSampleCount)
        let samples = sampledPixels.map(makeSample)
        guard !samples.isEmpty else {
            return [makeUsableAccent(red: 52, green: 199, blue: 89)]
        }

        let clusterCount = min(
            targetClusterCount,
            max(3, samples.count / 80)
        )
        let clusters = cluster(samples, count: clusterCount)
            .sorted { $0.weight > $1.weight }
        let selected = selectAccents(clusters, count: requestedCount)

        return selected.map {
            makeUsableAccent(red: $0.red, green: $0.green, blue: $0.blue)
        }
    }
}

private extension TaskifyBackgroundPaletteExtractor {
    struct HSL {
        var hue: Double
        var saturation: Double
        var lightness: Double
    }

    struct Lab {
        var lightness: Double
        var a: Double
        var b: Double
    }

    struct Sample {
        var red: Double
        var green: Double
        var blue: Double
        var lab: Lab
        var saturation: Double
        var lightness: Double
        var weight: Double
    }

    struct Cluster {
        var red: Double
        var green: Double
        var blue: Double
        var lab: Lab
        var saturation: Double
        var lightness: Double
        var weight: Double

        static let zero = Cluster(
            red: 0,
            green: 0,
            blue: 0,
            lab: Lab(lightness: 0, a: 0, b: 0),
            saturation: 0,
            lightness: 0,
            weight: 0
        )
    }

    static func evenlySample(
        _ pixels: [TaskifyRGBColor],
        limit: Int
    ) -> [TaskifyRGBColor] {
        guard pixels.count > limit, limit > 0 else { return pixels }
        let stride = Double(pixels.count) / Double(limit)
        return (0..<limit).map { pixels[min(pixels.count - 1, Int(Double($0) * stride))] }
    }

    static func makeSample(_ color: TaskifyRGBColor) -> Sample {
        let red = Double(color.red)
        let green = Double(color.green)
        let blue = Double(color.blue)
        let hsl = rgbToHSL(red: red, green: green, blue: blue)
        let saturationWeight = pow(hsl.saturation, 1.2)
        let balanceWeight = 1 - abs(hsl.lightness - 0.45)

        return Sample(
            red: red,
            green: green,
            blue: blue,
            lab: rgbToLab(red: red, green: green, blue: blue),
            saturation: hsl.saturation,
            lightness: hsl.lightness,
            weight: 0.12 + saturationWeight * 0.6 + balanceWeight * 0.28
        )
    }

    static func cluster(_ samples: [Sample], count: Int) -> [Cluster] {
        guard samples.count > count else {
            return samples.map {
                Cluster(
                    red: $0.red,
                    green: $0.green,
                    blue: $0.blue,
                    lab: $0.lab,
                    saturation: $0.saturation,
                    lightness: $0.lightness,
                    weight: $0.weight
                )
            }
        }

        var centroids = initializeCentroids(samples, count: count)
        var assignments = Array(repeating: 0, count: samples.count)

        for _ in 0..<7 {
            var totals = Array(repeating: Cluster.zero, count: count)

            for (sampleIndex, sample) in samples.enumerated() {
                var bestIndex = 0
                var bestDistance = Double.infinity
                for (centroidIndex, centroid) in centroids.enumerated() {
                    let distance = labDistanceSquared(sample.lab, centroid)
                    if distance < bestDistance {
                        bestDistance = distance
                        bestIndex = centroidIndex
                    }
                }

                assignments[sampleIndex] = bestIndex
                totals[bestIndex].weight += sample.weight
                totals[bestIndex].red += sample.red * sample.weight
                totals[bestIndex].green += sample.green * sample.weight
                totals[bestIndex].blue += sample.blue * sample.weight
                totals[bestIndex].lab.lightness += sample.lab.lightness * sample.weight
                totals[bestIndex].lab.a += sample.lab.a * sample.weight
                totals[bestIndex].lab.b += sample.lab.b * sample.weight
                totals[bestIndex].saturation += sample.saturation * sample.weight
                totals[bestIndex].lightness += sample.lightness * sample.weight
            }

            for index in centroids.indices {
                let total = totals[index]
                if total.weight == 0 {
                    centroids[index] = samples[index % samples.count].lab
                } else {
                    centroids[index] = Lab(
                        lightness: total.lab.lightness / total.weight,
                        a: total.lab.a / total.weight,
                        b: total.lab.b / total.weight
                    )
                }
            }
        }

        var clusters = Array(repeating: Cluster.zero, count: count)
        for (index, sample) in samples.enumerated() {
            let clusterIndex = assignments[index]
            clusters[clusterIndex].weight += sample.weight
            clusters[clusterIndex].red += sample.red * sample.weight
            clusters[clusterIndex].green += sample.green * sample.weight
            clusters[clusterIndex].blue += sample.blue * sample.weight
            clusters[clusterIndex].lab.lightness += sample.lab.lightness * sample.weight
            clusters[clusterIndex].lab.a += sample.lab.a * sample.weight
            clusters[clusterIndex].lab.b += sample.lab.b * sample.weight
            clusters[clusterIndex].saturation += sample.saturation * sample.weight
            clusters[clusterIndex].lightness += sample.lightness * sample.weight
        }

        return clusters.compactMap { cluster in
            guard cluster.weight > 0 else { return nil }
            return Cluster(
                red: cluster.red / cluster.weight,
                green: cluster.green / cluster.weight,
                blue: cluster.blue / cluster.weight,
                lab: Lab(
                    lightness: cluster.lab.lightness / cluster.weight,
                    a: cluster.lab.a / cluster.weight,
                    b: cluster.lab.b / cluster.weight
                ),
                saturation: cluster.saturation / cluster.weight,
                lightness: cluster.lightness / cluster.weight,
                weight: cluster.weight
            )
        }
    }

    static func initializeCentroids(_ samples: [Sample], count: Int) -> [Lab] {
        let sorted = samples.sorted { $0.weight > $1.weight }
        guard let first = sorted.first else { return [] }
        var centroids = [first.lab]

        while centroids.count < count, centroids.count < sorted.count {
            var bestSample: Sample?
            var bestScore = -Double.infinity

            for sample in sorted {
                let minimumDistance = centroids
                    .map { sqrt(labDistanceSquared(sample.lab, $0)) }
                    .min() ?? .infinity
                let score = minimumDistance
                    * sample.weight
                    * (0.6 + sample.saturation)
                    * (0.6 + (1 - abs(sample.lightness - 0.5)))
                if score > bestScore {
                    bestScore = score
                    bestSample = sample
                }
            }

            guard let bestSample else { break }
            centroids.append(bestSample.lab)
        }

        while centroids.count < count {
            centroids.append(samples[centroids.count % samples.count].lab)
        }
        return centroids
    }

    static func selectAccents(_ clusters: [Cluster], count: Int) -> [Cluster] {
        guard !clusters.isEmpty else { return [] }
        let scored = clusters.map { cluster in
            let vibrancy = 0.5 + cluster.saturation
            let balance = 0.6 + (1 - abs(cluster.lightness - 0.5))
            return (cluster: cluster, score: cluster.weight * vibrancy * balance)
        }.sorted { $0.score > $1.score }

        var selected: [Cluster] = []
        let minimumDistanceSquared = minimumClusterDistance * minimumClusterDistance
        for candidate in scored.map(\.cluster) where selected.count < count {
            if selected.allSatisfy({ labDistanceSquared(candidate.lab, $0.lab) > minimumDistanceSquared }) {
                selected.append(candidate)
            }
        }

        if selected.count < count {
            let relaxedDistanceSquared = pow(minimumClusterDistance / 2, 2)
            for candidate in scored.map(\.cluster) where selected.count < count {
                if !selected.contains(where: { labDistanceSquared(candidate.lab, $0.lab) < relaxedDistanceSquared }) {
                    selected.append(candidate)
                }
            }
        }

        while selected.count < count {
            selected.append(scored[selected.count % scored.count].cluster)
        }
        return Array(selected.prefix(count))
    }

    static func makeUsableAccent(red: Double, green: Double, blue: Double) -> TaskifyRGBColor {
        let base = rgbToHSL(red: red, green: green, blue: blue)
        let targetSaturation = clamp01(max(base.saturation, 0.4) * 1.15 + 0.08)
        let targetLightness: Double
        if base.lightness < 0.28 {
            targetLightness = 0.6
        } else if base.lightness > 0.78 {
            targetLightness = 0.48
        } else {
            targetLightness = clamp01(base.lightness * 0.62 + 0.2)
        }

        let rgb = hslToRGB(HSL(
            hue: base.hue,
            saturation: targetSaturation,
            lightness: targetLightness
        ))
        return TaskifyRGBColor(
            red: clampChannel(rgb.red),
            green: clampChannel(rgb.green),
            blue: clampChannel(rgb.blue)
        )
    }

    static func rgbToHSL(red: Double, green: Double, blue: Double) -> HSL {
        let red = red / 255
        let green = green / 255
        let blue = blue / 255
        let maximum = max(red, green, blue)
        let minimum = min(red, green, blue)
        let lightness = (maximum + minimum) / 2
        guard maximum != minimum else {
            return HSL(hue: 0, saturation: 0, lightness: lightness)
        }

        let difference = maximum - minimum
        let saturation = lightness > 0.5
            ? difference / (2 - maximum - minimum)
            : difference / (maximum + minimum)
        let hue: Double
        if maximum == red {
            hue = ((green - blue) / difference + (green < blue ? 6 : 0)) / 6
        } else if maximum == green {
            hue = ((blue - red) / difference + 2) / 6
        } else {
            hue = ((red - green) / difference + 4) / 6
        }
        return HSL(hue: hue, saturation: saturation, lightness: lightness)
    }

    static func hslToRGB(_ hsl: HSL) -> (red: Double, green: Double, blue: Double) {
        guard hsl.saturation != 0 else {
            let channel = hsl.lightness * 255
            return (channel, channel, channel)
        }

        let q = hsl.lightness < 0.5
            ? hsl.lightness * (1 + hsl.saturation)
            : hsl.lightness + hsl.saturation - hsl.lightness * hsl.saturation
        let p = 2 * hsl.lightness - q
        return (
            hueToRGB(p: p, q: q, t: hsl.hue + 1 / 3) * 255,
            hueToRGB(p: p, q: q, t: hsl.hue) * 255,
            hueToRGB(p: p, q: q, t: hsl.hue - 1 / 3) * 255
        )
    }

    static func hueToRGB(p: Double, q: Double, t original: Double) -> Double {
        var t = original
        if t < 0 { t += 1 }
        if t > 1 { t -= 1 }
        if t < 1 / 6 { return p + (q - p) * 6 * t }
        if t < 1 / 2 { return q }
        if t < 2 / 3 { return p + (q - p) * (2 / 3 - t) * 6 }
        return p
    }

    static func rgbToLab(red: Double, green: Double, blue: Double) -> Lab {
        func linearize(_ channel: Double) -> Double {
            let value = channel / 255
            return value <= 0.04045
                ? value / 12.92
                : pow((value + 0.055) / 1.055, 2.4)
        }

        let red = linearize(red)
        let green = linearize(green)
        let blue = linearize(blue)
        let x = red * 0.4124 + green * 0.3576 + blue * 0.1805
        let y = red * 0.2126 + green * 0.7152 + blue * 0.0722
        let z = red * 0.0193 + green * 0.1192 + blue * 0.9505
        return xyzToLab(x: x, y: y, z: z)
    }

    static func xyzToLab(x: Double, y: Double, z: Double) -> Lab {
        let fx = labTransform(x / 0.95047)
        let fy = labTransform(y)
        let fz = labTransform(z / 1.08883)
        return Lab(
            lightness: 116 * fy - 16,
            a: 500 * (fx - fy),
            b: 200 * (fy - fz)
        )
    }

    static func labTransform(_ value: Double) -> Double {
        let delta = 6.0 / 29.0
        return value > pow(delta, 3)
            ? pow(value, 1.0 / 3.0)
            : value / (3 * delta * delta) + 4.0 / 29.0
    }

    static func labDistanceSquared(_ lhs: Lab, _ rhs: Lab) -> Double {
        let lightness = lhs.lightness - rhs.lightness
        let a = lhs.a - rhs.a
        let b = lhs.b - rhs.b
        return lightness * lightness + a * a + b * b
    }

    static func clampChannel(_ value: Double) -> UInt8 {
        UInt8(min(255, max(0, Int(value.rounded()))))
    }

    static func clamp01(_ value: Double) -> Double {
        min(1, max(0, value))
    }
}
