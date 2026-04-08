# Taskify iOS Native

Native iOS implementation of Taskify PWA with complete function parity.

## Tech Stack

- **Language**: Swift 5.9+
- **Framework**: SwiftUI + Combine
- **Nostr SDK**: nostr-sdk-ios (https://github.com/nostr-sdk/nostr-sdk-ios)
- **E-Cash**: CashuSwift (https://github.com/zeugmaster/CashuSwift)
- **Storage**: SwiftData
- **Concurrency**: Swift Concurrency

## Core Modules

### 1. Core Models
- `Task` - Task model with all properties
- `CalendarEvent` - Event model with date/time variants
- `Board` - Board types (week, lists, compound)
- `Recurrence` - Recurrence rules
- `Settings` - User preferences

### 2. Storage Layer
- `TaskifyStore` - SwiftData container
- `TaskRepository` - CRUD operations for tasks
- `EventRepository` - CRUD operations for events
- `BoardRepository` - Board management

### 3. Nostr Client
- `NostrService` - Nostr connection management
- `EventPublisher` - Publishing tasks/events to relays
- `EventSubscriber` - Listening to board updates

### 4. Task Operations
- `TaskManager` - Task CRUD, completion, recurrence
- `BountyManager` - Bounty task management
- `ReminderManager` - Reminder handling

### 5. Calendar Operations
- `EventManager` - Event CRUD, visibility, recurrence
- `CalendarSync` - Syncing with external calendars

### 6. Board Management
- `BoardManager` - Board creation, type management
- `ColumnManager` - List column handling

### 7. Utilities
- `DateUtils` - Date/time manipulation
- `CryptoUtils` - Encryption, hashing
- `NostrUtils` - Nostr helpers

## Testing

- Unit tests for all core operations
- Integration tests for sync operations
- Snapshot tests for UI components
- Async tests for database operations

## Implementation Priority

1. **Phase 1**: Core models and storage layer
2. **Phase 2**: Nostr client and sync infrastructure
3. **Phase 3**: Task operations with parity to PWA
4. **Phase 4**: Calendar event operations
5. **Phase 5**: Board management
6. **Phase 6**: UI layer with SwiftUI
7. **Phase 7**: Comprehensive testing