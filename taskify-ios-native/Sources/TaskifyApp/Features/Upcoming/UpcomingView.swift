import SwiftUI
import TaskifyCore

struct UpcomingView: View {
    @EnvironmentObject private var model: AppModel
    @State private var searchText = ""
    @State private var showingSearch = false
    @State private var showingNewTask = false

    private var tasks: [TaskItem] {
        model.upcomingTasks(searchText: searchText)
    }

    private var groups: [UpcomingGroup] {
        Dictionary(grouping: tasks) { task in
            Calendar.current.startOfDay(for: task.dueDate ?? Date())
        }
        .map { UpcomingGroup(date: $0.key, tasks: $0.value) }
        .sorted { $0.date < $1.date }
    }

    var body: some View {
        VStack(spacing: 10) {
            header
                .padding(.horizontal, 18)
                .padding(.top, 6)

            if showingSearch {
                TextField("Search upcoming tasks", text: $searchText)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 16)
                    .frame(height: 44)
                    .background(TaskifyTheme.raisedFill, in: Capsule())
                    .overlay(Capsule().stroke(TaskifyTheme.border, lineWidth: 1))
                    .padding(.horizontal, 18)
            }

            if groups.isEmpty {
                ContentUnavailableView(
                    "No upcoming tasks",
                    systemImage: "calendar",
                    description: Text("Tasks with dates will appear here.")
                )
                .foregroundStyle(TaskifyTheme.secondaryText)
                .frame(maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(groups) { group in
                            Text(group.date.formatted(.dateTime.weekday(.wide).month(.abbreviated).day()))
                                .font(.system(size: 16, weight: .bold))
                                .foregroundStyle(TaskifyTheme.secondaryText)
                                .padding(.top, 4)

                            ForEach(group.tasks) { task in
                                TaskCardView(task: task)
                            }
                        }
                    }
                    .padding(.horizontal, 18)
                    .padding(.bottom, 14)
                }
                .scrollIndicators(.hidden)
            }
        }
        .sheet(isPresented: $showingNewTask) {
            NewTaskSheet()
                .environmentObject(model)
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Text("Upcoming")
                .font(.system(size: 22, weight: .bold))
                .foregroundStyle(TaskifyTheme.primaryText)

            Spacer()

            HeaderIconButton(systemName: "list.bullet", accessibilityLabel: "Change upcoming view") { }
            HeaderIconButton(systemName: "arrow.up.arrow.down", accessibilityLabel: "Sort upcoming tasks") { }
            HeaderIconButton(
                systemName: showingSearch ? "xmark" : "magnifyingglass",
                accessibilityLabel: showingSearch ? "Close search" : "Search upcoming tasks"
            ) {
                withAnimation(.snappy) {
                    showingSearch.toggle()
                    if !showingSearch { searchText = "" }
                }
            }
            HeaderIconButton(systemName: "plus", accent: true, accessibilityLabel: "Add task") {
                showingNewTask = true
            }
        }
    }
}

private struct UpcomingGroup: Identifiable {
    let date: Date
    let tasks: [TaskItem]
    var id: Date { date }
}

private struct NewTaskSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var dueDate = Date()

    var body: some View {
        NavigationStack {
            Form {
                Section("Task") {
                    TextField("Title", text: $title)
                    DatePicker("Due date", selection: $dueDate, displayedComponents: .date)
                }
            }
            .navigationTitle("New Task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        model.addTask(title: title, dueDate: dueDate)
                        dismiss()
                    }
                    .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .preferredColorScheme(.dark)
    }
}
