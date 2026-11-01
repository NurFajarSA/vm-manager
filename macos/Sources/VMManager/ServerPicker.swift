import AppKit
import SwiftUI

extension Notification.Name {
    static let showServerPicker = Notification.Name("app.vm-manager.showServerPicker")
}

enum ServerPicker {
    static let windowID = "picker"
    static let showOnLaunchKey = "pickerOnLaunch"

    static var showOnLaunch: Bool {
        UserDefaults.standard.object(forKey: showOnLaunchKey) as? Bool ?? true
    }

    /// The launch agent passes this flag, so the picker stays hidden when the app starts at login.
    static var launchedAtLogin: Bool {
        CommandLine.arguments.contains("--at-login")
    }
}

/// Chrome-style "Who's using Chrome?" window: one card per active server, grouped like the menu bar panel.
struct ServerPickerView: View {
    let store: Store
    @Environment(\.dismissWindow) private var dismissWindow
    @Environment(\.openWindow) private var openWindow
    @AppStorage(ServerPicker.showOnLaunchKey) private var showOnLaunch = true

    private let columns = [GridItem(.adaptive(minimum: 160, maximum: 190), spacing: 14)]

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 6) {
                Image(nsImage: NSApp.applicationIconImage)
                    .resizable()
                    .frame(width: 48, height: 48)
                    .accessibilityHidden(true)
                Text("Which server do you want to open?")
                    .font(.title2.weight(.semibold))
                Text("Pick one to open a shell on it in Terminal. Password servers sign in from the Keychain.")
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .padding(.top, 24)
            .padding(.bottom, 14)
            .padding(.horizontal, 28)

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(store.groups, id: \.self) { group in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(group)
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(.secondary)
                                .padding(.leading, 4)
                                .accessibilityAddTraits(.isHeader)
                            LazyVGrid(columns: columns, alignment: .leading, spacing: 14) {
                                ForEach(store.activeServers.filter { $0.group == group }) { server in
                                    ServerCard(server: server, store: store) { pick(server) }
                                }
                            }
                        }
                    }
                }
                .padding(.horizontal, 28)
                .padding(.bottom, 20)
            }
            .overlay { placeholder }

            Divider()
            HStack {
                Button("Settings…") {
                    NSApp.activate(ignoringOtherApps: true)
                    openWindow(id: "settings")
                }
                Spacer()
                Toggle("Show when VM Manager opens", isOn: $showOnLaunch)
                    .toggleStyle(.checkbox)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
        }
        .frame(minWidth: 560, idealWidth: 760, minHeight: 520, idealHeight: 760)
        .onExitCommand { dismissWindow(id: ServerPicker.windowID) }
        .appWindowPresence()
    }

    @ViewBuilder
    private var placeholder: some View {
        if let message = store.loadError, store.inventory == nil {
            ContentUnavailableView("Couldn’t load servers", systemImage: "exclamationmark.triangle", description: Text(message))
        } else if store.inventory == nil {
            ProgressView().controlSize(.small)
        } else if store.activeServers.isEmpty {
            ContentUnavailableView {
                Label("No servers yet", systemImage: "server.rack")
            } description: {
                Text("Add a server in Settings, or run `vm add` in a terminal.")
            } actions: {
                Button("Add Server…") {
                    store.requestedRoute = .newServer
                    NSApp.activate(ignoringOtherApps: true)
                    openWindow(id: "settings")
                }
            }
        }
    }

    private func pick(_ server: Server) {
        store.openShell(server)
        dismissWindow(id: ServerPicker.windowID)
    }
}

struct ServerCard: View {
    let server: Server
    let store: Store
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        let status = store.status(of: server)
        Button(action: action) {
            VStack(spacing: 8) {
                ServerAvatar(env: server.env, state: status?.state, network: server.network)
                VStack(spacing: 2) {
                    Text(server.name)
                        .font(.headline)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .truncationMode(.middle)
                    Text(address)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                HStack(spacing: 6) {
                    EnvBadge(env: server.env)
                    if let hint {
                        Label(hint.text, systemImage: hint.symbol)
                            .labelStyle(.titleAndIcon)
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(hint.warning ? AnyShapeStyle(Color.orange) : AnyShapeStyle(.secondary))
                            .lineLimit(1)
                    }
                }
                .frame(height: 16)
            }
            .padding(.vertical, 14)
            .padding(.horizontal, 10)
            .frame(maxWidth: .infinity)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color.primary.opacity(hovering ? 0.10 : 0.05))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.5)
            )
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help("Open vm ssh \(server.name) in Terminal")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(server.name)
        .accessibilityValue([server.isProd ? "Production" : "Development", address, StatusDot.label(status?.state, network: server.network), hint?.text].compactMap { $0 }.joined(separator: ", "))
        .accessibilityHint("Opens a shell on this server in Terminal.")
        .accessibilityAddTraits(.isButton)
        .contextMenu {
            Button("Open in Terminal", action: action)
            Button("Open in Zed") { store.openInZed(server) }
            Divider()
            Button("Copy IP") { store.copy(server.host) }
            Button("Copy SSH Command") { store.copy(server.sshCommand) }
        }
    }

    private var address: String {
        "\(server.user)@\(server.host)\(server.port == 22 ? "" : ":\(server.port)")"
    }

    private var hint: (text: String, symbol: String, warning: Bool)? {
        if server.keyMissing { return ("Key missing", "exclamationmark.triangle.fill", true) }
        if server.auth.kind == "password" && server.hasPassword == false { return ("No password", "key.slash", true) }
        switch server.network {
        case "vpn:openvpn": return ("Needs VPN", "lock.shield", false)
        case "tailscale": return ("Needs Tailscale", "point.3.connected.trianglepath.dotted", false)
        default: return nil
        }
    }
}

/// A server symbol on a circle tinted by environment (red for prod, green for dev), with the reachability dot.
struct ServerAvatar: View {
    let env: String
    let state: Reachability?
    let network: String

    var body: some View {
        let color: Color = env == "prod" ? .red : .green
        Circle()
            .fill(color.gradient)
            .frame(width: 52, height: 52)
            .overlay(Image(systemName: "server.rack").font(.system(size: 21, weight: .medium)).foregroundStyle(.white))
            .overlay(alignment: .bottomTrailing) {
                Circle()
                    .fill(StatusDot.color(state))
                    .frame(width: 15, height: 15)
                    .background(Circle().fill(Color(nsColor: .windowBackgroundColor)))
                    .overlay(Circle().strokeBorder(Color(nsColor: .windowBackgroundColor), lineWidth: 3))
                    .help(StatusDot.label(state, network: network))
            }
            .accessibilityHidden(true)
    }
}
