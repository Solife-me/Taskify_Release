import SwiftUI
import TaskifyCore

struct BoardsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var showCompleted = false

    var body: some View {
        VStack(spacing: 10) {
            header
                .padding(.horizontal, 18)
                .padding(.top, 6)

            WeekBoardView(showCompleted: showCompleted)
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Menu {
                ForEach(model.visibleBoards) { board in
                    Button {
                        model.selectBoard(board.id)
                    } label: {
                        if board.id == model.selectedBoardID {
                            Label(board.name, systemImage: "checkmark")
                        } else {
                            Text(board.name)
                        }
                    }
                }
            } label: {
                HStack(spacing: 8) {
                    Text(model.selectedBoard?.name ?? "Boards")
                        .font(.system(size: 17, weight: .semibold))
                        .lineLimit(1)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 11, weight: .bold))
                }
                .foregroundStyle(TaskifyTheme.primaryText)
                .padding(.horizontal, 16)
                .frame(height: 42)
                .background(TaskifyTheme.raisedFill, in: Capsule())
                .overlay(Capsule().stroke(TaskifyTheme.border, lineWidth: 1))
            }

            Spacer(minLength: 4)

            HeaderIconButton(
                systemName: showCompleted ? "checkmark.circle.fill" : "checkmark",
                accent: showCompleted,
                accessibilityLabel: showCompleted ? "Hide completed tasks" : "Show completed tasks"
            ) {
                withAnimation(.snappy) { showCompleted.toggle() }
            }

            HeaderIconButton(
                systemName: "calendar",
                accessibilityLabel: "Board upcoming"
            ) { }

            HeaderIconButton(
                systemName: "arrow.up.arrow.down",
                accessibilityLabel: "Filter and sort"
            ) { }
        }
    }
}

private struct WeekBoardView: View {
    let showCompleted: Bool

    var body: some View {
        GeometryReader { proxy in
            ScrollView(.horizontal) {
                LazyHStack(spacing: 16) {
                    ForEach(WeekdayColumn.allCases) { weekday in
                        DayColumnView(weekday: weekday, showCompleted: showCompleted)
                            .frame(width: min(330, proxy.size.width - 50))
                    }
                }
                .scrollTargetLayout()
                .padding(.horizontal, 18)
                .padding(.bottom, 10)
            }
            .scrollIndicators(.hidden)
            .scrollTargetBehavior(.viewAligned(limitBehavior: .always))
        }
    }
}

private struct DayColumnView: View {
    @EnvironmentObject private var model: AppModel
    let weekday: WeekdayColumn
    let showCompleted: Bool
    @State private var draft = ""

    private var tasks: [TaskItem] {
        model.tasks(for: weekday, includeCompleted: showCompleted)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(weekday.shortName)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(TaskifyTheme.secondaryText)
                Spacer()
                Menu {
                    Button("Add task") { }
                    Button("Select tasks") { }
                } label: {
                    Image(systemName: "ellipsis")
                        .foregroundStyle(TaskifyTheme.secondaryText)
                        .frame(width: 30, height: 30)
                }
            }

            ScrollView {
                LazyVStack(spacing: 9) {
                    ForEach(tasks) { task in
                        TaskCardView(task: task)
                    }
                }
            }
            .scrollIndicators(.hidden)

            HStack(spacing: 8) {
                TextField("New Task", text: $draft)
                    .textInputAutocapitalization(.sentences)
                    .submitLabel(.done)
                    .onSubmit(addTask)
                    .padding(.horizontal, 16)
                    .frame(height: 46)
                    .background(Color.black.opacity(0.26), in: Capsule())
                    .overlay(Capsule().stroke(TaskifyTheme.border, lineWidth: 1))

                Button(action: addTask) {
                    Image(systemName: "plus")
                        .font(.system(size: 18, weight: .bold))
                        .frame(width: 46, height: 46)
                        .foregroundStyle(.white)
                        .background(TaskifyTheme.accent, in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel("Add task to \(weekday.fullName)")
            }
        }
        .padding(10)
        .taskifyGlass(cornerRadius: 22)
    }

    private func addTask() {
        guard !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        model.addQuickTask(title: draft, weekday: weekday)
        draft = ""
    }
}

struct TaskCardView: View {
    @EnvironmentObject private var model: AppModel
    let task: TaskItem

    var body: some View {
        HStack(spacing: 11) {
            Button {
                withAnimation(.snappy) { model.toggleCompletion(task.id) }
            } label: {
                Image(systemName: task.completed ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 22, weight: .medium))
                    .foregroundStyle(task.completed ? TaskifyTheme.accent : TaskifyTheme.secondaryText)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(task.completed ? "Mark incomplete" : "Complete task")

            VStack(alignment: .leading, spacing: 3) {
                Text(task.title)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(task.completed ? TaskifyTheme.tertiaryText : TaskifyTheme.primaryText)
                    .strikethrough(task.completed)
                    .frame(maxWidth: .infinity, alignment: .leading)

                if !task.note.isEmpty {
                    Text(task.note)
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                        .lineLimit(2)
                }
            }
        }
        .padding(.horizontal, 13)
        .padding(.vertical, 12)
        .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(TaskifyTheme.border, lineWidth: 1)
        )
        .contextMenu {
            Button(role: .destructive) {
                model.deleteTask(task.id)
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }
}
