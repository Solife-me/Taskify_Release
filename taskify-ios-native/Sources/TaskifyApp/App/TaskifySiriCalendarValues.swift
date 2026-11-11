import AppIntents
import Foundation
import GeoToolbox

#if os(iOS) || (TASKIFY_MAC_SHORTCUTS && !TASKIFY_MAC_UI_TEST)
@available(iOS 27.0, macOS 27.0, *)
@UnionValue
enum TaskifySiriEventLocation {
    case place(GeoToolbox.PlaceDescriptor)
    case text(String)
}

@available(iOS 27.0, macOS 27.0, *)
extension TaskifySiriEventLocation {
    static var typeDisplayRepresentation: TypeDisplayRepresentation { "Event location" }
    static let caseDisplayRepresentations: [Cases: DisplayRepresentation] = [
        .place: "Place",
        .text: "Location"
    ]

    var taskifyValue: String {
        switch self {
        case .place(let place):
            place.commonName ?? place.address ?? place.description
        case .text(let value):
            value
        }
    }
}

@available(iOS 27.0, macOS 27.0, *)
@UnionValue
enum TaskifySiriEventAlarm {
    case duration(Duration)
    case date(Date)
}

@available(iOS 27.0, macOS 27.0, *)
extension TaskifySiriEventAlarm {
    static var typeDisplayRepresentation: TypeDisplayRepresentation { "Event alarm" }
    static let caseDisplayRepresentations: [Cases: DisplayRepresentation] = [
        .duration: "Time before event",
        .date: "Date"
    ]
}

@available(iOS 27.0, macOS 27.0, *)
@AppEnum(schema: .calendar.attendeeStatus)
enum TaskifySiriParticipantStatus: String {
    case accepted
    case declined
    case tentative

    static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .accepted: "Accepted",
        .declined: "Declined",
        .tentative: "Tentative"
    ]
}

@available(iOS 27.0, macOS 27.0, *)
@AppEnum(schema: .calendar.attendeeType)
enum TaskifySiriAttendeeType: String {
    case person

    static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .person: "Person"
    ]
}

@available(iOS 27.0, macOS 27.0, *)
@AppEnum(schema: .calendar.eventStatus)
enum TaskifySiriEventStatus: String {
    case confirmed
    case tentative
    case cancelled

    static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .confirmed: "Confirmed",
        .tentative: "Tentative",
        .cancelled: "Cancelled"
    ]
}
#endif
