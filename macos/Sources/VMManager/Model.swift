import Foundation

struct Auth: Codable, Hashable {
    var kind: String
    var identityFile: String?

    static let password = Auth(kind: "password", identityFile: nil)
    var isKey: Bool { kind == "key" }
}

/// One server as `vm list --json` reports it. The extra fields (keyMissing, hasPassword, sshCommand) are checks the CLI made on this Mac.
struct Server: Decodable, Identifiable, Hashable {
    var id: String { name }
    let name: String
    let group: String
    let env: String
    let host: String
    let port: Int
    let user: String
    let auth: Auth
    let network: String
    let aliases: [String]
    let notes: String
    let agent: String
    let active: Bool
    let keyMissing: Bool
    let hasPassword: Bool?
    let sshCommand: String

    var isProd: Bool { env == "prod" }
    var draft: ServerDraft {
        ServerDraft(name: name, group: group, env: env, host: host, port: port, user: user, auth: auth, network: network, aliases: aliases, notes: notes, agent: agent, active: active)
    }
}

/// The fields of vms.json, sent back to `vm edit --json` / `vm add --json` on stdin.
struct ServerDraft: Codable, Equatable {
    var name: String
    var group: String
    var env: String
    var host: String
    var port: Int
    var user: String
    var auth: Auth
    var network: String
    var aliases: [String]
    var notes: String
    var agent: String
    var active: Bool

    static let blank = ServerDraft(name: "", group: "", env: "dev", host: "", port: 22, user: "", auth: .password, network: "public", aliases: [], notes: "", agent: "read-free-change-approve", active: true)
}

struct Inventory: Decodable {
    struct Networks: Decodable, Equatable {
        struct OpenVPN: Decodable, Equatable {
            let routes: [String]
        }
        let openvpn: OpenVPN?
    }
    let vms: [Server]
    /// Missing from older `vm` builds; treated as "no VPN subnet set".
    let networks: Networks?
    let sshSynced: Bool
    let stateDir: String

    var vpnRoutes: [String] { networks?.openvpn?.routes ?? [] }
}

struct NetworkState: Decodable, Equatable {
    struct OpenVPN: Decodable, Equatable {
        let up: Bool
        let interface: String?
        let via: String?
        let routes: [String]?
    }
    struct Tailscale: Decodable, Equatable {
        let installed: Bool
        let running: Bool
        let tailnet: String?
    }
    let openvpn: OpenVPN
    let tailscale: Tailscale
}

enum Reachability: String, Decodable {
    case reachable, needs_vpn, unreachable
}

struct ServerStatus: Decodable, Hashable {
    let name: String
    let state: Reachability
    let latencyMs: Int?
    let detail: String
}

struct StatusReport: Decodable {
    let checkedAt: String
    let network: NetworkState
    let vms: [ServerStatus]
}

struct Approval: Decodable, Identifiable, Hashable {
    let id: String
    let vm: String
    let env: String
    let command: String
    let requester: String
    let reason: String
    let why: String?
    let status: String
    let createdAt: String
    let expiresAt: String
    let decidedAt: String?
    let decidedBy: String?

    var pending: Bool { status == "pending" }
    var created: Date? { ISO.date(createdAt) }
    var expires: Date? { ISO.date(expiresAt) }
}

struct AuditEntry: Decodable, Identifiable, Hashable {
    var id: String { "\(ts)|\(kind)|\(vm)|\(decision)|\(command)" }
    let ts: String
    let kind: String
    let vm: String
    let command: String
    let requester: String
    let decision: String
    let reason: String?
    let approvalId: String?
    let exitCode: Int?
    let durationMs: Int?
    let outputBytes: Int?

    var date: Date? { ISO.date(ts) }
}

struct PolicyInfo: Decodable {
    struct Policy: Decodable, Identifiable {
        let id: String
        let label: String
    }
    let policies: [Policy]
    let readOnly: [String]
    let hardBlocks: [String]
    let destructive: [String]
}

struct CheckResult: Decodable {
    struct Classification: Decodable {
        let readOnly: Bool
        let reason: String?
    }
    struct Block: Decodable {
        let kind: String
        let rule: String
    }
    struct Decision: Decodable {
        let kind: String
        let reason: String
    }
    let command: String
    let classification: Classification
    let block: Block?
    let decisions: [String: Decision]
}

enum Policy {
    static let all = ["free", "read-free-change-approve", "none"]

    static func title(_ id: String) -> String {
        switch id {
        case "free": "Run anything"
        case "read-free-change-approve": "Read freely, ask before changes"
        case "none": "No agent access"
        default: id
        }
    }

    static func detail(_ id: String) -> String {
        switch id {
        case "free": "Agents run any command that is not on the blocklist. Good for dev servers."
        case "read-free-change-approve": "Read-only commands run right away. Anything else waits until you approve it here."
        case "none": "Agents can’t run anything on this server, not even reads."
        default: ""
        }
    }

    static func symbol(_ id: String) -> String {
        switch id {
        case "free": "bolt.fill"
        case "read-free-change-approve": "hand.raised.fill"
        default: "nosign"
        }
    }
}

enum NetworkKind {
    static let all = ["public", "vpn:openvpn", "tailscale"]

    static func title(_ id: String) -> String {
        switch id {
        case "vpn:openvpn": "OpenVPN Connect"
        case "tailscale": "Tailscale"
        default: "Public internet"
        }
    }
}

enum ISO {
    private static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let plain = ISO8601DateFormatter()

    static func date(_ value: String) -> Date? {
        fractional.date(from: value) ?? plain.date(from: value)
    }
}

enum AppInfo {
    static let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
}

struct CommandError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// Runs the `vm` command-line tool. The app keeps no state of its own: everything goes through the CLI.
enum CLI {
    static let installedBinary = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin/vm")
    static let bundledBinary = Bundle.main.url(forResource: "vm", withExtension: nil)

    static var binary: URL {
        if let override = ProcessInfo.processInfo.environment["VM_MANAGER_BIN"] { return URL(fileURLWithPath: override) }
        if FileManager.default.isExecutableFile(atPath: installedBinary.path) { return installedBinary }
        return bundledBinary ?? installedBinary
    }

    static func run(_ arguments: [String], input: Data? = nil, environment: [String: String] = [:]) async throws -> Data {
        let binary = Self.binary
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let process = Process()
                process.executableURL = binary
                process.arguments = arguments
                process.environment = ProcessInfo.processInfo.environment.merging(environment) { _, new in new }
                let stdout = Pipe()
                let stderr = Pipe()
                let stdin = Pipe()
                process.standardOutput = stdout
                process.standardError = stderr
                process.standardInput = input == nil ? FileHandle.nullDevice : stdin
                do {
                    try process.run()
                } catch {
                    continuation.resume(throwing: CommandError(message: "Couldn’t run \(binary.path). Run `vm install` first."))
                    return
                }
                if let input {
                    // The password goes through this pipe and nowhere else; it is not kept after the write.
                    stdin.fileHandleForWriting.write(input)
                    try? stdin.fileHandleForWriting.close()
                }
                let output = stdout.fileHandleForReading.readDataToEndOfFile()
                let errorOutput = stderr.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                if process.terminationStatus == 0 {
                    continuation.resume(returning: output)
                } else {
                    let message = String(decoding: errorOutput.isEmpty ? output : errorOutput, as: UTF8.self)
                    continuation.resume(throwing: CommandError(message: message.trimmingCharacters(in: .whitespacesAndNewlines)))
                }
            }
        }
    }

    static func decode<T: Decodable>(_ type: T.Type, _ arguments: [String]) async throws -> T {
        try JSONDecoder().decode(type, from: try await run(arguments))
    }
}
