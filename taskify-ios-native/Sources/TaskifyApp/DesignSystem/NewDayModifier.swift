import Combine
import SwiftUI
import UIKit

/// Calls `action(previousToday, today)` when the day changes: at midnight while the app is open,
/// after a clock or time-zone change, and when the app comes back after the day turned (C8-4).
private struct NewDayModifier: ViewModifier {
    @Environment(\.scenePhase) private var scenePhase
    @State private var today = Calendar.current.startOfDay(for: Date())
    let action: (Date, Date) -> Void

    func body(content: Content) -> some View {
        content
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { checkDay() }
            }
            .onReceive(
                NotificationCenter.default.publisher(for: UIApplication.significantTimeChangeNotification)
                    .merge(with: NotificationCenter.default.publisher(for: .NSCalendarDayChanged))
                    .receive(on: RunLoop.main)
            ) { _ in
                checkDay()
            }
    }

    private func checkDay() {
        let now = Calendar.current.startOfDay(for: Date())
        guard now != today else { return }
        let previous = today
        today = now
        action(previous, now)
    }
}

extension View {
    func onNewDay(perform action: @escaping (_ previousToday: Date, _ today: Date) -> Void) -> some View {
        modifier(NewDayModifier(action: action))
    }
}
