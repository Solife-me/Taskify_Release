import SwiftUI
import TaskifyCore

struct ManageBoardView: View {
    @EnvironmentObject private var dataController: DataController
    @Environment(\.dismiss) private var dismiss

    let initialSettings: BoardSettingsSnapshot
    let availableCompoundBoards: [BoardOption]

    @State private var boardName: String
    @State private var columns: [BoardColumn]
    @State private var children: [BoardChildSnapshot]
    @State private var clearCompletedDisabled: Bool
    @State private var indexCardEnabled: Bool
    @State private var hideChildBoardNames: Bool
    @State private var relayHints: [String]

    @State private var newColumnName = ""
    @State private var newRelay = ""
    @State private var newCompoundChildInput = ""
    @State private var infoMessage: String?
    @State private var infoIsError = false
    @State private var showDeleteConfirm = false
    @State private var saving = false
    @State private var republishing = false
    #if os(iOS)
    @State private var editMode: EditMode = .inactive
    #endif

    init(settings: BoardSettingsSnapshot, availableCompoundBoards: [BoardOption]) {
        self.initialSettings = settings
        self.availableCompoundBoards = availableCompoundBoards
        _boardName = State(initialValue: settings.name)
        _columns = State(initialValue: settings.columns)
        _children = State(initialValue: settings.children)
        _clearCompletedDisabled = State(initialValue: settings.clearCompletedDisabled)
        _indexCardEnabled = State(initialValue: settings.indexCardEnabled)
        _hideChildBoardNames = State(initialValue: settings.hideChildBoardNames)
        _relayHints = State(initialValue: settings.relayHints)
    }

    private var isListBoard: Bool { initialSettings.kind == "lists" }
    private var isCompoundBoard: Bool { initialSettings.kind == "compound" }
    private var isWeekBoard: Bool { initialSettings.kind == "week" }

    private var trimmedBoardName: String {
        boardName.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var displayBoardName: String {
        trimmedBoardName.isEmpty ? initialSettings.name : trimmedBoardName
    }

    private var filteredCompoundBoards: [BoardOption] {
        let selectedIds = Set(children.map(\.id))
        return availableCompoundBoards.filter { !selectedIds.contains($0.id) }
    }

    private var effectiveSharePayload: String {
        BoardShareContract.buildEnvelopeString(
            boardId: initialSettings.id,
            boardName: displayBoardName,
            relays: effectiveRelayList
        )
    }

    private var effectiveRelayList: [String] {
        BoardShareContract.buildPayload(
            boardId: initialSettings.id,
            relays: (dataController.currentProfile?.relays ?? []) + relayHints
        ).relays
    }

    private var isDirty: Bool {
        trimmedBoardName != initialSettings.name.trimmingCharacters(in: .whitespacesAndNewlines)
            || columns != initialSettings.columns
            || children != initialSettings.children
            || clearCompletedDisabled != initialSettings.clearCompletedDisabled
            || indexCardEnabled != initialSettings.indexCardEnabled
            || hideChildBoardNames != initialSettings.hideChildBoardNames
            || relayHints != initialSettings.relayHints
    }

    var body: some View {
        NavigationStack {
            Form {
                if let infoMessage {
                    Section {
                        Text(infoMessage)
                            .font(.footnote)
                            .foregroundStyle(infoIsError ? Color.red : Color.secondary)
                    }
                }

                boardSection
                optionsSection

                if isListBoard {
                    columnsSection
                }

                if isCompoundBoard {
                    compoundChildrenSection
                }

                sharingSection
                dangerSection
            }
            .navigationTitle("Board Settings")
            .platformInlineTitle()
            #if os(iOS)
            .environment(\.editMode, $editMode)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : "Save") {
                        Task {
                            await saveChanges()
                        }
                    }
                    .bold()
                    .disabled(trimmedBoardName.isEmpty || saving)
                }
            }
            .confirmationDialog("Remove Board", isPresented: $showDeleteConfirm) {
                Button("Remove from Profile", role: .destructive) {
                    Task {
                        await dataController.removeBoard(boardId: initialSettings.id)
                        dismiss()
                    }
                }
            } message: {
                Text("This removes the board from your profile. Tasks and board metadata remain on relays.")
            }
        }
    }

    private var boardSection: some View {
        Section("Board") {
            TextField("Board Name", text: $boardName)

            HStack {
                Text("Type")
                Spacer()
                Text(boardKindLabel(initialSettings.kind))
                    .foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("Board ID")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(initialSettings.id)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                Button("Copy Board ID") {
                    copyToPasteboard(initialSettings.id, message: "Copied board ID.")
                }
                .font(.subheadline)
            }
        }
    }

    private var optionsSection: some View {
        Section {
            Toggle("Show clear completed actions", isOn: Binding(
                get: { !clearCompletedDisabled },
                set: { clearCompletedDisabled = !$0 }
            ))

            if !isWeekBoard {
                Toggle("Enable index-card grouping", isOn: $indexCardEnabled)
            }

            if isCompoundBoard {
                Toggle("Show child board names", isOn: Binding(
                    get: { !hideChildBoardNames },
                    set: { hideChildBoardNames = !$0 }
                ))
            }
        } header: {
            Text("Options")
        } footer: {
            if clearCompletedDisabled {
                Text("Completed tasks stay available in the Completed view even when the clear action is hidden.")
            } else if isCompoundBoard {
                Text("Compound boards can hide child-board labels in list headers for a cleaner board view.")
            }
        }
    }

    private var columnsSection: some View {
        Section {
            ForEach($columns) { $column in
                HStack(spacing: 10) {
                    Image(systemName: "line.3.horizontal")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    TextField("Column name", text: $column.name)
                }
            }
            .onDelete(perform: deleteColumns)
            .onMove(perform: moveColumns)

            HStack {
                TextField("New column name", text: $newColumnName)
                    .onSubmit(addColumn)
                Button(action: addColumn) {
                    Image(systemName: "plus.circle.fill")
                        .foregroundStyle(.blue)
                }
                .buttonStyle(.plain)
                .disabled(newColumnName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        } header: {
            HStack {
                Text("Columns")
                Spacer()
                #if os(iOS)
                Button(editMode == .active ? "Done" : "Edit") {
                    withAnimation {
                        editMode = editMode == .active ? .inactive : .active
                    }
                }
                .font(.subheadline)
                #endif
            }
        } footer: {
            Text("List boards mirror the PWA column model. Drag to reorder and edit names inline.")
        }
    }

    private var compoundChildrenSection: some View {
        Section {
            if filteredCompoundBoards.isEmpty == false {
                Menu {
                    ForEach(filteredCompoundBoards) { option in
                        Button(option.name) {
                            addCompoundChild(option)
                        }
                    }
                } label: {
                    Label("Add Existing Board", systemImage: "plus.circle")
                }
            }

            HStack {
                TextField("Board ID or share payload", text: $newCompoundChildInput)
                    .platformNoAutoCaps()
                    .platformURLKeyboard()
                Button("Add") {
                    addCompoundChildFromInput()
                }
                .disabled(newCompoundChildInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }

            if children.isEmpty {
                Text("No child boards yet.")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(children) { child in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(child.name)
                        Text(child.id)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                        if child.relayHints.isEmpty == false {
                            Text(child.relayHints.joined(separator: ", "))
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }
                }
                .onDelete(perform: deleteChildren)
                .onMove(perform: moveChildren)
            }
        } header: {
            HStack {
                Text("Child Boards")
                Spacer()
                #if os(iOS)
                if children.isEmpty == false {
                    Button(editMode == .active ? "Done" : "Edit") {
                        withAnimation {
                            editMode = editMode == .active ? .inactive : .active
                        }
                    }
                    .font(.subheadline)
                }
                #endif
            }
        } footer: {
            Text("Add list boards by selecting an existing board or pasting the same board ID/share payload accepted by the PWA.")
        }
    }

    private var sharingSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 10) {
                Text("Board-specific relay hints")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                HStack {
                    TextField("wss://relay.example", text: $newRelay)
                        .platformNoAutoCaps()
                        .platformURLKeyboard()
                        .onSubmit(addRelay)
                    Button("Add", action: addRelay)
                        .disabled(newRelay.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }

                if relayHints.isEmpty {
                    Text("Using profile relays only.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(relayHints, id: \.self) { relay in
                        HStack {
                            Text(relay)
                                .font(.caption)
                                .textSelection(.enabled)
                            Spacer()
                            Button("Delete", role: .destructive) {
                                relayHints.removeAll { $0 == relay }
                            }
                            .font(.caption)
                        }
                    }
                }

                Divider()

                Text("Share payload")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(effectiveSharePayload)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)

                HStack {
                    Button("Copy Payload") {
                        copyToPasteboard(effectiveSharePayload, message: "Copied share payload.")
                    }
                    ShareLink(item: effectiveSharePayload) {
                        Label("Share", systemImage: "square.and.arrow.up")
                    }
                }

                Button(republishing ? "Republishing…" : "Republish Metadata") {
                    Task {
                        await republishMetadata()
                    }
                }
                .disabled(republishing)
            }
        } header: {
            Text("Sharing")
        } footer: {
            Text("Relay hints are merged with your profile relays when building the cross-compatible Taskify share payload.")
        }
    }

    private var dangerSection: some View {
        Section {
            Button(role: .destructive, action: { showDeleteConfirm = true }) {
                Label("Remove Board", systemImage: "trash")
            }
        } footer: {
            Text("Removes this board from your profile. Shared board data stays on relays and can be re-joined later.")
        }
    }

    private func addColumn() {
        let trimmed = newColumnName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        columns.append(BoardColumn(id: UUID().uuidString, name: trimmed))
        newColumnName = ""
        setInfo(nil)
    }

    private func deleteColumns(at offsets: IndexSet) {
        columns.remove(atOffsets: offsets)
    }

    private func moveColumns(from source: IndexSet, to destination: Int) {
        columns.move(fromOffsets: source, toOffset: destination)
    }

    private func addCompoundChild(_ option: BoardOption) {
        guard children.contains(where: { $0.id == option.id }) == false else {
            setInfo("Board already added.", error: true)
            return
        }
        children.append(BoardChildSnapshot(id: option.id, name: option.name))
        setInfo(nil)
    }

    private func addCompoundChildFromInput() {
        guard let payload = CompoundChildContract.parse(newCompoundChildInput) else {
            setInfo("Enter a board ID or a Taskify share payload.", error: true)
            return
        }

        let childId = payload.boardId
        guard childId != initialSettings.id else {
            setInfo("Cannot include a board within itself.", error: true)
            return
        }

        if children.contains(where: { $0.id == childId }) {
            setInfo("Board already added.", error: true)
            return
        }

        if let kind = dataController.boardKind(boardId: childId), kind != "lists" {
            setInfo("Only list boards can be added to a compound board.", error: true)
            return
        }

        let resolvedName = availableCompoundBoards.first(where: { $0.id == childId })?.name
            ?? dataController.boardDefinition(boardId: childId)?.name
            ?? payload.boardName
            ?? "Linked board"

        children.append(BoardChildSnapshot(
            id: childId,
            name: resolvedName,
            relayHints: payload.relays
        ))
        newCompoundChildInput = ""

        if payload.relays.isEmpty == false && dataController.boardDefinition(boardId: childId) == nil {
            setInfo("Linked shared board. Columns will load after save.", error: false)
        } else {
            setInfo(nil)
        }
    }

    private func deleteChildren(at offsets: IndexSet) {
        children.remove(atOffsets: offsets)
    }

    private func moveChildren(from source: IndexSet, to destination: Int) {
        children.move(fromOffsets: source, toOffset: destination)
    }

    private func addRelay() {
        let trimmed = newRelay.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if relayHints.contains(trimmed) == false {
            relayHints.append(trimmed)
        }
        newRelay = ""
        setInfo(nil)
    }

    private func republishMetadata() async {
        guard isDirty == false else {
            setInfo("Save changes first to republish updated metadata.", error: true)
            return
        }

        republishing = true
        await dataController.republishBoardMetadata(boardId: initialSettings.id)
        republishing = false
        setInfo("Board metadata republished.", error: false)
    }

    private func saveChanges() async {
        guard trimmedBoardName.isEmpty == false else { return }

        saving = true
        setInfo(nil)

        if isCompoundBoard {
            var resolvedChildren: [BoardChildSnapshot] = []
            for child in children {
                guard let resolved = await dataController.ensureCompoundChildBoard(child) else {
                    saving = false
                    setInfo("Only list boards can be added to a compound board.", error: true)
                    return
                }
                if resolvedChildren.contains(where: { $0.id == resolved.id }) == false {
                    resolvedChildren.append(resolved)
                }
            }
            children = resolvedChildren
        }

        await dataController.updateBoard(
            boardId: initialSettings.id,
            name: trimmedBoardName,
            columns: columns,
            children: isCompoundBoard ? children.map(\.id) : nil,
            clearCompletedDisabled: clearCompletedDisabled,
            indexCardEnabled: indexCardEnabled,
            hideChildBoardNames: isCompoundBoard ? hideChildBoardNames : false,
            relayHints: relayHints
        )

        saving = false
        dismiss()
    }

    private func copyToPasteboard(_ value: String, message: String) {
        PlatformServices.copyToPasteboard(value)
        PlatformServices.notificationSuccess()
        setInfo(message, error: false)
    }

    private func setInfo(_ message: String?, error: Bool = false) {
        infoMessage = message
        infoIsError = error
    }

    private func boardKindLabel(_ kind: String) -> String {
        switch kind {
        case "lists": return "Lists"
        case "compound": return "Compound"
        case "week": return "Week"
        default: return kind.capitalized
        }
    }
}
