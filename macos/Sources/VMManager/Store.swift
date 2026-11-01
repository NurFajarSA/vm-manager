import AppKit
import Foundation
import Observation

enum SettingsRoute: Hashable {
    case server(String)
    case newServer
}

@MainActor
@Observable
final class Store {
    var inventory: Inventory?
    var status: StatusReport?
    var approvals: [Approval] = []
    var audit: [AuditEntry] = []
    var policy: PolicyInfo?
    var loadError: String?
    var busy = false
    var checking = false
    var listHeight: CGFloat?
    /// Set by the panel's "Edit…" so the Settings window opens on that server.
    var requestedRoute: SettingsRoute?
    /// Set by links like "VPN subnet not set" so the Settings window opens on that pane.
    var requestedPane: SettingsPane?

    @ObservationIgnored private var timers: [Timer] = []
    @ObservationIgnored private var watcher: DispatchSourceFileSystemObject?
    @ObservationIgnored private var notified: Set<String> = []

    static let dataFolder: URL = {
        if let custom = ProcessInfo.processInfo.environment["VM_MANAGER_HOME"] { return URL(fileURLWithPath: custom) }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/vm-manager")
    }()
    static let approvalsFolder = dataFolder.appendingPathComponent("approvals")

    var servers: [Server] { inventory?.vms ?? [] }
    var activeServers: [Server] { servers.filter(\.active) }
    var pending: [Approval] { approvals.filter(\.pending) }
    var groups: [String] {
        var seen: [String] = []
        for server in activeServers where !seen.contains(server.group) { seen.append(server.group) }
        return seen
    }

    var vpnRoutes: [String] { inventory?.vpnRoutes ?? [] }

    /// Some active server is behind OpenVPN, but vms.json doesn't say which subnets the VPN routes,
    /// so the app can't tell whether the VPN is on. Older inventories don't have the setting.
    var vpnSubnetMissing: Bool {
        inventory != nil && vpnRoutes.isEmpty && activeServers.contains { $0.network == "vpn:openvpn" }
    }

    func status(of server: Server) -> ServerStatus? {
        status?.vms.first { $0.name == server.name }
    }

    func start() async {
        guard timers.isEmpty else { return }
        Notifier.shared.store = self
        Notifier.shared.attach()
        timers = [
            Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in Task { @MainActor in await self?.reloadInventory() } },
            Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in Task { @MainActor in await self?.refreshStatus() } },
            Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in Task { @MainActor in await self?.reloadApprovals() } },
        ]
        watchApprovals()
        await reload()
        await refreshStatus()
    }

    func reload() async {
        await reloadInventory()
        await reloadApprovals()
    }

    func reloadInventory() async {
        do {
            inventory = try await CLI.decode(Inventory.self, ["list", "--json"])
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }

    func refreshStatus() async {
        guard !checking else { return }
        checking = true
        defer { checking = false }
        if let report = try? await CLI.decode(StatusReport.self, ["status", "--json"]) { status = report }
    }

    func reloadApprovals() async {
        guard let list = try? await CLI.decode([Approval].self, ["approvals", "--json"]) else { return }
        approvals = list
        let waiting = Set(list.filter(\.pending).map(\.id))
        let fresh = list.filter { $0.pending && !notified.contains($0.id) }
        // Demo data for screenshots should never pop real notifications.
        if ProcessInfo.processInfo.environment["VM_MANAGER_BIN"] == nil {
            for approval in fresh { await Notifier.shared.postApproval(approval) }
        }
        Notifier.shared.withdraw(notified.subtracting(waiting))
        notified = waiting
    }

    func loadAudit() async {
        audit = (try? await CLI.decode([AuditEntry].self, ["audit", "--json", "--limit", "500"])) ?? audit
    }

    func loadPolicy() async {
        policy = try? await CLI.decode(PolicyInfo.self, ["policy", "--json"])
    }

    func check(_ command: String) async -> CheckResult? {
        guard !command.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        return try? await CLI.decode(CheckResult.self, ["check", "--json", "--", command])
    }

    /// Reloads approvals as soon as a request file appears or changes, instead of waiting for the timer.
    private func watchApprovals() {
        try? FileManager.default.createDirectory(at: Self.approvalsFolder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let fd = open(Self.approvalsFolder.path, O_EVTONLY)
        guard fd >= 0 else { return }
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .extend, .rename], queue: .main)
        source.setEventHandler { [weak self] in Task { @MainActor in await self?.reloadApprovals() } }
        source.setCancelHandler { close(fd) }
        source.resume()
        watcher = source
    }

    // MARK: Approvals

    func approve(_ approval: Approval) async {
        await decide(approval, "approve")
    }

    func deny(_ approval: Approval) async {
        await decide(approval, "deny")
    }

    func approve(id: String) async {
        if let approval = approvals.first(where: { $0.id == id }) { await approve(approval) } else { await decide(id: id, "approve") }
    }

    func deny(id: String) async {
        if let approval = approvals.first(where: { $0.id == id }) { await deny(approval) } else { await decide(id: id, "deny") }
    }

    private func decide(_ approval: Approval, _ verb: String) async {
        await decide(id: approval.id, verb)
    }

    private func decide(id: String, _ verb: String) async {
        do {
            _ = try await CLI.run([verb, id], environment: ["VM_MANAGER_DECIDED_BY": "app"])
        } catch {
            Dialog.warn(title: verb == "approve" ? "Couldn’t approve" : "Couldn’t deny", message: error.localizedDescription)
        }
        await reloadApprovals()
    }

    // MARK: Servers

    func save(_ draft: ServerDraft, replacing original: String?) async -> Bool {
        busy = true
        defer { busy = false }
        do {
            let data = try JSONEncoder().encode(draft)
            let arguments = original.map { ["edit", $0, "--json"] } ?? ["add", draft.name, "--json"]
            _ = try await CLI.run(arguments, input: data)
            await reloadInventory()
            return true
        } catch {
            Dialog.warn(title: "Couldn’t save \(draft.name.isEmpty ? "the server" : draft.name)", message: error.localizedDescription)
            return false
        }
    }

    func setPolicy(_ server: Server, _ policy: String) async {
        await perform(["edit", server.name, "--agent", policy])
    }

    func savePassword(_ server: Server, _ password: String) async -> Bool {
        busy = true
        defer { busy = false }
        do {
            _ = try await CLI.run(["password", server.name, "--stdin"], input: Data(password.utf8))
            await reloadInventory()
            return true
        } catch {
            Dialog.warn(title: "Couldn’t save the password", message: error.localizedDescription)
            return false
        }
    }

    func removePassword(_ server: Server) async {
        guard Dialog.confirm(
            title: "Remove the password for \(server.name)?",
            message: "VM Manager deletes it from the Keychain. You’ll need to save it again to connect.",
            confirm: "Remove",
            cancel: "Cancel"
        ) else { return }
        await perform(["password", server.name, "--delete"])
    }

    func remove(_ server: Server) async -> Bool {
        guard Dialog.confirm(
            title: "Remove \(server.name)?",
            message: "It disappears from VM Manager, and its saved password is deleted from the Keychain. Run Write SSH Config afterwards to drop it from ~/.ssh/config.",
            confirm: "Remove",
            cancel: "Cancel"
        ) else { return false }
        await perform(["remove", server.name])
        return true
    }

    func syncSSH() async {
        guard Dialog.confirm(
            title: "Write your servers to ~/.ssh/config?",
            message: "VM Manager writes ~/.ssh/config.d/vm-manager.conf and adds an Include line at the top of ~/.ssh/config, after making a backup. Then `ssh <name>` works in any terminal or editor.",
            confirm: "Write SSH Config",
            cancel: "Cancel"
        ) else { return }
        await perform(["sync-ssh"], report: "SSH config written")
    }

    /// Replaces the OpenVPN subnets in vms.json; an empty list removes the setting.
    func setVpnRoutes(_ routes: [String]) async -> Bool {
        busy = true
        defer { busy = false }
        do {
            _ = try await CLI.run(["vpn-routes"] + (routes.isEmpty ? ["--clear"] : routes))
            await reloadInventory()
            await refreshStatus()
            return true
        } catch {
            Dialog.warn(title: "Couldn’t save the VPN subnets", message: error.localizedDescription)
            return false
        }
    }

    func setLoginItem(_ on: Bool) async {
        await perform(["login-item", on ? "on" : "off"])
    }

    // MARK: Connecting

    func openTerminal(_ server: Server) {
        if server.sshCommand.hasPrefix("ssh ") {
            runInTerminal(name: server.name, command: ["/usr/bin/ssh", server.name])
        } else {
            runInTerminal(name: server.name, command: [CLI.binary.path, "ssh", server.name])
        }
    }

    func keySetup(_ server: Server) {
        runInTerminal(name: "key-setup-\(server.name)", command: [CLI.binary.path, "key-setup", server.name], keepOpen: true)
    }

    func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    func openInZed(_ server: Server) {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = ["\(home)/.local/bin/zed", "/usr/local/bin/zed", "/opt/homebrew/bin/zed", "/Applications/Zed.app/Contents/MacOS/cli"]
        guard let zed = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            Dialog.warn(title: "Zed isn’t installed", message: "Install Zed and its command-line tool (zed: Install CLI), then try again.")
            return
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: zed)
        process.arguments = ["ssh://\(server.name)/"]
        do { try process.run() } catch { Dialog.warn(title: "Couldn’t open Zed", message: error.localizedDescription) }
    }

    func showDataFolder() {
        NSWorkspace.shared.open(Self.dataFolder)
    }

    var headline: String {
        pending.isEmpty ? "" : "\(pending.count)"
    }

    private func perform(_ arguments: [String], report title: String? = nil) async {
        busy = true
        defer { busy = false }
        do {
            let output = String(decoding: try await CLI.run(arguments), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            if let title { Dialog.inform(title: title, message: output) }
        } catch {
            Dialog.warn(title: "That didn’t work", message: error.localizedDescription)
        }
        await reloadInventory()
    }

    /// Opens Terminal on a throwaway .command script, the same way the sign-in flows in Accounts Manager do.
    private func runInTerminal(name: String, command: [String], keepOpen: Bool = false) {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("vm-manager", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let script = folder.appendingPathComponent("\(name).command")
        let quoted = command.map { "'" + $0.replacingOccurrences(of: "'", with: "'\\''") + "'" }.joined(separator: " ")
        let body = keepOpen
            ? "#!/bin/zsh -l\n\(quoted)\necho\necho 'Done. You can close this window.'\n"
            : "#!/bin/zsh -l\nclear\nexec \(quoted)\n"
        do {
            try body.write(to: script, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: script.path)
            NSWorkspace.shared.open(script)
        } catch {
            Dialog.warn(title: "Couldn’t open Terminal", message: error.localizedDescription)
        }
    }
}

@MainActor
enum Dialog {
    static func confirm(title: String, message: String, confirm: String, cancel: String) -> Bool {
        make(title: title, message: message, buttons: [confirm, cancel]).runModal() == .alertFirstButtonReturn
    }

    static func inform(title: String, message: String) {
        make(title: title, message: message, buttons: ["OK"]).runModal()
    }

    static func warn(title: String, message: String) {
        let alert = make(title: title, message: message, buttons: ["OK"])
        alert.alertStyle = .warning
        alert.runModal()
    }

    private static func make(title: String, message: String, buttons: [String]) -> NSAlert {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        buttons.forEach { alert.addButton(withTitle: $0) }
        return alert
    }
}
