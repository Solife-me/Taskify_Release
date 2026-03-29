import Foundation

public protocol SecureStore {
    func set(_ data: Data, key: String) throws
    func get(key: String) throws -> Data?
    func delete(key: String) throws
}
