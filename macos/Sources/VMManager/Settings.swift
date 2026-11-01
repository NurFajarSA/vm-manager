import AppKit
import SwiftUI

enum SettingsPane: String, CaseIterable, Identifiable, Hashable {
    case general, servers, agent, approvals, audit, network, about

    var id: String { rawValue }

    var title: String {
        switch self {
        case .general: "General"
        case .servers: "Servers"
        case .agent: "Agent Access"
        case .approvals: "Approvals"
        case .audit: "Audit Log"
        case .network: "Network"
        case .about: "About"
        }
    }

    var summary: String {
        switch self {
        case .general: "Start at login, notifications, and the SSH config VM Manager writes for you."
        case .servers: "Every server you manage, with its address, login and notes, in one list."
        case .agent: "What Claude agents may do on each server. Reads run freely; changes on production wait for you."
        case .approvals: "Commands agents asked to run on servers that need your approval."
        case .audit: "Every command agents ran or tried to run, with who asked and what happened. No output, no secrets."
        case .network: "Some servers are only reachable over OpenVPN Connect or Tailscale."
        case .about: "Your SSH servers in one place, with supervised access for Claude."
        }
    }

    var symbol: String {
        switch self {
        case .general: "gearshape.fill"
        case .servers: "server.rack"
        case .agent: "lock.shield.fill"
        case .approvals: "checkmark.seal.fill"
        case .audit: "list.bullet.rectangle.fill"
        case .network: "network"
        case .about: "info.circle.fill"
        }
    }

    var color: Color {
        switch self {
        case .general: .gray
        case .servers: .blue
        case .agent: .indigo
        case .approvals: .orange
        case .audit: .teal
        case .network: .green
        case .about: .blue
        }
    }

    var keywords: [String] {
        switch self {
        case .general: ["login", "startup", "notifications", "ssh config", "files"]
        case .servers: ["host", "ip", "user", "password", "key", "add", "remove", "vm"]
        case .agent: ["policy", "claude", "mcp", "blocklist", "read-only", "free"]
        case .approvals: ["approve", "deny", "pending", "request"]
        case .audit: ["log", "history", "commands"]
        case .network: ["vpn", "openvpn", "subnet", "route", "tailscale", "reachable"]
        case .about: ["version"]
        }
    }

    static let main: [SettingsPane] = [.general, .servers, .agent, .approvals, .audit, .network]
}

struct SettingsView: View {
    let store: Store
    @AppStorage("settingsPane") private var pane: SettingsPane = .general
    @State private var query = ""
    @State private var path: [SettingsRoute] = []
    @State private var back: [SettingsPane] = []
    @State private var forward: [SettingsPane] = []

    var body: some View {
        NavigationSplitView {
            List(selection: Binding(get: { pane }, set: { if let next = $0 { select(next) } })) {
                Section {
                    ForEach(filtered(SettingsPane.main)) { pane in
                        SidebarRow(pane: pane, badge: pane == .approvals ? store.pending.count : 0).tag(pane)
                    }
                }
                if !filtered([.about]).isEmpty {
                    Section("VM Manager") {
                        SidebarRow(pane: .about).tag(SettingsPane.about)
                    }
                }
            }
            .listStyle(.sidebar)
            .frame(minWidth: 215)
            .searchable(text: $query, placement: .sidebar)
            .navigationSplitViewColumnWidth(min: 220, ideal: 230, max: 280)
            .toolbar(removing: .sidebarToggle)
        } detail: {
            NavigationStack(path: $path) {
                PaneContent(store: store, pane: pane)
                    .navigationTitle(pane.title)
                    .toolbar { navigationButtons }
                    .navigationDestination(for: SettingsRoute.self) { route in
                        Group {
                            switch route {
                            case let .server(name): ServerDetail(store: store, original: name)
                            case .newServer: ServerDetail(store: store, original: nil)
                            }
                        }
                        .toolbar { navigationButtons }
                        .navigationBarBackButtonHidden(true)
                    }
            }
        }
        .frame(minWidth: 860, minHeight: 560)
        .task {
            await store.reload()
            openRequestedRoute()
            openRequestedPane()
            if let route = ProcessInfo.processInfo.environment["VM_MANAGER_OPEN_ROUTE"] {
                pane = .servers
                path = [route == "new" ? .newServer : .server(route)]
            }
        }
        .onChange(of: store.requestedRoute) { _, _ in openRequestedRoute() }
        .onChange(of: store.requestedPane) { _, _ in openRequestedPane() }
        .appWindowPresence()
    }

    private func openRequestedPane() {
        guard let requested = store.requestedPane else { return }
        store.requestedPane = nil
        select(requested)
    }

    private func openRequestedRoute() {
        guard let route = store.requestedRoute else { return }
        store.requestedRoute = nil
        select(.servers)
        path = [route]
    }

    @ToolbarContentBuilder
    private var navigationButtons: some ToolbarContent {
        ToolbarItem(placement: .navigation) {
            ControlGroup {
                Button(action: goBack) { Label("Back", systemImage: "chevron.left") }
                    .disabled(path.isEmpty && back.isEmpty)
                Button(action: goForward) { Label("Forward", systemImage: "chevron.right") }
                    .disabled(forward.isEmpty)
            }
            .controlGroupStyle(.navigation)
        }
    }

    private func filtered(_ panes: [SettingsPane]) -> [SettingsPane] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return panes }
        return panes.filter { $0.title.lowercased().contains(q) || $0.keywords.contains { $0.contains(q) } }
    }

    private func select(_ next: SettingsPane) {
        guard next != pane else {
            path.removeAll()
            return
        }
        back.append(pane)
        forward.removeAll()
        path.removeAll()
        pane = next
    }

    private func goBack() {
        if !path.isEmpty {
            path.removeLast()
        } else if let previous = back.popLast() {
            forward.append(pane)
            pane = previous
        }
    }

    private func goForward() {
        guard let next = forward.popLast() else { return }
        back.append(pane)
        path.removeAll()
        pane = next
    }
}

struct SidebarRow: View {
    let pane: SettingsPane
    var badge = 0

    var body: some View {
        Label {
            Text(pane.title)
        } icon: {
            Image(systemName: pane.symbol).foregroundStyle(pane.color)
        }
        .badge(badge)
    }
}

struct AppIconTile: View {
    let symbol: String
    let color: Color
    var size: CGFloat = 20

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: size * 0.5, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(RoundedRectangle(cornerRadius: size * 0.24, style: .continuous).fill(color.gradient))
            .accessibilityHidden(true)
    }
}

struct HeroSection: View {
    let symbol: String
    let color: Color
    let title: String
    let summary: String

    var body: some View {
        Section {
            HStack(alignment: .center, spacing: 12) {
                AppIconTile(symbol: symbol, color: color, size: 44)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.system(size: 13, weight: .semibold))
                    Text(summary).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.vertical, 4)
        }
    }
}

struct PaneContent: View {
    let store: Store
    let pane: SettingsPane

    var body: some View {
        switch pane {
        case .about:
            AboutPane()
        case .audit:
            AuditPane(store: store)
        default:
            if store.inventory != nil {
                Form {
                    HeroSection(symbol: pane.symbol, color: pane.color, title: pane.title, summary: pane.summary)
                    switch pane {
                    case .general: GeneralPane(store: store)
                    case .servers: ServersPane(store: store)
                    case .agent: AgentPane(store: store)
                    case .approvals: ApprovalsPane(store: store)
                    case .network: NetworkPane(store: store)
                    case .audit, .about: EmptyView()
                    }
                }
                .formStyle(.grouped)
            } else if let message = store.loadError {
                ContentUnavailableView("Couldn’t load servers", systemImage: "exclamationmark.triangle", description: Text(message))
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }
}

// MARK: General

struct GeneralPane: View {
    let store: Store
    @State private var launchAtLogin = LoginItem.isEnabled
    @AppStorage(Notifier.enabledKey) private var notificationsEnabled = true

    var body: some View {
        Section {
            Toggle(isOn: Binding(get: { launchAtLogin }, set: { on in
                launchAtLogin = on
                Task {
                    await store.setLoginItem(on)
                    launchAtLogin = LoginItem.isEnabled
                }
            })) {
                Text("Launch at Login")
                Text("Show VM Manager in the menu bar when you log in.")
            }
        }
        Section {
            Toggle(isOn: $notificationsEnabled) {
                Text("Notifications")
                Text("Tell me when an agent asks to run a command that needs my approval. Approve or deny right from the notification.")
            }
        }
        Section {
            LabeledContent {
                Button(store.inventory?.sshSynced == true ? "Write Again" : "Write SSH Config…") { Task { await store.syncSSH() } }
            } label: {
                Text("SSH config")
                Text(store.inventory?.sshSynced == true ? "Up to date. `ssh <name>` works in any terminal or editor." : "Not written yet, or out of date. Writing it lets `ssh <name>` work everywhere.")
            }
        } header: {
            Text("SSH")
        } footer: {
            Text("VM Manager writes ~/.ssh/config.d/vm-manager.conf and puts one Include line at the top of ~/.ssh/config, after a backup. Passwords never go in there.")
        }
        Section("Files") {
            LabeledContent("Command-line tool", value: CLI.binary.path.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
            LabeledContent("Data folder") {
                Button("Show in Finder") { store.showDataFolder() }
            }
        }
    }
}

enum LoginItem {
    static var isEnabled: Bool {
        FileManager.default.fileExists(
            atPath: FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents/app.vm-manager.menubar.plist").path
        )
    }
}

// MARK: Servers

struct ServersPane: View {
    let store: Store

    var body: some View {
        ForEach(store.groups, id: \.self) { group in
            Section(group) {
                ForEach(store.activeServers.filter { $0.group == group }) { ServerLink(store: store, server: $0) }
            }
        }
        let inactive = store.servers.filter { !$0.active }
        if !inactive.isEmpty {
            Section {
                ForEach(inactive) { ServerLink(store: store, server: $0) }
            } header: {
                Text("Inactive")
            } footer: {
                Text("Kept so the addresses aren’t forgotten. They don’t show in ~/.ssh/config, and agents can’t reach them.")
            }
        }
        Section {
            NavigationLink(value: SettingsRoute.newServer) {
                Label("Add Server…", systemImage: "plus")
            }
        }
    }
}

struct ServerLink: View {
    let store: Store
    let server: Server

    var body: some View {
        NavigationLink(value: SettingsRoute.server(server.name)) {
            LabeledContent {
                HStack(spacing: 8) {
                    EnvBadge(env: server.env)
                    StatusDot(state: server.active ? store.status(of: server)?.state : nil, network: server.network)
                }
            } label: {
                Text(server.name)
                Text(subtitle).foregroundStyle(server.keyMissing || server.hasPassword == false ? Color.orange : Color.secondary)
            }
        }
    }

    private var subtitle: String {
        var parts = ["\(server.user)@\(server.host)"]
        if server.keyMissing { parts.append("⚠️ Key file missing") }
        if server.hasPassword == false { parts.append("No password saved") }
        return parts.joined(separator: " · ")
    }
}

struct ServerDetail: View {
    let store: Store
    /// The server's name when it was opened; nil for a new one.
    let original: String?
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ServerDraft.blank
    @State private var loaded = false
    @State private var portText = "22"
    @State private var aliasText = ""
    @State private var password = ""
    @State private var savingPassword = false

    private var server: Server? { original.flatMap { name in store.servers.first { $0.name == name } } }

    var body: some View {
        Form {
            HeroSection(
                symbol: "server.rack",
                color: draft.env == "prod" ? .red : .green,
                title: original == nil ? "New Server" : draft.name,
                summary: draft.host.isEmpty ? "Fill in the address and login, then save." : "\(draft.user)@\(draft.host)\(draft.port == 22 ? "" : ":\(draft.port)") · \(NetworkKind.title(draft.network))"
            )
            Section("Server") {
                TextField("Name", text: $draft.name, prompt: Text("shop-web-prod"))
                TextField("Group", text: $draft.group, prompt: Text("UI"))
                Picker("Environment", selection: $draft.env) {
                    Text("Production").tag("prod")
                    Text("Development").tag("dev")
                }
                .pickerStyle(.segmented)
                TextField("Address", text: $draft.host, prompt: Text("192.0.2.10"))
                TextField("Port", text: $portText, prompt: Text("22"))
                TextField("Other hostnames", text: $aliasText, prompt: Text("payment.example.com"))
                Picker("Network", selection: $draft.network) {
                    ForEach(NetworkKind.all, id: \.self) { Text(NetworkKind.title($0)).tag($0) }
                }
                Toggle("Active", isOn: $draft.active)
            }
            Section {
                TextField("User", text: $draft.user, prompt: Text("deploy"))
                Picker("Sign in with", selection: Binding(get: { draft.auth.kind }, set: { kind in
                    draft.auth = kind == "key" ? Auth(kind: "key", identityFile: draft.auth.identityFile ?? "~/.ssh/id_ed25519") : .password
                })) {
                    Text("SSH key").tag("key")
                    Text("Password").tag("password")
                }
                if draft.auth.isKey {
                    LabeledContent {
                        HStack {
                            TextField("Key file", text: Binding(get: { draft.auth.identityFile ?? "" }, set: { draft.auth.identityFile = $0 }), prompt: Text("~/.ssh/id_ed25519"))
                                .labelsHidden()
                            Button("Choose…") { chooseKey() }
                        }
                    } label: {
                        Text("Key file")
                        if server?.keyMissing == true && server?.auth == draft.auth {
                            Text("⚠️ This file is missing on this Mac.").foregroundStyle(.orange)
                        }
                    }
                }
            } header: {
                Text("Login")
            } footer: {
                if !draft.auth.isKey {
                    Text("The password lives in your Keychain. VM Manager hands it to ssh when it connects, so you and agents never see it.")
                }
            }
            if let server, server.auth.kind == "password", !draft.auth.isKey {
                Section {
                    LabeledContent("Saved", value: server.hasPassword == true ? "Yes, in the Keychain" : "No")
                    LabeledContent {
                        HStack {
                            SecureField("Password", text: $password, prompt: Text(server.hasPassword == true ? "Enter a new password" : "Enter the password"))
                                .labelsHidden()
                                .onSubmit(savePassword)
                            Button(server.hasPassword == true ? "Replace" : "Save", action: savePassword)
                                .disabled(password.isEmpty || savingPassword)
                        }
                    } label: {
                        Text("Password")
                    }
                    if server.hasPassword == true {
                        LabeledContent {
                            Button("Set Up Key Login…") { store.keySetup(server) }
                        } label: {
                            Text("Switch to a key")
                            Text("Copies an SSH key to the server with this password, then signs in with the key from now on. Opens Terminal.")
                        }
                        Button("Remove Password…", role: .destructive) { Task { await store.removePassword(server) } }
                    }
                } header: {
                    Text("Password")
                }
            }
            Section {
                Picker(selection: $draft.agent) {
                    ForEach(Policy.all, id: \.self) { Text(Policy.title($0)).tag($0) }
                } label: {
                    Text("Agents may")
                    Text(Policy.detail(draft.agent))
                }
            } header: {
                Text("Agent access")
            }
            Section("Notes") {
                TextField("Notes", text: $draft.notes, prompt: Text("What runs here, where the app lives, who to ask"), axis: .vertical)
                    .lineLimit(3...8)
                    .labelsHidden()
            }
            Section {
                HStack {
                    if let server {
                        Button("Open in Terminal") { store.openTerminal(server) }
                        Button("Remove Server…", role: .destructive) {
                            Task { if await store.remove(server) { dismiss() } }
                        }
                    }
                    Spacer()
                    if original != nil {
                        Button("Revert") { load() }.disabled(!dirty)
                    }
                    Button(original == nil ? "Add Server" : "Save") { save() }
                        .buttonStyle(.borderedProminent)
                        .disabled(!dirty || draft.name.isEmpty || draft.host.isEmpty || draft.user.isEmpty || store.busy)
                        .keyboardShortcut("s", modifiers: .command)
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle(original == nil ? "New Server" : (server?.name ?? "Server"))
        .onAppear { if !loaded { load() } }
    }

    private var edited: ServerDraft {
        var next = draft
        next.port = Int(portText.trimmingCharacters(in: .whitespaces)) ?? 0
        next.aliases = aliasText.split(whereSeparator: { $0 == "," || $0 == " " }).map(String.init).filter { !$0.isEmpty }
        next.name = next.name.trimmingCharacters(in: .whitespaces)
        next.host = next.host.trimmingCharacters(in: .whitespaces)
        next.user = next.user.trimmingCharacters(in: .whitespaces)
        next.group = next.group.trimmingCharacters(in: .whitespaces).isEmpty ? "Other" : next.group.trimmingCharacters(in: .whitespaces)
        return next
    }

    private var dirty: Bool {
        guard let server else { return true }
        return edited != server.draft
    }

    private func load() {
        loaded = true
        draft = server?.draft ?? ServerDraft.blank
        portText = String(draft.port)
        aliasText = draft.aliases.joined(separator: ", ")
    }

    private func save() {
        let next = edited
        Task {
            if await store.save(next, replacing: original) {
                if original == nil || next.name != original { dismiss() } else { load() }
            }
        }
    }

    private func savePassword() {
        guard let server, !password.isEmpty else { return }
        savingPassword = true
        let value = password
        password = ""
        Task {
            _ = await store.savePassword(server, value)
            savingPassword = false
        }
    }

    private func chooseKey() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.showsHiddenFiles = true
        panel.directoryURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".ssh")
        panel.prompt = "Use Key"
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        draft.auth.identityFile = url.path.replacingOccurrences(of: NSHomeDirectory(), with: "~")
    }
}

// MARK: Agent access

struct AgentPane: View {
    let store: Store
    @State private var trial = ""
    @State private var result: CheckResult?

    var body: some View {
        Section {
            ForEach(Policy.all, id: \.self) { id in
                LabeledContent {
                    Text("\(store.activeServers.filter { $0.agent == id }.count)").monospacedDigit().foregroundStyle(.secondary)
                } label: {
                    Label {
                        Text(Policy.title(id))
                        Text(Policy.detail(id))
                    } icon: {
                        AppIconTile(symbol: Policy.symbol(id), color: id == "free" ? .green : id == "none" ? .gray : .orange, size: 22)
                    }
                }
            }
        } header: {
            Text("Policies")
        } footer: {
            Text("Claude reaches your servers only through the vm-manager MCP server, which `vm install` registers. Every command is checked here first and written to the audit log.")
        }
        Section("Servers") {
            ForEach(store.activeServers) { server in
                Picker(selection: Binding(get: { server.agent }, set: { value in Task { await store.setPolicy(server, value) } })) {
                    ForEach(Policy.all, id: \.self) { Text(Policy.title($0)).tag($0) }
                } label: {
                    HStack(spacing: 6) {
                        Text(server.name)
                        EnvBadge(env: server.env)
                    }
                }
            }
        }
        if let policy = store.policy {
            Section {
                ForEach(policy.readOnly, id: \.self) { Text($0).font(.callout) }
            } header: {
                Text("Read-only commands")
            } footer: {
                Text("A command is read-only only when it starts with one of these and has no ; | & > < $ ( ) ` \\ or line breaks. sudo makes any command a change.")
            }
            Section {
                LabeledContent("Always refused", value: policy.hardBlocks.joined(separator: ", "))
                LabeledContent("Needs confirmation and approval", value: policy.destructive.joined(separator: ", "))
            } header: {
                Text("Blocklist")
            } footer: {
                Text("The blocklist catches the worst mistakes even if you approve. It can’t recognise every way to write a command, so approval stays the real check on production.")
            }
        }
        Section {
            TextField("Command", text: $trial, prompt: Text("docker compose restart api"))
                .font(.system(.body, design: .monospaced))
                .onSubmit { Task { result = await store.check(trial) } }
            if let result {
                LabeledContent("Read-only", value: result.classification.readOnly ? "Yes" : "No — \(result.classification.reason ?? "")")
                if let block = result.block {
                    LabeledContent(block.kind == "hard" ? "Blocked" : "Destroys data", value: block.rule)
                }
                ForEach(Policy.all, id: \.self) { id in
                    if let decision = result.decisions[id] {
                        LabeledContent(Policy.title(id), value: describe(decision))
                    }
                }
            }
        } header: {
            Text("Try a command")
        } footer: {
            Text("Press Return to see how VM Manager would treat it under each policy. Nothing runs.")
        }
        .task { await store.loadPolicy() }
    }

    private func describe(_ decision: CheckResult.Decision) -> String {
        switch decision.kind {
        case "run": "Runs"
        case "approve": "Asks you first"
        default: "Refused"
        }
    }
}

// MARK: Approvals

struct ApprovalsPane: View {
    let store: Store

    var body: some View {
        Section {
            if store.pending.isEmpty {
                Text("Nothing is waiting.").foregroundStyle(.secondary)
            }
            ForEach(store.pending) { ApprovalCard(store: store, approval: $0) }
        } header: {
            Text("Waiting")
        } footer: {
            Text("A request waits 10 minutes. If nobody answers, it expires and the command doesn’t run.")
        }
        let recent = store.approvals.filter { !$0.pending }.prefix(20)
        if !recent.isEmpty {
            Section("Recent") {
                ForEach(Array(recent)) { approval in
                    LabeledContent {
                        StatusBadge(text: approval.status.capitalized, color: approval.status == "approved" ? .green : approval.status == "denied" ? .red : .secondary)
                    } label: {
                        Text(approval.command).font(.system(.body, design: .monospaced)).lineLimit(1).truncationMode(.middle)
                        Text("\(approval.vm) · \(approval.requester) · \(approval.created?.formatted(date: .abbreviated, time: .shortened) ?? approval.createdAt)")
                    }
                }
            }
        }
    }
}

struct StatusBadge: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Capsule().fill(color.opacity(0.15)))
    }
}

// MARK: Audit log

struct AuditPane: View {
    let store: Store
    @State private var filter = ""
    @State private var sort = [KeyPathComparator(\AuditEntry.ts, order: .reverse)]

    private var rows: [AuditEntry] {
        let q = filter.trimmingCharacters(in: .whitespaces).lowercased()
        let matching = q.isEmpty ? store.audit : store.audit.filter {
            $0.vm.lowercased().contains(q) || $0.command.lowercased().contains(q) || $0.decision.contains(q) || $0.requester.lowercased().contains(q)
        }
        return matching.sorted(using: sort)
    }

    var body: some View {
        Group {
            if store.audit.isEmpty {
                ContentUnavailableView("Nothing logged yet", systemImage: "list.bullet.rectangle", description: Text("Commands agents run or try to run on your servers appear here."))
            } else {
                Table(rows, sortOrder: $sort) {
                    TableColumn("Time", value: \.ts) { entry in
                        Text(entry.date.map(Self.time) ?? entry.ts).monospacedDigit()
                    }
                    .width(min: 64, ideal: 80)
                    TableColumn("Server", value: \.vm).width(min: 100, ideal: 130)
                    TableColumn("Command", value: \.command) { entry in
                        VStack(alignment: .leading, spacing: 1) {
                            Text(entry.command).font(.system(.body, design: .monospaced)).lineLimit(1)
                            Text(entry.kind == "approval" ? "Decided in \(entry.requester)" : "Asked by \(entry.requester)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        .help(entry.command)
                    }
                    .width(min: 160, ideal: 240)
                    TableColumn("Result", value: \.decision) { entry in
                        DecisionBadge(entry: entry).help(entry.reason ?? "")
                    }
                    .width(min: 70, ideal: 76)
                    TableColumn("Exit") { entry in
                        Text(entry.exitCode.map(String.init) ?? "–").monospacedDigit().foregroundStyle(entry.exitCode.map { $0 == 0 ? Color.primary : Color.orange } ?? Color.secondary)
                    }
                    .width(min: 28, ideal: 32)
                    TableColumn("Took") { entry in
                        Text(entry.durationMs.map { String(format: "%.1f s", Double($0) / 1000) } ?? "–").monospacedDigit()
                    }
                    .width(min: 44, ideal: 50)
                    TableColumn("Output") { entry in
                        Text(entry.outputBytes.map(Self.size) ?? "–").monospacedDigit()
                    }
                    .width(min: 62, ideal: 70)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                TextField("Filter", text: $filter, prompt: Text("Filter"))
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 160)
                Button("Show File", systemImage: "doc.text.magnifyingglass") {
                    NSWorkspace.shared.activateFileViewerSelecting([Store.dataFolder.appendingPathComponent("audit.jsonl")])
                }
                .help("Show audit.jsonl in Finder")
            }
        }
        .task { await store.loadAudit() }
    }

    static func time(_ date: Date) -> String {
        Calendar.current.isDateInToday(date)
            ? date.formatted(date: .omitted, time: .shortened)
            : date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
    }

    static func size(_ bytes: Int) -> String {
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        formatter.allowsNonnumericFormatting = false
        return formatter.string(fromByteCount: Int64(bytes))
    }
}

struct DecisionBadge: View {
    let entry: AuditEntry

    var body: some View {
        StatusBadge(text: label, color: color)
    }

    private var label: String {
        switch (entry.kind, entry.decision) {
        case ("approval", "approved"): "Approved"
        case ("approval", "denied"): "Denied"
        case (_, "allowed"): entry.kind == "read" ? "Read" : "Ran"
        case (_, "approved"): "Ran"
        case (_, "requested"): "Asked"
        default: entry.decision.capitalized
        }
    }

    private var color: Color {
        switch entry.decision {
        case "allowed", "approved": .green
        case "requested": .orange
        case "refused", "denied": .red
        default: .secondary
        }
    }
}

// MARK: Network

struct NetworkPane: View {
    let store: Store
    @State private var routesText = ""
    @State private var editingRoutes = false
    @FocusState private var routesFocused: Bool

    var body: some View {
        Section {
            LabeledContent {
                HStack {
                    if editingRoutes {
                        TextField("VPN subnets", text: $routesText, prompt: Text("10.8.0.0/16"))
                            .labelsHidden()
                            .frame(minWidth: 180, maxWidth: 240)
                            .focused($routesFocused)
                            .onSubmit(saveRoutes)
                            .onExitCommand { editingRoutes = false }
                        Button("Cancel") { editingRoutes = false }
                        Button("Save", action: saveRoutes).keyboardShortcut(.defaultAction)
                    } else {
                        Text(store.vpnRoutes.isEmpty ? "Not set" : store.vpnRoutes.joined(separator: ", "))
                            .foregroundStyle(store.vpnRoutes.isEmpty ? .secondary : .primary)
                            .textSelection(.enabled)
                        Button(store.vpnRoutes.isEmpty ? "Set…" : "Edit…") {
                            routesText = store.vpnRoutes.joined(separator: ", ")
                            editingRoutes = true
                            routesFocused = true
                        }
                    }
                }
            } label: {
                Text("VPN subnets")
                if store.vpnRoutes.isEmpty {
                    Label("Not set. VM Manager can’t tell whether OpenVPN is on.", systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                } else {
                    Text("Separate several subnets with commas.")
                }
            }
            if let network = store.status?.network {
                LabeledContent("Status") {
                    if store.vpnRoutes.isEmpty {
                        StatusBadge(text: "Unknown", color: .secondary)
                    } else {
                        StatusBadge(text: network.openvpn.up ? "Connected" : "Not Connected", color: network.openvpn.up ? .green : .orange)
                    }
                }
                if let interface = network.openvpn.interface {
                    LabeledContent("Route", value: network.openvpn.via == "route" ? "via \(interface)" : "via \(interface) (full tunnel)")
                }
            }
            servers(on: "vpn:openvpn")
            LabeledContent("App") {
                Button("Open OpenVPN Connect") { openApp(["/Applications/OpenVPN Connect/OpenVPN Connect.app", "/Applications/OpenVPN Connect.app"]) }
            }
        } header: {
            Text("OpenVPN Connect")
        } footer: {
            Text("Enter the subnets your OpenVPN profile routes, such as 10.8.0.0/16. The VPN counts as connected when this Mac has a route to one of them, or reaches the first one through a utun tunnel. They are saved in vms.json.")
        }
        if let network = store.status?.network {
            Section("Tailscale") {
                LabeledContent("Status") {
                    StatusBadge(
                        text: !network.tailscale.installed ? "Not Installed" : network.tailscale.running ? "Running" : "Stopped",
                        color: network.tailscale.running ? .green : .secondary
                    )
                }
                if let tailnet = network.tailscale.tailnet { LabeledContent("Tailnet", value: tailnet) }
                servers(on: "tailscale")
                if network.tailscale.installed {
                    LabeledContent("App") {
                        Button("Open Tailscale") { openApp(["/Applications/Tailscale.app"]) }
                    }
                }
            }
        }
        Section {
            LabeledContent {
                HStack {
                    if store.checking { ProgressView().controlSize(.small) }
                    Button("Check Again") { Task { await store.refreshStatus() } }.disabled(store.checking)
                }
            } label: {
                Text("Last checked")
                Text(store.status.flatMap { ISO.date($0.checkedAt) }?.formatted(.relative(presentation: .named)) ?? "Not yet")
            }
            ForEach(store.activeServers) { server in
                LabeledContent {
                    StatusDot(state: store.status(of: server)?.state, network: server.network)
                } label: {
                    Text(server.name)
                    Text(statusLine(server))
                }
            }
        } header: {
            Text("Reachability")
        } footer: {
            Text("VM Manager opens a TCP connection to each server’s SSH port, with a 3-second limit, and closes it. It doesn’t sign in.")
        }
    }

    private var parsedRoutes: [String] {
        routesText.split(whereSeparator: { $0 == "," || $0 == " " || $0 == "\n" }).map(String.init)
    }

    private func saveRoutes() {
        let routes = parsedRoutes
        guard routes != store.vpnRoutes else {
            editingRoutes = false
            return
        }
        Task {
            if await store.setVpnRoutes(routes) { editingRoutes = false }
        }
    }

    @ViewBuilder
    private func servers(on network: String) -> some View {
        let names = store.activeServers.filter { $0.network == network }.map(\.name)
        LabeledContent("Servers", value: names.isEmpty ? "None" : names.joined(separator: ", "))
    }

    private func statusLine(_ server: Server) -> String {
        guard let status = store.status(of: server) else { return "\(server.host) · not checked" }
        switch status.state {
        case .reachable: return "\(server.host) · reachable\(status.latencyMs.map { " in \($0) ms" } ?? "")"
        case .needs_vpn: return "\(server.host) · \(status.detail)"
        case .unreachable: return "\(server.host) · unreachable (\(status.detail))"
        }
    }

    private func openApp(_ candidates: [String]) {
        guard let path = candidates.first(where: { FileManager.default.fileExists(atPath: $0) }) else {
            Dialog.warn(title: "App not found", message: "It isn’t in /Applications.")
            return
        }
        NSWorkspace.shared.open(URL(fileURLWithPath: path))
    }
}

// MARK: About

struct AboutPane: View {
    var body: some View {
        VStack(spacing: 10) {
            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .frame(width: 96, height: 96)
            Text("VM Manager").font(.title2.weight(.semibold))
            Text("Version \(AppInfo.version)").foregroundStyle(.secondary)
            Text("Your SSH servers in one list, a menu bar shortcut to each, and Claude agents that read freely but ask before they change anything on production.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .frame(maxWidth: 380)
        }
        .padding(30)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
