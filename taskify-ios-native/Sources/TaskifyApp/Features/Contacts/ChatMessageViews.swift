import CryptoKit
import ImageIO
import PhotosUI
import QuickLook
import SwiftUI
import TaskifyCore
import TaskifyWallet
import TaskifyWatchShared
import UIKit
import UniformTypeIdentifiers
import VisionKit

struct ChatDayDivider: View {
    let timestamp: Int

    private var label: String {
        let date = Date(timeIntervalSince1970: TimeInterval(timestamp))
        if Calendar.current.isDateInToday(date) { return "Today" }
        if Calendar.current.isDateInYesterday(date) { return "Yesterday" }
        return date.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())
    }

    var body: some View {
        Text(label)
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(TaskifyTheme.secondaryText)
            .opacity(0.72)
            .frame(maxWidth: .infinity)
            .padding(.top, 10)
            .padding(.bottom, 5)
            .accessibilityLabel("Messages from \(label)")
    }
}
struct SharedTaskChatCard: View {
    @Environment(AppModel.self) private var model
    let item: SharedInboxItem
    let isSearchMatch: Bool
    let isSelectedSearchResult: Bool
    @State private var showDestination = false
    @State private var addingCopy = false

    private var detailCount: Int {
        (item.task.subtasks?.count ?? 0) + (item.task.documents?.count ?? 0)
    }

    private var completedSubtaskCount: Int {
        item.task.subtasks?.filter(\.completed).count ?? 0
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            Image(systemName: item.task.isAssignment ? "person.crop.circle.badge.checkmark" : "checklist")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(TaskifyTheme.accent)
                .frame(width: 30, height: 30)
                .background(TaskifyTheme.accent.opacity(0.16), in: Circle())
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 11) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Label(
                        item.task.isAssignment ? "ASSIGNMENT" : "SHARED TASK",
                        systemImage: "lock.fill"
                    )
                    .font(.system(size: 10, weight: .bold))
                    .tracking(0.7)
                    .foregroundStyle(TaskifyTheme.accent)

                    Spacer()

                    Text(item.receivedAt, style: .time)
                        .font(.caption2)
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                }

                VStack(alignment: .leading, spacing: 5) {
                    Text(item.task.title)
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    if let note = item.task.note?.trimmingCharacters(in: .whitespacesAndNewlines),
                       !note.isEmpty {
                        Text(TaskNoteMarkdown.previewText(note))
                            .font(.subheadline)
                            .foregroundStyle(TaskifyTheme.secondaryText)
                            .lineLimit(4)
                    }
                }

                if item.task.dueDate != nil || item.task.priority != nil || detailCount > 0 {
                    ViewThatFits(in: .horizontal) {
                        metadata
                        metadata.fixedSize(horizontal: true, vertical: false)
                    }
                }

                if item.status == .pending {
                    pendingActions
                } else {
                    Label(statusLabel, systemImage: statusSymbol)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(statusColor)
                        .padding(.horizontal, 10)
                        .frame(height: 30)
                        .background(statusColor.opacity(0.13), in: Capsule())
                }
            }
            .padding(14)
            .frame(maxWidth: 340, alignment: .leading)
            .taskifyGlass(cornerRadius: 20)
            .overlay(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(
                        isSelectedSearchResult
                            ? TaskifyTheme.accent
                            : (isSearchMatch ? TaskifyTheme.accent.opacity(0.48) : Color.clear),
                        lineWidth: isSelectedSearchResult ? 2 : 1
                    )
            )

            Spacer(minLength: 28)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contextMenu {
            Button("Add Again", systemImage: "plus.square.on.square") {
                addingCopy = true
                showDestination = true
            }
        }
        .sheet(isPresented: $showDestination) {
            SharedTaskDestinationSheet(item: item, asCopy: addingCopy)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(
            "\(item.task.isAssignment ? "Assignment" : "Shared task"), \(item.task.title), from \(item.sender.displayName)"
        )
    }

    private var metadata: some View {
        HStack(spacing: 12) {
            if let dueDate = item.task.dueDate {
                Label(
                    dueDate.formatted(
                        date: .abbreviated,
                        time: item.task.dueTimeEnabled == true ? .shortened : .omitted
                    ),
                    systemImage: "calendar"
                )
            }
            if let priority = item.task.priority {
                Label(priorityLabel(priority), systemImage: "exclamationmark")
                    .foregroundStyle(priorityColor(priority))
            }
            if let subtasks = item.task.subtasks, !subtasks.isEmpty {
                Label("\(completedSubtaskCount)/\(subtasks.count)", systemImage: "checklist")
            }
            if let documents = item.task.documents, !documents.isEmpty {
                Label("\(documents.count)", systemImage: "paperclip")
            }
        }
        .font(.caption2.weight(.semibold))
        .foregroundStyle(TaskifyTheme.tertiaryText)
    }

    @ViewBuilder
    private var pendingActions: some View {
        if item.task.isAssignment {
            HStack(spacing: 7) {
                responseButton("Decline", status: .declined, tint: .red)
                responseButton("Maybe", status: .tentative, tint: .orange)
                responseButton("Accept", status: .accepted, tint: TaskifyTheme.accent)
            }
        } else {
            HStack(spacing: 8) {
                Button {
                    withAnimation(.snappy) { model.dismissSharedInboxItem(item.id) }
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                } label: {
                    Text("Dismiss")
                        .frame(maxWidth: .infinity)
                        .frame(height: 36)
                }
                .buttonStyle(.bordered)

                responseButton("Add Task", status: .accepted, tint: TaskifyTheme.accent)
            }
        }
    }

    private func responseButton(
        _ title: String,
        status: SharedInboxItemStatus,
        tint: Color
    ) -> some View {
        Button {
            if status == .accepted {
                addingCopy = false
                showDestination = true
                return
            }
            let succeeded: Bool = withAnimation(.snappy) {
                model.respondToSharedInboxItem(item.id, status: status)
            }
            UINotificationFeedbackGenerator().notificationOccurred(succeeded ? .success : .error)
        } label: {
            Text(title)
                .font(.caption.weight(.semibold))
                .frame(maxWidth: .infinity)
                .frame(height: 36)
        }
        .buttonStyle(.borderedProminent)
        .tint(tint)
    }

    private var statusLabel: String {
        switch item.status {
        case .pending: "Awaiting response"
        case .accepted: "Added to your tasks"
        case .declined: "Declined"
        case .tentative: "Maybe"
        case .deleted: "Removed"
        }
    }

    private var statusSymbol: String {
        switch item.status {
        case .pending: "clock"
        case .accepted: "checkmark.circle.fill"
        case .declined: "xmark.circle.fill"
        case .tentative: "questionmark.circle.fill"
        case .deleted: "trash"
        }
    }

    private var statusColor: Color {
        switch item.status {
        case .pending: TaskifyTheme.secondaryText
        case .accepted: .green
        case .declined: .red
        case .tentative: .orange
        case .deleted: TaskifyTheme.tertiaryText
        }
    }

    private func priorityLabel(_ rawValue: Int) -> String {
        switch rawValue {
        case 3: "High"
        case 2: "Medium"
        default: "Low"
        }
    }

    private func priorityColor(_ rawValue: Int) -> Color {
        switch rawValue {
        case 3: .red
        case 2: .orange
        default: .blue
        }
    }
}

struct SharedContactChatCard: View {
    @Environment(AppModel.self) private var model
    @State private var isSaving = false
    let item: SharedContactInboxItem
    let showsSentStatus: Bool
    let isSearchMatch: Bool
    let isSelectedSearchResult: Bool

    private var isInContacts: Bool {
        guard let publicKey = item.contact.publicKey else { return false }
        return model.nostrContact(publicKey: publicKey) != nil
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            if !item.isIncoming {
                Spacer(minLength: 28)
            }

            if item.isIncoming {
                sharedContactAvatar
            }

            VStack(alignment: .leading, spacing: 11) {
                HStack {
                    Label("SHARED CONTACT", systemImage: "lock.fill")
                        .font(.system(size: 10, weight: .bold))
                        .tracking(0.7)
                        .foregroundStyle(TaskifyTheme.accent)
                    Spacer()
                    Text(item.receivedAt, style: .time)
                        .font(.caption2)
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                }

                HStack(spacing: 11) {
                    contactPhoto
                    VStack(alignment: .leading, spacing: 3) {
                        Text(item.contact.primaryName)
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundStyle(TaskifyTheme.primaryText)
                            .lineLimit(2)
                        if let nip05 = item.contact.nip05 {
                            Text(nip05)
                                .font(.caption)
                                .foregroundStyle(TaskifyTheme.secondaryText)
                                .lineLimit(1)
                        } else {
                            Text(item.contact.shortNpub)
                                .font(.caption.monospaced())
                                .foregroundStyle(TaskifyTheme.secondaryText)
                                .lineLimit(1)
                        }
                    }
                }

                if let lud16 = item.contact.lud16 {
                    Label(lud16, systemImage: "bolt.fill")
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                        .lineLimit(1)
                }

                if item.isIncoming {
                    if item.status == .pending {
                        HStack(spacing: 8) {
                            Button {
                                withAnimation(.snappy) {
                                    model.dismissSharedContactInboxItem(item.id)
                                }
                                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                            } label: {
                                Text("Dismiss")
                                    .frame(maxWidth: .infinity)
                                    .frame(height: 36)
                            }
                            .buttonStyle(.bordered)

                            Button { saveContact() } label: {
                                Group {
                                    if isSaving {
                                        ProgressView().controlSize(.small)
                                    } else {
                                        Text(isInContacts ? "Confirm" : "Add Contact")
                                    }
                                }
                                .frame(maxWidth: .infinity)
                                .frame(height: 36)
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(isSaving)
                        }
                    } else {
                        Label(
                            item.status == .accepted ? "In Contacts" : "Dismissed",
                            systemImage: item.status == .accepted ? "person.crop.circle.badge.checkmark" : "xmark.circle"
                        )
                        .font(.caption.weight(.bold))
                        .foregroundStyle(item.status == .accepted ? Color.green : TaskifyTheme.secondaryText)
                    }
                } else if showsSentStatus {
                    Label("Sent", systemImage: "checkmark")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TaskifyTheme.secondaryText)
                }
            }
            .padding(14)
            .frame(maxWidth: 340, alignment: .leading)
            .taskifyGlass(cornerRadius: 20)
            .overlay(searchBorder)

            if item.isIncoming {
                Spacer(minLength: 28)
            }
        }
        .frame(maxWidth: .infinity, alignment: item.isIncoming ? .leading : .trailing)
    }

    private var sharedContactAvatar: some View {
        Image(systemName: "person.crop.circle.badge.plus")
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(TaskifyTheme.accent)
            .frame(width: 30, height: 30)
            .background(TaskifyTheme.accent.opacity(0.16), in: Circle())
    }

    @ViewBuilder
    private var contactPhoto: some View {
        if let picture = item.contact.picture, let URL = URL(string: picture) {
            AsyncImage(url: URL) { phase in
                if let image = phase.image {
                    image.resizable().scaledToFill()
                } else {
                    contactPhotoFallback
                }
            }
            .frame(width: 52, height: 52)
            .clipShape(Circle())
        } else {
            contactPhotoFallback
        }
    }

    private var contactPhotoFallback: some View {
        Circle()
            .fill(TaskifyTheme.accent.opacity(0.18))
            .overlay(
                Text(String(item.contact.primaryName.prefix(1)).uppercased())
                    .font(.headline)
                    .foregroundStyle(TaskifyTheme.accent)
            )
            .frame(width: 52, height: 52)
    }

    private var searchBorder: some View {
        RoundedRectangle(cornerRadius: 20, style: .continuous)
            .stroke(
                isSelectedSearchResult
                    ? TaskifyTheme.accent
                    : (isSearchMatch ? TaskifyTheme.accent.opacity(0.48) : Color.clear),
                lineWidth: isSelectedSearchResult ? 2 : 1
            )
    }

    private func saveContact() {
        guard !isSaving else { return }
        isSaving = true
        Task {
            do {
                try await model.acceptSharedContactInboxItem(item.id)
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            } catch {
                model.errorMessage = error.localizedDescription
                UINotificationFeedbackGenerator().notificationOccurred(.error)
            }
            isSaving = false
        }
    }
}

struct SharedBoardChatCard: View {
    @Environment(AppModel.self) private var model
    let item: SharedBoardInboxItem
    let isSearchMatch: Bool
    let isSelectedSearchResult: Bool

    private var boardName: String {
        let trimmed = item.board.boardName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "Shared board" : trimmed
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            sharedBoardAvatar

            VStack(alignment: .leading, spacing: 11) {
                HStack {
                    Label("SHARED BOARD", systemImage: "lock.fill")
                        .font(.system(size: 10, weight: .bold))
                        .tracking(0.7)
                        .foregroundStyle(TaskifyTheme.accent)
                    Spacer()
                    Text(item.receivedAt, style: .time)
                        .font(.caption2)
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                }

                VStack(alignment: .leading, spacing: 3) {
                    Text(boardName)
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .lineLimit(2)
                    Text("Add this board to your workspace")
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                }

                if item.status == .pending {
                    HStack(spacing: 8) {
                        Button {
                            withAnimation(.snappy) {
                                model.dismissSharedBoardInboxItem(item.id)
                            }
                            UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        } label: {
                            Text("Dismiss")
                                .frame(maxWidth: .infinity)
                                .frame(height: 36)
                        }
                        .buttonStyle(.bordered)

                        Button { joinBoard() } label: {
                            Text("Add Board")
                                .frame(maxWidth: .infinity)
                                .frame(height: 36)
                        }
                        .buttonStyle(.borderedProminent)
                    }
                } else {
                    Label(
                        item.status == .accepted ? "Added" : "Dismissed",
                        systemImage: item.status == .accepted ? "checkmark.circle.fill" : "xmark.circle"
                    )
                    .font(.caption.weight(.bold))
                    .foregroundStyle(item.status == .accepted ? Color.green : TaskifyTheme.secondaryText)
                }
            }
            .padding(14)
            .frame(maxWidth: 340, alignment: .leading)
            .taskifyGlass(cornerRadius: 20)
            .overlay(searchBorder)

            Spacer(minLength: 28)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var sharedBoardAvatar: some View {
        Image(systemName: "square.grid.2x2")
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(TaskifyTheme.accent)
            .frame(width: 30, height: 30)
            .background(TaskifyTheme.accent.opacity(0.16), in: Circle())
    }

    private var searchBorder: some View {
        RoundedRectangle(cornerRadius: 20, style: .continuous)
            .stroke(
                isSelectedSearchResult
                    ? TaskifyTheme.accent
                    : (isSearchMatch ? TaskifyTheme.accent.opacity(0.48) : Color.clear),
                lineWidth: isSelectedSearchResult ? 2 : 1
            )
    }

    private func joinBoard() {
        withAnimation(.snappy) {
            _ = model.acceptSharedBoardInboxItem(item.id)
        }
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }
}

struct SharedCalendarInviteChatCard: View {
    @Environment(AppModel.self) private var model
    @State private var isResponding = false
    @State private var responseError: String?
    let item: SharedCalendarInviteInboxItem
    let isSearchMatch: Bool
    let isSelectedSearchResult: Bool

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            Image(systemName: "calendar.badge.plus")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(.orange)
                .frame(width: 30, height: 30)
                .background(Color.orange.opacity(0.16), in: Circle())

            VStack(alignment: .leading, spacing: 11) {
                HStack {
                    Label("EVENT INVITE", systemImage: "lock.fill")
                        .font(.system(size: 10, weight: .bold))
                        .tracking(0.7)
                        .foregroundStyle(.orange)
                    Spacer()
                    Text(item.receivedAt, style: .time)
                        .font(.caption2)
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                }

                Text(item.event.displayTitle)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(TaskifyTheme.primaryText)
                    .frame(maxWidth: .infinity, alignment: .leading)

                Label(whenLabel, systemImage: "calendar")
                    .font(.subheadline)
                    .foregroundStyle(TaskifyTheme.secondaryText)

                if item.status == .pending {
                    HStack(spacing: 7) {
                        responseButton("Decline", status: .declined, tint: .red)
                        responseButton("Maybe", status: .tentative, tint: .orange)
                        responseButton("Accept", status: .accepted, tint: TaskifyTheme.accent)
                    }
                } else {
                    Label(statusLabel, systemImage: statusSymbol)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(statusColor)
                        .padding(.horizontal, 10)
                        .frame(height: 30)
                        .background(statusColor.opacity(0.13), in: Capsule())
                }

                if let responseError {
                    Text(responseError)
                        .font(.caption2)
                        .foregroundStyle(.red)
                }
            }
            .padding(14)
            .frame(maxWidth: 340, alignment: .leading)
            .taskifyGlass(cornerRadius: 20)
            .overlay(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(
                        isSelectedSearchResult
                            ? TaskifyTheme.accent
                            : (isSearchMatch ? TaskifyTheme.accent.opacity(0.48) : Color.clear),
                        lineWidth: isSelectedSearchResult ? 2 : 1
                    )
            )

            Spacer(minLength: 28)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var whenLabel: String {
        guard let start = item.event.startDate else {
            return item.event.start ?? "Date to be announced"
        }
        if item.event.isAllDay {
            guard let end = item.event.endDate, !Calendar.current.isDate(start, inSameDayAs: end) else {
                return start.formatted(date: .long, time: .omitted)
            }
            return "\(start.formatted(date: .abbreviated, time: .omitted)) – \(end.formatted(date: .abbreviated, time: .omitted))"
        }
        guard let end = item.event.endDate else {
            return start.formatted(date: .abbreviated, time: .shortened)
        }
        if Calendar.current.isDate(start, inSameDayAs: end) {
            return "\(start.formatted(date: .abbreviated, time: .shortened)) – \(end.formatted(date: .omitted, time: .shortened))"
        }
        return "\(start.formatted(date: .abbreviated, time: .shortened)) – \(end.formatted(date: .abbreviated, time: .shortened))"
    }

    private func responseButton(
        _ title: String,
        status: SharedInboxItemStatus,
        tint: Color
    ) -> some View {
        Button {
            respond(status: status)
        } label: {
            Group {
                if isResponding {
                    ProgressView().controlSize(.mini)
                } else {
                    Text(title)
                }
            }
            .font(.caption.weight(.semibold))
            .frame(maxWidth: .infinity)
            .frame(height: 36)
        }
        .buttonStyle(.borderedProminent)
        .tint(tint)
        .disabled(isResponding)
    }

    private func respond(status: SharedInboxItemStatus) {
        guard !isResponding else { return }
        isResponding = true
        responseError = nil
        Task {
            do {
                try await model.respondToSharedCalendarInvite(item.id, status: status)
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            } catch {
                responseError = error.localizedDescription
                UINotificationFeedbackGenerator().notificationOccurred(.error)
            }
            isResponding = false
        }
    }

    private var statusLabel: String {
        switch item.status {
        case .accepted: "Accepted · Added to Taskify"
        case .declined: "Declined"
        case .tentative: "Maybe · Added to Taskify"
        case .pending: "Awaiting response"
        case .deleted: "Dismissed"
        }
    }

    private var statusSymbol: String {
        switch item.status {
        case .accepted: "checkmark.circle.fill"
        case .declined: "xmark.circle.fill"
        case .tentative: "questionmark.circle.fill"
        case .pending: "clock"
        case .deleted: "trash"
        }
    }

    private var statusColor: Color {
        switch item.status {
        case .accepted: .green
        case .declined: .red
        case .tentative: .orange
        case .pending: TaskifyTheme.secondaryText
        case .deleted: TaskifyTheme.tertiaryText
        }
    }
}

struct DirectMessageMarkdownText: View {
    private let renderCache: ChatConversationRenderCache
    private let document: NostrChatMarkdownDocument
    private let isIncoming: Bool
    @State private var copiedCode: String?

    init(markdown: String, isIncoming: Bool, renderCache: ChatConversationRenderCache) {
        self.renderCache = renderCache
        document = renderCache.document(markdown)
        self.isIncoming = isIncoming
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(document.blocks.enumerated()), id: \.offset) { index, block in
                blockView(block)
                    .padding(.top, topPadding(for: block, at: index))
            }
        }
        .textSelection(.enabled)
        .tint(isIncoming ? TaskifyTheme.accent : Color.white)
        .environment(\.openURL, OpenURLAction { url in
            guard let code = NostrChatMarkdown.copiedCode(from: url) else {
                return .systemAction
            }
            copy(code)
            return .handled
        })
        .overlay(alignment: .topTrailing) {
            if copiedCode != nil {
                Label("Copied", systemImage: "checkmark")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(Color.black.opacity(0.78), in: Capsule())
                    .offset(y: -29)
                    .transition(.scale.combined(with: .opacity))
                    .allowsHitTesting(false)
            }
        }
        .task(id: copiedCode) {
            guard copiedCode != nil else { return }
            do {
                try await Task.sleep(for: .seconds(1.25))
            } catch {
                return
            }
            withAnimation(.easeOut(duration: 0.18)) {
                copiedCode = nil
            }
        }
    }

    @ViewBuilder
    private func blockView(_ block: NostrChatMarkdownBlock) -> some View {
        switch block {
        case .paragraph(let content):
            inlineText(content, font: .system(size: 16))
        case let .heading(level, content):
            inlineText(content, font: headingFont(level: level))
        case let .unorderedListItem(depth, content):
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Text("•")
                    .font(.system(size: 16, weight: .bold))
                    .frame(width: 12, alignment: .trailing)
                inlineText(content, font: .system(size: 16))
            }
            .padding(.leading, CGFloat(depth) * 15)
        case let .orderedListItem(depth, number, content):
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Text("\(number).")
                    .font(.system(size: 15, weight: .semibold))
                    .frame(minWidth: 18, alignment: .trailing)
                inlineText(content, font: .system(size: 16))
            }
            .padding(.leading, CGFloat(depth) * 15)
        case let .blockQuote(depth, content):
            HStack(alignment: .top, spacing: 8) {
                RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                    .fill(foregroundColor.opacity(0.38))
                    .frame(width: 3)
                inlineText(content, font: .system(size: 16).italic())
                    .foregroundStyle(foregroundColor.opacity(0.88))
            }
            .padding(.leading, CGFloat(max(0, depth - 1)) * 12)
        case let .codeBlock(language, content):
            VStack(alignment: .leading, spacing: 5) {
                if let language {
                    Text(language.uppercased())
                        .font(.system(size: 9, weight: .bold, design: .monospaced))
                        .foregroundStyle(foregroundColor.opacity(0.62))
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(content)
                        .font(.system(size: 14, design: .monospaced))
                        .foregroundStyle(foregroundColor)
                        .fixedSize(horizontal: true, vertical: false)
                }
            }
            .padding(10)
            .background(codeBackground, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
            .onTapGesture { copy(content) }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityHint("Copies code")
        case .thematicBreak:
            Rectangle()
                .fill(foregroundColor.opacity(0.24))
                .frame(minWidth: 120, maxWidth: .infinity, minHeight: 1, maxHeight: 1)
        }
    }

    private func inlineText(_ markdown: String, font: Font) -> some View {
        Text(styledInlineMarkdown(markdown))
            .font(font)
            .foregroundStyle(foregroundColor)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func styledInlineMarkdown(_ markdown: String) -> AttributedString {
        var attributed = renderCache.inline(markdown)
        let runs = attributed.runs.map { run in
            (
                range: run.range,
                intent: run.inlinePresentationIntent,
                link: run.link
            )
        }
        for run in runs {
            if run.intent?.contains(.code) == true {
                let code = String(attributed[run.range].characters)
                attributed[run.range].font = .system(
                    size: 14.5,
                    weight: .medium,
                    design: .monospaced
                )
                attributed[run.range].foregroundColor = foregroundColor
                attributed[run.range].backgroundColor = codeBackground
                attributed[run.range].link = NostrChatMarkdown.copyURL(for: code)
                continue
            }
            if let link = run.link, !isSafeExternalLink(link) {
                attributed[run.range].link = nil
            }
        }
        return attributed
    }

    private var foregroundColor: Color {
        isIncoming ? TaskifyTheme.primaryText : .white
    }

    private var codeBackground: Color {
        isIncoming ? Color.white.opacity(0.12) : Color.black.opacity(0.2)
    }

    private func headingFont(level: Int) -> Font {
        switch level {
        case 1: .system(size: 22, weight: .bold)
        case 2: .system(size: 20, weight: .bold)
        case 3: .system(size: 18, weight: .bold)
        default: .system(size: 16, weight: .semibold)
        }
    }

    private func topPadding(for block: NostrChatMarkdownBlock, at index: Int) -> CGFloat {
        guard index > 0 else { return 0 }
        let previous = document.blocks[index - 1]
        if isListItem(block), isListItem(previous) { return 4 }
        if isBlockQuote(block), isBlockQuote(previous) { return 4 }
        return 10
    }

    private func isListItem(_ block: NostrChatMarkdownBlock) -> Bool {
        switch block {
        case .unorderedListItem, .orderedListItem: true
        default: false
        }
    }

    private func isBlockQuote(_ block: NostrChatMarkdownBlock) -> Bool {
        if case .blockQuote = block { return true }
        return false
    }

    private func isSafeExternalLink(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        return scheme == "https" || scheme == "http" || scheme == "mailto"
    }

    private func copy(_ code: String) {
        guard !code.isEmpty else { return }
        UIPasteboard.general.string = code
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        withAnimation(.spring(response: 0.22, dampingFraction: 0.8)) {
            copiedCode = code
        }
    }
}

struct DirectMessageBubble: View, Equatable {
    let renderCache: ChatConversationRenderCache
    let message: NostrDirectMessage
    let repliedMessage: NostrDirectMessage?
    let reactions: [NostrDirectMessageReaction]
    let senderName: String?
    let senderContact: NostrContact?
    let showsSenderAvatar: Bool
    let isGroupedWithPrevious: Bool
    let isGroupedWithNext: Bool
    let showsSentStatus: Bool
    let isSearchMatch: Bool
    let isSelectedSearchResult: Bool
    /// The sender's consecutive photos this message stands for, oldest first, when it hosts a
    /// photo stack; the other photos in the run render nothing of their own.
    var photoStack: [NostrDirectMessage]? = nil

    private var links: [URL] {
        Array(TaskContentLinks.allURLs(in: message.content).prefix(2))
    }

    /// A Cashu token pasted or forwarded as plain chat text rather than sent through the formal
    /// NUT-18 payment-request flow. Only offered for incoming messages — the sender already has
    /// their own record of a token they sent.
    private var detectedPaymentToken: String? {
        guard message.isIncoming, message.attachment == nil else { return nil }
        return CashuPaymentRequestContract.firstTokenSubstring(in: message.content)
    }

    var body: some View {
        // No per-row DragGesture here: a drag recognizer attached to every bubble races the
        // scroll view's pan recognizer on each touch-down and scrolling becomes sticky to the
        // point of immobility (an earlier swipe-left timestamp reveal did exactly that). The
        // timestamp is available through the bubble's context menu instead.
        VStack(spacing: repliedMessage == nil ? 0 : 2) {
            if let repliedMessage {
                DirectMessageReplyContext(
                    renderCache: renderCache,
                    message: repliedMessage,
                    responseIsIncoming: message.isIncoming,
                    responseHasAvatar: showsSenderAvatar
                )
            }

            HStack(alignment: .bottom, spacing: 7) {
                if !message.isIncoming { Spacer(minLength: 68) }

                if showsSenderAvatar {
                    Group {
                        if !isGroupedWithNext {
                            ChatPeerAvatar(
                                contact: senderContact,
                                publicKey: message.senderPublicKey,
                                size: 34
                            )
                        } else {
                            Color.clear.frame(width: 34, height: 1)
                        }
                    }
                }

                VStack(alignment: message.isIncoming ? .leading : .trailing, spacing: 3) {
                    if message.isIncoming, let senderName {
                        Text(senderName)
                            .font(.caption.weight(.medium))
                            .foregroundStyle(TaskifyTheme.secondaryText)
                            .padding(.leading, 2)
                    }

                    HStack(alignment: .center, spacing: 10) {
                        messageBody
                            .overlay(alignment: message.isIncoming ? .topTrailing : .topLeading) {
                                if !reactions.isEmpty {
                                    DirectMessageReactionBadge(
                                        reactions: reactions,
                                        isIncoming: message.isIncoming
                                    )
                                    .offset(x: message.isIncoming ? 10 : -10, y: -30)
                                }
                            }
                        // Messages offers a save button beside photos someone sent you.
                        if message.isIncoming, !savablePhotos.isEmpty {
                            DirectMessagePhotoSaveButton(attachments: savablePhotos)
                        }
                    }
                    .padding(.top, reactions.isEmpty ? 0 : 30)

                    if !message.isIncoming, let deliveryState,
                       deliveryState != .sent || showsSentStatus {
                        HStack(spacing: 3) {
                            Image(systemName: deliveryStateSymbol(deliveryState))
                            Text(deliveryStateLabel(deliveryState))
                        }
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(
                            deliveryState == .failed ? Color.red : TaskifyTheme.tertiaryText
                        )
                        .accessibilityLabel("Message \(deliveryStateLabel(deliveryState))")
                    }
                }

                if message.isIncoming { Spacer(minLength: 68) }
            }
        }
        .padding(.vertical, isGroupedWithPrevious && repliedMessage == nil ? 1 : 4)
        .contentShape(Rectangle())
        .background {
            if isSearchMatch {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(TaskifyTheme.accent.opacity(isSelectedSearchResult ? 0.18 : 0.06))
            }
        }
        .overlay {
            if isSelectedSearchResult {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(TaskifyTheme.accent.opacity(0.9), lineWidth: 1.5)
            }
        }
        .animation(.easeInOut(duration: 0.18), value: isSelectedSearchResult)
    }

    private var savablePhotos: [NostrDirectMessageAttachment] {
        (photoStack ?? [message]).compactMap(\.attachment).filter(\.isImage)
    }

    /// A stack reports its least-delivered photo, so one still sending keeps the stack "Sending…".
    private var deliveryState: NostrDirectMessageDeliveryState? {
        let states = (photoStack ?? [message]).compactMap(\.deliveryState)
        if states.contains(.failed) { return .failed }
        if states.contains(.queued) { return .queued }
        return states.isEmpty ? nil : .sent
    }

    @ViewBuilder
    private var messageBody: some View {
        if let attachment = message.attachment {
            // Attachments carry their own shape; wrapping them in the colored text bubble would
            // put a photo inside a frame and a file inside a second card.
            if let photoStack, photoStack.count > 1 {
                DirectMessagePhotoStack(attachments: photoStack.compactMap(\.attachment))
            } else {
                DirectMessageAttachmentView(attachment: attachment)
            }
        } else {
            VStack(alignment: .leading, spacing: 6) {
                if let detectedPaymentToken {
                    DirectMessagePaymentCard(token: detectedPaymentToken)
                } else if let preview = message.sharedItemPreview {
                    Label(preview, systemImage: "square.and.arrow.up")
                } else {
                    DirectMessageMarkdownText(
                        markdown: message.content,
                        isIncoming: message.isIncoming,
                        renderCache: renderCache
                    )

                    ForEach(links, id: \.absoluteString) { url in
                        DirectMessageLinkCard(url: url, isIncoming: message.isIncoming)
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background {
                bubbleShape
                    .fill(
                        message.isIncoming
                            ? DirectMessageAttachmentStyle.cardFill
                            : TaskifyTheme.accent
                    )
            }
        }
    }

    private var bubbleShape: DirectMessageBubbleShape {
        DirectMessageBubbleShape(
            isIncoming: message.isIncoming,
            showsTail: !isGroupedWithNext
        )
    }

    private func deliveryStateSymbol(_ state: NostrDirectMessageDeliveryState) -> String {
        switch state {
        case .queued: "clock"
        case .sent: "checkmark"
        case .failed: "exclamationmark.circle.fill"
        }
    }

    private func deliveryStateLabel(_ state: NostrDirectMessageDeliveryState) -> String {
        switch state {
        case .queued: "Sending…"
        case .sent: "Sent"
        case .failed: "Failed"
        }
    }
}

struct DirectMessageReplyContext: View {
    let renderCache: ChatConversationRenderCache
    let message: NostrDirectMessage
    let responseIsIncoming: Bool
    let responseHasAvatar: Bool

    private var bubbleShape: DirectMessageBubbleShape {
        DirectMessageBubbleShape(
            isIncoming: message.isIncoming,
            showsTail: true
        )
    }

    private var strokeColor: Color {
        message.isIncoming ? Color.white.opacity(0.34) : TaskifyTheme.accent.opacity(0.82)
    }

    private var textColor: Color {
        message.isIncoming ? TaskifyTheme.secondaryText : TaskifyTheme.accent
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                if !message.isIncoming { Spacer(minLength: 68) }

                Text(renderCache.inline(message.displayContent))
                    .font(.caption)
                    .foregroundStyle(textColor)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .multilineTextAlignment(message.isIncoming ? .leading : .trailing)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .frame(maxWidth: 310, alignment: message.isIncoming ? .leading : .trailing)
                    .background {
                        bubbleShape.fill(Color.black.opacity(0.42))
                    }
                    .overlay {
                        bubbleShape.stroke(strokeColor, lineWidth: 1)
                    }

                if message.isIncoming { Spacer(minLength: 68) }
            }
            .padding(.leading, message.isIncoming && responseHasAvatar ? 41 : 0)

            ReplyConnectorShape(isIncoming: responseIsIncoming)
                .stroke(
                    Color.white.opacity(0.22),
                    style: StrokeStyle(lineWidth: 4.5, lineCap: .round, lineJoin: .round)
                )
                .frame(width: 31, height: 18)
                .frame(maxWidth: .infinity, alignment: responseIsIncoming ? .leading : .trailing)
                .padding(.leading, responseIsIncoming ? (responseHasAvatar ? 52 : 12) : 0)
                .padding(.trailing, responseIsIncoming ? 0 : 12)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("In reply to \(message.displayContent)")
    }
}

struct DirectMessageReactionBadge: View {
    let reactions: [NostrDirectMessageReaction]
    let isIncoming: Bool

    private let badgeFill = Color(red: 37 / 255, green: 37 / 255, blue: 41 / 255)

    private var emojis: [String] {
        reactions.reduce(into: [String]()) { values, reaction in
            if !values.contains(reaction.emoji) { values.append(reaction.emoji) }
        }
    }

    var body: some View {
        HStack(spacing: -4) {
            ForEach(emojis, id: \.self) { emoji in
                let count = reactions.filter { $0.emoji == emoji }.count
                ZStack {
                    Circle()
                        .fill(badgeFill)
                    Circle()
                        .stroke(Color.white.opacity(0.13), lineWidth: 0.7)
                    Text(emoji)
                        .font(.system(size: 20))
                }
                .frame(width: 38, height: 38)
                .overlay(alignment: .topTrailing) {
                    if count > 1 {
                        Text("\(count)")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(Color.white.opacity(0.9))
                            .frame(width: 15, height: 15)
                            .background(Color(red: 79 / 255, green: 79 / 255, blue: 84 / 255), in: Circle())
                            .offset(x: 2, y: -2)
                    }
                }
            }
        }
        .overlay(alignment: isIncoming ? .bottomTrailing : .bottomLeading) {
            ZStack {
                Circle()
                    .frame(width: 9, height: 9)
                Circle()
                    .frame(width: 4.5, height: 4.5)
                    .offset(x: isIncoming ? 7 : -7, y: 8)
            }
            .foregroundStyle(badgeFill)
            .offset(x: isIncoming ? 1 : -1, y: 5)
        }
        .shadow(color: Color.black.opacity(0.28), radius: 2, y: 1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Reactions: \(emojis.joined(separator: ", "))")
    }
}

struct ReplyConnectorShape: Shape {
    let isIncoming: Bool

    func path(in rect: CGRect) -> Path {
        var path = Path()
        if isIncoming {
            path.move(to: CGPoint(x: rect.maxX - 2, y: rect.minY + 2))
            path.addCurve(
                to: CGPoint(x: rect.minX + 2, y: rect.maxY - 2),
                control1: CGPoint(x: rect.minX + 11, y: rect.minY + 2),
                control2: CGPoint(x: rect.minX + 2, y: rect.minY + 9)
            )
        } else {
            path.move(to: CGPoint(x: rect.minX + 2, y: rect.minY + 2))
            path.addCurve(
                to: CGPoint(x: rect.maxX - 2, y: rect.maxY - 2),
                control1: CGPoint(x: rect.maxX - 11, y: rect.minY + 2),
                control2: CGPoint(x: rect.maxX - 2, y: rect.minY + 9)
            )
        }
        return path
    }
}

struct DirectMessageBubbleShape: Shape {
    let isIncoming: Bool
    let showsTail: Bool

    func path(in rect: CGRect) -> Path {
        let radius = min(CGFloat(18), rect.height / 2)
        guard showsTail else {
            return RoundedRectangle(cornerRadius: radius, style: .continuous).path(in: rect)
        }

        // Messages uses a compact tail that grows out of the bottom corner. Keep its height
        // independent from the body radius: tying the two together makes a one-line bubble's
        // tail start near its vertical midpoint and leaves the whole corner looking pinched.
        let tailWidth: CGFloat = 6
        let tailHeight = min(CGFloat(11), max(CGFloat(7), rect.height * 0.3))
        // The tail protrudes from the body's layout bounds instead of consuming horizontal
        // space inside them. That keeps the bodies and text of consecutive messages aligned.
        let bodyLeft = rect.minX
        let bodyRight = rect.maxX
        let top = rect.minY
        let bottom = rect.maxY
        var path = Path()

        if isIncoming {
            path.move(to: CGPoint(x: bodyLeft + radius, y: top))
            path.addLine(to: CGPoint(x: bodyRight - radius, y: top))
            path.addQuadCurve(
                to: CGPoint(x: bodyRight, y: top + radius),
                control: CGPoint(x: bodyRight, y: top)
            )
            path.addLine(to: CGPoint(x: bodyRight, y: bottom - radius))
            path.addQuadCurve(
                to: CGPoint(x: bodyRight - radius, y: bottom),
                control: CGPoint(x: bodyRight, y: bottom)
            )
            path.addLine(to: CGPoint(x: bodyLeft + 16, y: bottom))
            path.addCurve(
                to: CGPoint(x: rect.minX - tailWidth, y: bottom),
                control1: CGPoint(x: bodyLeft + 10, y: bottom),
                control2: CGPoint(x: rect.minX - tailWidth + 4, y: bottom)
            )
            path.addCurve(
                to: CGPoint(x: bodyLeft, y: bottom - tailHeight),
                control1: CGPoint(x: rect.minX - tailWidth + 4, y: bottom),
                control2: CGPoint(x: bodyLeft, y: bottom - 5)
            )
            path.addLine(to: CGPoint(x: bodyLeft, y: top + radius))
            path.addQuadCurve(
                to: CGPoint(x: bodyLeft + radius, y: top),
                control: CGPoint(x: bodyLeft, y: top)
            )
        } else {
            path.move(to: CGPoint(x: bodyLeft + radius, y: top))
            path.addLine(to: CGPoint(x: bodyRight - radius, y: top))
            path.addQuadCurve(
                to: CGPoint(x: bodyRight, y: top + radius),
                control: CGPoint(x: bodyRight, y: top)
            )
            path.addLine(to: CGPoint(x: bodyRight, y: bottom - tailHeight))
            path.addCurve(
                to: CGPoint(x: rect.maxX + tailWidth, y: bottom),
                control1: CGPoint(x: bodyRight, y: bottom - 5),
                control2: CGPoint(x: rect.maxX + tailWidth - 4, y: bottom)
            )
            path.addCurve(
                to: CGPoint(x: bodyRight - 16, y: bottom),
                control1: CGPoint(x: rect.maxX + tailWidth - 4, y: bottom),
                control2: CGPoint(x: bodyRight - 10, y: bottom)
            )
            path.addLine(to: CGPoint(x: bodyLeft + radius, y: bottom))
            path.addQuadCurve(
                to: CGPoint(x: bodyLeft, y: bottom - radius),
                control: CGPoint(x: bodyLeft, y: bottom)
            )
            path.addLine(to: CGPoint(x: bodyLeft, y: top + radius))
            path.addQuadCurve(
                to: CGPoint(x: bodyLeft + radius, y: top),
                control: CGPoint(x: bodyLeft, y: top)
            )
        }

        path.closeSubpath()
        return path
    }
}

struct DirectMessageLinkCard: View {
    @Environment(\.openURL) private var openURL
    let url: URL
    let isIncoming: Bool

    private var host: String {
        url.host(percentEncoded: false)?.replacingOccurrences(of: "www.", with: "")
            ?? url.absoluteString
    }

    private var faviconURL: URL? { TaskContentLinks.faviconURL(for: url) }

    var body: some View {
        Button {
            openURL(url)
        } label: {
            HStack(spacing: 10) {
                faviconIcon
                    .foregroundStyle(isIncoming ? TaskifyTheme.accent : .white)
                    .frame(width: 34, height: 34)
                    .background(
                        isIncoming ? TaskifyTheme.accent.opacity(0.16) : Color.black.opacity(0.14),
                        in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                    )

                VStack(alignment: .leading, spacing: 2) {
                    Text(TaskContentLinks.fallbackTitle(for: url))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .lineLimit(2)
                    Text(host)
                        .font(.caption2)
                        .foregroundStyle(isIncoming ? TaskifyTheme.secondaryText : Color.white.opacity(0.72))
                        .lineLimit(1)
                }

                Spacer(minLength: 2)
                Image(systemName: "arrow.up.right")
                    .font(.caption2.bold())
                    .foregroundStyle(isIncoming ? TaskifyTheme.secondaryText : Color.white.opacity(0.8))
            }
            .padding(8)
            .frame(maxWidth: 270, alignment: .leading)
            .background(
                isIncoming ? Color.white.opacity(0.055) : Color.black.opacity(0.12),
                in: RoundedRectangle(cornerRadius: 13, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .stroke(Color.white.opacity(0.10), lineWidth: 0.7)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open link to \(host)")
    }

    @ViewBuilder
    private var faviconIcon: some View {
        if let faviconURL {
            AsyncImage(url: faviconURL) { phase in
                if case let .success(image) = phase {
                    image
                        .resizable()
                        .scaledToFit()
                        .padding(7)
                } else {
                    Image(systemName: "link")
                        .font(.subheadline.bold())
                }
            }
        } else {
            Image(systemName: "link")
                .font(.subheadline.bold())
        }
    }
}

/// A Cashu token sent as plain chat text rather than through the formal payment-request flow.
/// The Taskify wallet is being phased out, so these are never redeemed here: the card only
/// copies the token for the user to redeem in another Cashu wallet.
struct DirectMessagePaymentCard: View {
    let token: String
    @State private var copied = false

    private var summary: CashuOfflineTokenSummary? {
        CashuWalletService.offlineTokenSummary(token)
    }

    var body: some View {
        Button {
            UIPasteboard.general.string = token
            copied = true
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "bitcoinsign.circle.fill")
                    .font(.subheadline.bold())
                    .foregroundStyle(TaskifyTheme.accent)
                    .frame(width: 34, height: 34)
                    .background(TaskifyTheme.accent.opacity(0.16), in: RoundedRectangle(cornerRadius: 10, style: .continuous))

                VStack(alignment: .leading, spacing: 2) {
                    Text(summary.map { "\($0.amount.formatted()) sats" } ?? "Cashu token received")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(TaskifyTheme.primaryText)
                    Text(copied ? "Copied — paste it into another Cashu wallet" : "Not redeemed")
                        .font(.caption2)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                        .lineLimit(1)
                }

                Spacer(minLength: 2)
                Label(copied ? "Copied" : "Copy token", systemImage: copied ? "checkmark" : "doc.on.doc")
                    .font(.caption2.bold())
                    .foregroundStyle(TaskifyTheme.accent)
            }
            .padding(8)
            .frame(maxWidth: 270, alignment: .leading)
            .background(Color.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .stroke(Color.white.opacity(0.10), lineWidth: 0.7)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(summary.map { "Copy \($0.amount) sat Cashu token" } ?? "Copy Cashu token")
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .seconds(2.5))
            copied = false
        }
    }
}

struct DirectMessageAttachmentView: View {
    let attachment: NostrDirectMessageAttachment
    /// Square-ish grid tile, used by conversation details and the photo gallery.
    var compact = false

    @State private var isLoading = false
    @State private var failed = false
    @State private var previewURL: URL?
    @State private var isSaving = false
    @State private var downloadMessage: String?
    @Environment(AppModel.self) private var model

    @ViewBuilder
    var body: some View {
        if attachment.isAudio, !compact {
            DirectMessageAudioAttachmentView(attachment: attachment)
        } else if attachment.isImage || compact {
            Button(action: openAttachment) {
                Group {
                    if compact { compactPreview } else { photoBubble }
                }
                .contentShape(RoundedRectangle(cornerRadius: DirectMessageAttachmentStyle.cornerRadius, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(isLoading)
            .modifier(AttachmentQuickLook(previewURL: $previewURL))
            .accessibilityLabel("Open \(attachment.displayName)")
        } else {
            fileRow
        }
    }

    /// The photo is the bubble: no colored chrome around it, just rounded corners.
    private var photoBubble: some View {
        DirectMessageAttachmentThumbnail(attachment: attachment)
            .frame(width: DirectMessageAttachmentStyle.photoWidth, height: photoHeight)
            .clipShape(RoundedRectangle(cornerRadius: DirectMessageAttachmentStyle.cornerRadius, style: .continuous))
            .overlay {
                if isLoading {
                    VStack(spacing: 5) {
                        ProgressView().tint(.white)
                        if let downloadMessage {
                            Text(downloadMessage)
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 8)
                                .multilineTextAlignment(.center)
                        }
                    }
                }
            }
    }

    private var compactPreview: some View {
        ZStack {
            if attachment.isImage {
                DirectMessageAttachmentThumbnail(attachment: attachment, maximumPixelSize: 600)
            } else {
                Rectangle().fill(DirectMessageAttachmentStyle.cardFill)
                if failed {
                    VStack(spacing: 7) {
                        Image(systemName: "arrow.clockwise").font(.title2.weight(.semibold))
                        Text("Retry").font(.caption.weight(.semibold))
                    }
                    .foregroundStyle(TaskifyTheme.secondaryText)
                } else if isLoading {
                    VStack(spacing: 6) {
                        ProgressView()
                        if let downloadMessage {
                            Text(downloadMessage)
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(TaskifyTheme.secondaryText)
                                .multilineTextAlignment(.center)
                                .padding(.horizontal, 8)
                        }
                    }
                } else {
                    VStack(spacing: 8) {
                        Image(systemName: attachment.detailIcon).font(.title2)
                        Text(attachment.displayName)
                            .font(.caption.weight(.semibold))
                            .lineLimit(2)
                            .multilineTextAlignment(.center)
                    }
                    .foregroundStyle(TaskifyTheme.primaryText)
                    .padding(10)
                }
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: 150)
        .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
    }

    /// A file sits in the thread as its own gray card, the same for sent and received files:
    /// tap to open it, or use the button to save it to Files.
    private var fileRow: some View {
        HStack(spacing: 10) {
            Button(action: openAttachment) {
                HStack(spacing: 12) {
                    DirectMessageFileGlyph(attachment: attachment, isLoading: isLoading)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(attachment.displayName)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(TaskifyTheme.primaryText)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                        Text(failed
                             ? "Couldn't open · Tap to retry"
                             : isLoading ? (downloadMessage ?? "Downloading attachment…") : attachment.kindAndSizeLabel)
                            .font(.caption)
                            .foregroundStyle(failed ? Color.red : TaskifyTheme.secondaryText)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(isLoading)
            .accessibilityLabel("Open \(attachment.displayName)")

            Button(action: saveToFiles) {
                ZStack {
                    if isSaving {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "square.and.arrow.down")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(TaskifyTheme.primaryText)
                    }
                }
                .frame(width: 36, height: 36)
                .background(Color.white.opacity(0.1), in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(isSaving)
            .accessibilityLabel("Save \(attachment.displayName) to Files")
        }
        .padding(.leading, 12)
        .padding(.trailing, 10)
        .padding(.vertical, 10)
        .frame(width: 270)
        .background(
            DirectMessageAttachmentStyle.cardFill,
            in: RoundedRectangle(cornerRadius: DirectMessageAttachmentStyle.cornerRadius, style: .continuous)
        )
        .modifier(AttachmentQuickLook(previewURL: $previewURL))
    }

    private var photoHeight: CGFloat {
        let width = DirectMessageAttachmentStyle.photoWidth
        guard let pixelWidth = attachment.width, let pixelHeight = attachment.height, pixelWidth > 0 else {
            return 300
        }
        return min(320, max(150, width * CGFloat(pixelHeight) / CGFloat(pixelWidth)))
    }

    private func openAttachment() {
        isLoading = true
        downloadMessage = nil
        Task { @MainActor in
            defer {
                isLoading = false
                downloadMessage = nil
            }
            do {
                let file = try await DirectMessageAttachmentDataLoader.shared.file(
                    for: attachment,
                    progress: { update in
                        Task { @MainActor in downloadMessage = update.message }
                    }
                )
                previewURL = try DirectMessageAttachmentDataLoader.previewFile(
                    file: file,
                    attachment: attachment
                )
                failed = false
            } catch {
                failed = true
            }
        }
    }

    private func saveToFiles() {
        isSaving = true
        Task { @MainActor in
            defer { isSaving = false }
            do {
                try await DirectMessageAttachmentExport.saveToFiles([attachment])
            } catch {
                model.errorMessage = error.localizedDescription
                UINotificationFeedbackGenerator().notificationOccurred(.error)
            }
        }
    }
}

/// Quick Look owns the named preview copy only while it is showing.
private struct AttachmentQuickLook: ViewModifier {
    @Binding var previewURL: URL?

    func body(content: Content) -> some View {
        content
            .quickLookPreview($previewURL)
            .onChange(of: previewURL) { old, new in
                if let old, old != new { try? FileManager.default.removeItem(at: old) }
            }
    }
}

/// A page with the file's extension on it, like Messages' document icon.
private struct DirectMessageFileGlyph: View {
    let attachment: NostrDirectMessageAttachment
    let isLoading: Bool

    var body: some View {
        ZStack(alignment: .bottom) {
            Image(systemName: "doc.fill")
                .font(.system(size: 40))
                .foregroundStyle(Color.white.opacity(0.92))
            if isLoading {
                ProgressView().controlSize(.small).tint(.gray).padding(.bottom, 12)
            } else if !attachment.fileExtensionLabel.isEmpty {
                Text(attachment.fileExtensionLabel)
                    .font(.system(size: 8, weight: .bold))
                    .foregroundStyle(Color.gray)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .frame(width: 26)
                    .padding(.bottom, 6)
            }
        }
        .frame(width: 38, height: 48)
        .accessibilityHidden(true)
    }
}

actor DirectMessageAttachmentImageLoader {
    static let shared = DirectMessageAttachmentImageLoader()

    private let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.totalCostLimit = 64 * 1_024 * 1_024
        return cache
    }()

    func image(
        fileURL: URL,
        cacheKey: String,
        maximumPixelSize: CGFloat
    ) async -> UIImage? {
        let key = "\(Int(maximumPixelSize))::\(cacheKey)" as NSString
        if let cached = cache.object(forKey: key) { return cached }
        let image = await Task.detached(priority: .userInitiated) {
            guard let source = CGImageSourceCreateWithURL(fileURL as CFURL, nil) else {
                return nil as UIImage?
            }
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: maximumPixelSize,
                kCGImageSourceShouldCacheImmediately: true,
            ]
            guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(
                source,
                0,
                options as CFDictionary
            ) else {
                return nil
            }
            return UIImage(cgImage: thumbnail)
        }.value
        guard let image else { return nil }
        let cost = Int(image.size.width * image.scale * image.size.height * image.scale * 4)
        cache.setObject(image, forKey: key, cost: cost)
        return image
    }

    nonisolated static func dimensions(data: Data) async -> (width: Int, height: Int)? {
        await Task.detached(priority: .utility) {
            guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                  let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil)
                    as? [CFString: Any],
                  let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
                  let height = properties[kCGImagePropertyPixelHeight] as? NSNumber else {
                return nil
            }
            return (width.intValue, height.intValue)
        }.value
    }
}

enum ChatAttachmentError: LocalizedError {
    case invalidURL
    case unreadableFile
    case downloadFailed(Int)

    var errorDescription: String? {
        switch self {
        case .invalidURL: "The attachment URL is invalid."
        case .unreadableFile: "The selected attachment could not be read."
        case .downloadFailed(let status): "The attachment server returned an error (\(status))."
        }
    }
}

/// Opens at the latest messages and tracks whether the reader has scrolled away from them.
/// A finger on the timeline stops following the latest message, so lazy rows settle during
/// history scrolling without pulling the reader back to the bottom.
extension View {
    @ViewBuilder
    func conversationScrollBehavior(
        followsLatest: Binding<Bool>,
        isMoving: Binding<Bool>,
        isAwayFromBottom: Binding<Bool>,
        allowsFollowing: Bool,
        canLoadEarlier: Bool,
        onInteraction: @escaping () -> Void,
        onReachedTop: @escaping () -> Void
    ) -> some View {
        if #available(iOS 18.0, *) {
            self
                .defaultScrollAnchor(.bottom, for: .initialOffset)
                // No `.sizeChanges` anchor: it fought the explicit settles on arrivals and on
                // open, leaving the offset past the last row once lazy rows replaced their
                // estimated heights (a blank thread until scrolled). The conversation keeps the
                // newest message in view itself when its viewport changes.
                // Observe complete geometry so an intermediate initial offset cannot leave
                // a cached Boolean out of sync as lazy layout settles. State still changes
                // only when crossing the near-bottom threshold.
                .onScrollGeometryChange(for: ScrollGeometry.self) { $0 } action: { _, geometry in
                    let isAway = geometry.conversationIsAwayFromBottom
                    if isAwayFromBottom.wrappedValue != isAway {
                        isAwayFromBottom.wrappedValue = isAway
                    }
                    if canLoadEarlier, geometry.conversationIsAtTop {
                        onReachedTop()
                    }
                }
                .onScrollPhaseChange { previousPhase, phase, context in
                    let moving = phase != .idle
                    if isMoving.wrappedValue != moving { isMoving.wrappedValue = moving }
                    switch phase {
                    case .tracking, .interacting:
                        followsLatest.wrappedValue = false
                        onInteraction()
                    case .idle:
                        switch previousPhase {
                        case .tracking, .interacting, .decelerating:
                            followsLatest.wrappedValue =
                                !context.geometry.conversationIsAwayFromBottom
                        default:
                            break
                        }
                    default:
                        break
                    }
                }
        } else {
            // iOS 17 has no scroll-phase callback. One recognizer on the scroll container
            // records deliberate history navigation without adding a recognizer to every row.
            self.simultaneousGesture(
                DragGesture(minimumDistance: 4)
                    .onChanged { _ in onInteraction() }
            )
        }
    }
}

@available(iOS 18.0, *)
extension ScrollGeometry {
    var conversationIsAwayFromBottom: Bool {
        // visibleRect includes the content insets. Remove its bottom inset to find
        // the usable viewport edge above the composer, including during keyboard resizing.
        contentSize.height - (visibleRect.maxY - contentInsets.bottom) > 80
    }

    var conversationIsAtTop: Bool {
        visibleRect.minY <= contentInsets.top + 24
    }
}

// MARK: - Hermes model picker

private struct HermesModelCatalogCacheEntry: Codable, Equatable {
    let providerSlug: String
    let providerName: String?
    let models: [String]
    let listingID: String
    let fetchedAt: TimeInterval

    func isFresh(for currentListingID: String) -> Bool {
        let age = Date().timeIntervalSince1970 - fetchedAt
        return listingID == currentListingID && age >= 0 && age < 10 * 60
    }
}

@MainActor
private final class HermesModelCatalogCache {
    static let shared = HermesModelCatalogCache()

    private let defaults: UserDefaults
    private let storageKey = "taskify_hermes_model_catalog_cache_v1"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    private func key(peer: String, provider: String) -> String {
        "\(peer.lowercased())|\(provider.lowercased())"
    }

    private func loadMap() -> [String: HermesModelCatalogCacheEntry] {
        guard let data = defaults.data(forKey: storageKey),
              let map = try? JSONDecoder().decode([String: HermesModelCatalogCacheEntry].self, from: data) else {
            return [:]
        }
        return map
    }

    func load(peer: String, listingID: String, provider: String) -> HermesModelCatalogCacheEntry? {
        let entry = loadMap()[key(peer: peer, provider: provider)]
        guard let entry,
              entry.providerSlug.caseInsensitiveCompare(provider) == .orderedSame,
              entry.models.allSatisfy(HermesModelMenuParser.isValidModelId) else { return nil }
        return entry
    }

    func save(peer: String, listingID: String, catalog: HermesProviderCatalog) {
        var map = loadMap()
        map[key(peer: peer, provider: catalog.providerSlug)] =
            HermesModelCatalogCacheEntry(
                providerSlug: catalog.providerSlug,
                providerName: catalog.providerName,
                models: catalog.models,
                listingID: listingID,
                fetchedAt: Date().timeIntervalSince1970
            )
        guard let data = try? JSONEncoder().encode(map) else { return }
        defaults.set(data, forKey: storageKey)
    }
}

private enum HermesModelPickerPage: Equatable {
    case overview
    case providers
    case models(String)
}

/// Native counterpart to the PWA's interactive Hermes model card. The listing response is the
/// visible card; generated commands and matching JSON/confirmation responses are filtered by the
/// shared projection before the timeline is built.
struct HermesModelPickerChatView: View {
    @Environment(AppModel.self) private var model
    let peerPublicKey: String
    let projection: HermesModelMenuProjection

    @State private var page: HermesModelPickerPage = .overview
    @State private var providerPage = 0
    @State private var modelPage = 0
    @State private var cachedCatalogs: [String: HermesModelCatalogCacheEntry] = [:]
    @State private var loadingProvider: String?
    @State private var switchingModel: String?
    @State private var actionError: String?

    private let columns = [
        GridItem(.flexible(), spacing: 7),
        GridItem(.flexible(), spacing: 7),
    ]

    private var providers: [HermesModelProvider] { projection.listing.providers }
    private var providerPageCount: Int {
        max(1, Int(ceil(Double(providers.count) / Double(HermesModelMenuParser.providerPageSize))))
    }
    private var safeProviderPage: Int {
        min(max(providerPage, 0), providerPageCount - 1)
    }
    private var providerRows: ArraySlice<HermesModelProvider> {
        let start = min(providers.count, safeProviderPage * HermesModelMenuParser.providerPageSize)
        let end = min(providers.count, start + HermesModelMenuParser.providerPageSize)
        return providers[start..<end]
    }
    private var activeProvider: HermesModelProvider? {
        guard case let .models(slug) = page else { return nil }
        return providers.first { $0.slug == slug }
    }
    private var currentProviderSlug: String? {
        projection.selectedModel?.providerSlug ?? projection.listing.currentProviderSlug
    }
    private var currentModel: String {
        projection.selectedModel?.modelId ?? projection.listing.currentModel ?? "Model not reported"
    }
    private var currentProviderName: String? {
        projection.selectedModel?.providerName
            ?? providers.first { $0.slug == currentProviderSlug }?.name
            ?? currentProviderSlug
    }
    private var requestInFlight: Bool {
        projection.pendingAction != nil || loadingProvider != nil || switchingModel != nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header

            if page == .overview, let selected = projection.selectedModel {
                confirmation(selected)
            } else if page == .providers || (page == .overview && projection.selectedModel == nil) {
                providerPicker
            } else if let provider = activeProvider {
                modelPicker(provider)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            DirectMessageAttachmentStyle.cardFill,
            in: RoundedRectangle(cornerRadius: 18, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(TaskifyTheme.border.opacity(0.8), lineWidth: 1)
        )
        .onAppear(perform: hydrateCachedCatalogs)
        .onChange(of: projection.catalogs) { _, catalogs in
            persist(catalogs)
        }
        .onChange(of: projection.selectedModel) { _, selected in
            guard selected != nil else { return }
            page = .overview
            switchingModel = nil
            actionError = nil
        }
        .onChange(of: projection.pendingAction) { _, action in
            guard let action else { return }
            if action.kind == .catalogRequest {
                loadingProvider = action.providerSlug
            } else {
                switchingModel = action.modelId
            }
        }
        .onChange(of: projection.failure) { _, failure in
            guard failure != nil else { return }
            loadingProvider = nil
            switchingModel = nil
            actionError = "Hermes replied in an unexpected format. The raw response is shown below."
        }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: "gearshape.fill")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(TaskifyTheme.accent)
                .frame(width: 30, height: 30)
                .background(TaskifyTheme.accent.opacity(0.14), in: Circle())

            VStack(alignment: .leading, spacing: 2) {
                Text("Model configuration")
                    .font(.subheadline.bold())
                    .foregroundStyle(TaskifyTheme.primaryText)
                HStack(spacing: 5) {
                    Text(currentModel)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if let currentProviderName, !currentProviderName.isEmpty {
                        Text(currentProviderName)
                            .foregroundStyle(TaskifyTheme.accent)
                            .lineLimit(1)
                    }
                }
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.secondaryText)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }

    private func providerButton(_ provider: HermesModelProvider) -> some View {
        let fill: Color = provider.isCurrent
            ? TaskifyTheme.accent.opacity(0.14)
            : TaskifyTheme.panelFill
        let stroke: Color = provider.isCurrent
            ? TaskifyTheme.accent.opacity(0.42)
            : TaskifyTheme.border.opacity(0.7)
        let accessibility = "\(provider.name), \(provider.totalModels) models"
            + (provider.isCurrent ? ", current provider" : "")
        return Button {
            openProvider(provider)
        } label: {
            HStack(spacing: 5) {
                if provider.isCurrent {
                    Image(systemName: "checkmark")
                        .font(.caption2.bold())
                        .foregroundStyle(TaskifyTheme.accent)
                }
                Text(provider.name)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                Spacer(minLength: 2)
                Text("\(provider.totalModels)")
                    .font(.caption2)
                    .foregroundStyle(TaskifyTheme.secondaryText)
            }
            .foregroundStyle(TaskifyTheme.primaryText)
            .padding(.horizontal, 9)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .background(fill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(stroke, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .disabled(requestInFlight)
        .accessibilityLabel(accessibility)
    }

    private func modelButton(_ modelID: String, provider: HermesModelProvider) -> some View {
        Button {
            switchModel(provider: provider, modelID: modelID)
        } label: {
            HStack(spacing: 5) {
                Text(modelID)
                    .font(.caption.weight(.medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 0)
                if switchingModel == modelID {
                    ProgressView().controlSize(.mini)
                }
            }
            .foregroundStyle(TaskifyTheme.primaryText)
            .padding(.horizontal, 9)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .background(
                TaskifyTheme.panelFill,
                in: RoundedRectangle(cornerRadius: 10, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(TaskifyTheme.border.opacity(0.7), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .disabled(requestInFlight)
        .accessibilityLabel("Switch to \(modelID)")
    }

    private var providerPicker: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Select a provider")
                Spacer()
                if providers.isEmpty {
                    Text("None reported")
                } else {
                    let first = safeProviderPage * HermesModelMenuParser.providerPageSize + 1
                    let last = min(providers.count, first + providerRows.count - 1)
                    Text("\(first)–\(last) of \(providers.count)")
                }
            }
            .font(.caption)
            .foregroundStyle(TaskifyTheme.secondaryText)

            LazyVGrid(columns: columns, spacing: 7) {
                ForEach(Array(providerRows), id: \.slug) { provider in
                    providerButton(provider)
                }
            }

            HStack(spacing: 7) {
                pickerControl("Prev", systemImage: "chevron.left", disabled: safeProviderPage == 0 || requestInFlight) {
                    providerPage = max(0, providerPage - 1)
                }
                pickerControl(
                    "Next",
                    systemImage: "chevron.right",
                    disabled: safeProviderPage >= providerPageCount - 1 || requestInFlight
                ) {
                    providerPage = min(providerPageCount - 1, providerPage + 1)
                }
                pickerControl(
                    projection.selectedModel == nil ? "Cancel" : "Done",
                    systemImage: projection.selectedModel == nil ? "xmark" : "checkmark"
                ) {
                    page = .overview
                    actionError = nil
                }
            }
        }
    }

    private func modelPicker(_ provider: HermesModelProvider) -> some View {
        let liveCatalog = projection.catalogs[provider.slug]
        let cacheEntry = cachedCatalogs[provider.slug]
            ?? HermesModelCatalogCache.shared.load(
                peer: peerPublicKey,
                listingID: projection.listingEventId,
                provider: provider.slug
            )
        let models = liveCatalog?.models ?? cacheEntry?.models ?? []
        let pageCount = max(1, Int(ceil(Double(models.count) / Double(HermesModelMenuParser.modelPageSize))))
        let safePage = min(max(modelPage, 0), pageCount - 1)
        let start = min(models.count, safePage * HermesModelMenuParser.modelPageSize)
        let end = min(models.count, start + HermesModelMenuParser.modelPageSize)
        let rows = Array(models[start..<end])
        let isLoading = loadingProvider == provider.slug

        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                pickerControl("Back", systemImage: "chevron.left") {
                    page = .providers
                    modelPage = 0
                    actionError = nil
                }
                .frame(width: 88)
                VStack(alignment: .leading, spacing: 1) {
                    Text(provider.name)
                        .font(.caption.bold())
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .lineLimit(1)
                    Text(
                        models.isEmpty
                            ? (isLoading ? "Loading…" : "No models loaded")
                            : "\(start + 1)–\(end) of \(models.count)"
                    )
                    .font(.caption2)
                    .foregroundStyle(TaskifyTheme.secondaryText)
                }
                Spacer(minLength: 0)
            }

            if rows.isEmpty {
                HStack(spacing: 8) {
                    if isLoading { ProgressView().controlSize(.small) }
                    Text(isLoading ? "Loading \(provider.name) models…" : "No models were returned for this provider.")
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                }
                .padding(9)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(TaskifyTheme.panelFill, in: RoundedRectangle(cornerRadius: 9))
            } else {
                LazyVGrid(columns: columns, spacing: 7) {
                    ForEach(rows, id: \.self) { modelID in
                        modelButton(modelID, provider: provider)
                    }
                }
            }

            if isLoading, !rows.isEmpty {
                HStack(spacing: 7) {
                    ProgressView().controlSize(.small)
                    Text("Refreshing model list…")
                }
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.secondaryText)
            } else if let cacheEntry, !cacheEntry.isFresh(for: projection.listingEventId), !isLoading {
                Text("Cached list · refresh to check for new models")
                    .font(.caption2)
                    .foregroundStyle(TaskifyTheme.secondaryText)
            }

            if let actionError {
                Text(actionError)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.red.opacity(0.09), in: RoundedRectangle(cornerRadius: 9))
            }

            HStack(spacing: 7) {
                pickerControl("Prev", systemImage: "chevron.left", disabled: safePage == 0 || requestInFlight) {
                    modelPage = max(0, modelPage - 1)
                }
                pickerControl(
                    "Next",
                    systemImage: "chevron.right",
                    disabled: safePage >= pageCount - 1 || requestInFlight
                ) {
                    modelPage = min(pageCount - 1, modelPage + 1)
                }
                pickerControl("Refresh", systemImage: "arrow.clockwise", disabled: requestInFlight) {
                    requestCatalog(provider.slug)
                }
                pickerControl("Cancel", systemImage: "xmark") {
                    page = projection.selectedModel == nil ? .providers : .overview
                    actionError = nil
                }
            }
        }
    }

    private func confirmation(_ selected: HermesSelectedModel) -> some View {
        HStack(spacing: 9) {
            Image(systemName: "checkmark")
                .font(.caption.bold())
                .foregroundStyle(.green)
                .frame(width: 28, height: 28)
                .background(Color.green.opacity(0.13), in: Circle())
            VStack(alignment: .leading, spacing: 1) {
                Text("Current model")
                    .font(.caption2)
                    .foregroundStyle(TaskifyTheme.secondaryText)
                Text(selected.modelId)
                    .font(.caption.bold())
                    .foregroundStyle(TaskifyTheme.primaryText)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let providerName = selected.providerName, !providerName.isEmpty {
                    Text(providerName)
                        .font(.caption2)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                }
            }
            Spacer(minLength: 4)
            pickerControl("Change", systemImage: "slider.horizontal.3") {
                page = .providers
                actionError = nil
            }
            .frame(width: 92)
        }
        .padding(9)
        .background(Color.green.opacity(0.07), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .stroke(Color.green.opacity(0.18), lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
    }

    private func pickerControl(
        _ title: String,
        systemImage: String,
        disabled: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(.caption2.weight(.semibold))
                .lineLimit(1)
                .frame(maxWidth: .infinity, minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(TaskifyTheme.primaryText)
        .background(
            TaskifyTheme.panelFill,
            in: RoundedRectangle(cornerRadius: 9, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .stroke(TaskifyTheme.border.opacity(0.7), lineWidth: 1)
        )
        .disabled(disabled)
        .opacity(disabled ? 0.46 : 1)
    }

    private func hydrateCachedCatalogs() {
        var next = cachedCatalogs
        for provider in providers {
            if next[provider.slug] == nil,
               let entry = HermesModelCatalogCache.shared.load(
                   peer: peerPublicKey,
                   listingID: projection.listingEventId,
                   provider: provider.slug
               ) {
                next[provider.slug] = entry
            }
        }
        cachedCatalogs = next
    }

    private func persist(_ catalogs: [String: HermesProviderCatalog]) {
        guard !catalogs.isEmpty else { return }
        var next = cachedCatalogs
        for (slug, catalog) in catalogs {
            HermesModelCatalogCache.shared.save(
                peer: peerPublicKey,
                listingID: projection.listingEventId,
                catalog: catalog
            )
            next[slug] = HermesModelCatalogCacheEntry(
                providerSlug: catalog.providerSlug,
                providerName: catalog.providerName,
                models: catalog.models,
                listingID: projection.listingEventId,
                fetchedAt: Date().timeIntervalSince1970
            )
        }
        cachedCatalogs = next
        loadingProvider = nil
        actionError = nil
    }

    private func openProvider(_ provider: HermesModelProvider) {
        page = .models(provider.slug)
        modelPage = 0
        actionError = nil
        let liveCatalog = projection.catalogs[provider.slug]
        let cached = HermesModelCatalogCache.shared.load(
            peer: peerPublicKey,
            listingID: projection.listingEventId,
            provider: provider.slug
        )
        if let cached { cachedCatalogs[provider.slug] = cached }
        if liveCatalog == nil, cached?.isFresh(for: projection.listingEventId) != true {
            requestCatalog(provider.slug)
        }
    }

    private func requestCatalog(_ providerSlug: String) {
        guard projection.pendingAction == nil, loadingProvider == nil else { return }
        loadingProvider = providerSlug
        actionError = nil
        Task { @MainActor in
            do {
                try await model.sendBotUiCommand(
                    to: peerPublicKey,
                    content: TaskifyBotUiContract.catalogRequestPrompt(providerSlug: providerSlug),
                    action: TaskifyBotUiAction(
                        kind: .catalogRequest,
                        menuId: projection.menuId,
                        providerSlug: providerSlug
                    )
                )
            } catch {
                loadingProvider = nil
                actionError = error.localizedDescription
            }
        }
    }

    private func switchModel(provider: HermesModelProvider, modelID: String) {
        guard projection.pendingAction == nil, switchingModel == nil else { return }
        switchingModel = modelID
        actionError = nil
        Task { @MainActor in
            do {
                try await model.sendBotUiCommand(
                    to: peerPublicKey,
                    content: TaskifyBotUiContract.modelSwitchCommand(
                        providerSlug: provider.slug,
                        modelId: modelID
                    ),
                    action: TaskifyBotUiAction(
                        kind: .modelSelect,
                        menuId: projection.menuId,
                        providerSlug: provider.slug,
                        modelId: modelID
                    )
                )
            } catch {
                switchingModel = nil
                actionError = error.localizedDescription
            }
        }
    }
}
