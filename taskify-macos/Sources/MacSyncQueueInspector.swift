import SwiftUI
import TaskifyCore

/// A routing-only view of the durable sync outbox. Event contents are deliberately absent from
/// `TaskPendingOutboxRecord`; this shows the same safe queue diagnostics as the iPhone app.
struct MacSyncQueueInspector: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var records: [TaskPendingOutboxRecord] = []
    @State private var loaded = false
    @State private var relayCounts: [(name: String, count: Int)] = []
    @State private var scopeCounts: [(name: String, count: Int)] = []

    private var unacceptedCount: Int {
        records.filter { $0.acceptedRelayCount == 0 }.count
    }

    var body: some View {
        NavigationStack {
            List {
                Section("Delivery snapshot") {
                    if !loaded {
                        ProgressView("Reading queue…")
                    } else {
                        LabeledContent("Queued", value: records.count.formatted())
                        LabeledContent("No relay acceptance yet", value: unacceptedCount.formatted())
                        LabeledContent(
                            "Accepted by at least one relay",
                            value: (records.count - unacceptedCount).formatted()
                        )
                        if records.isEmpty {
                            Label("All local changes are synced", systemImage: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                        }
                        Text("Relay acceptance is a delivery receipt, not a verification that a backup can currently be restored. Changes may remain queued while other replicas are unavailable.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Section("Waiting on relays") {
                    if loaded, relayCounts.isEmpty {
                        Text("No relays are waiting on a queued change.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(relayCounts, id: \.name) { item in
                        LabeledContent(item.name, value: item.count.formatted())
                    }
                    if !relayCounts.isEmpty {
                        Text("A change can wait on multiple relays, so these counts can exceed the queue total.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Section("Changes by feature or board") {
                    if loaded, scopeCounts.isEmpty {
                        Text("No queued changes.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(scopeCounts, id: \.name) { item in
                        LabeledContent(item.name, value: item.count.formatted())
                    }
                }

                Section("Queued changes · oldest first") {
                    if loaded, records.isEmpty {
                        Text("The sync queue is empty.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(records) { record in
                        DisclosureGroup {
                            Text("Event kind: \(record.eventKind)")
                            Text("Event: \(record.id)")
                            Text("Record: \(record.recordID)")
                            Text("Scope: \(record.outboxScope)")
                            Text("Accepted by \(record.acceptedRelayCount) relay(s)")
                            if let parent = record.dependsOnEventID {
                                Text("Waiting for parent: \(parent)")
                            }
                            ForEach(record.pendingRelayURLs, id: \.self) { relay in
                                Text("Waiting: \(relay)")
                                if let rejection = record.relayRejections[relay] {
                                    Text("Refusals: \(rejection.count) · Retry after \(rejection.retryAfter.formatted())")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(model.pendingPublishScopeLabel(record.outboxScope))
                                Text(record.queuedAt, format: .dateTime.year().month().day().hour().minute())
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Text(
                                    record.acceptedRelayCount == 0
                                        ? "No relay acceptance yet"
                                        : "Waiting for remaining replicas"
                                )
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            }
                        }
                        .textSelection(.enabled)
                    }
                }
            }
            .navigationTitle("Sync queue")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItemGroup(placement: .primaryAction) {
                    Button {
                        Task { await refresh() }
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                    .disabled(!loaded)

                    ShareLink(item: report) {
                        Label("Share diagnostics", systemImage: "square.and.arrow.up")
                    }
                    .disabled(!loaded)
                }
            }
            // Refresh whenever the durable queue count changes so the sheet drains live.
            .task(id: model.pendingSyncChangeCount) { await refresh() }
        }
        .frame(minWidth: 560, idealWidth: 680, minHeight: 520, idealHeight: 680)
    }

    @MainActor
    private func refresh() async {
        await model.refreshPendingPublishRecords()
        records = model.pendingPublishRecords
        relayCounts = counts(records.flatMap(\.pendingRelayURLs))
        scopeCounts = counts(records.map { model.pendingPublishScopeLabel($0.outboxScope) })
        loaded = true
    }

    private func counts(_ values: [String]) -> [(name: String, count: Int)] {
        Dictionary(values.map { ($0, 1) }, uniquingKeysWith: +)
            .map { (name: $0.key, count: $0.value) }
            .sorted { $0.count == $1.count ? $0.name < $1.name : $0.count > $1.count }
    }

    private var report: String {
        ([
            "Taskify sync queue",
            "Queued: \(records.count)",
            "No acceptance: \(unacceptedCount)",
            "Routing metadata only; includes board names and record identifiers.",
        ] +
        scopeCounts.map { "Feature/board \($0.name): \($0.count)" } +
        relayCounts.map { "Waiting on \($0.name): \($0.count)" } +
        records.flatMap { record -> [String] in
            ["\(record.queuedAt.ISO8601Format()) | scope=\(record.outboxScope) | record=\(record.recordID) | event=\(record.id) | kind=\(record.eventKind) | accepted=\(record.acceptedRelayCount) | waiting=\(record.pendingRelayURLs.joined(separator: ",")) | parent=\(record.dependsOnEventID ?? "none")"] +
            record.relayRejections.keys.sorted().compactMap { relay in
                guard let rejection = record.relayRejections[relay] else { return nil }
                return "  refusal: \(relay) | count=\(rejection.count) | retryAfter=\(rejection.retryAfter.ISO8601Format())"
            }
        }).joined(separator: "\n")
    }
}
