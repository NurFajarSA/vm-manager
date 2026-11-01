import AppKit
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    /// Clicking the Dock icon, or opening the app again from Finder or Spotlight, shows the server picker.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        NotificationCenter.default.post(name: .showServerPicker, object: nil)
        return true
    }
}

@main
struct VMManagerApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var store = Store()
    @Environment(\.openWindow) private var openWindow

    var body: some Scene {
        MenuBarExtra {
            Panel(store: store)
                .frame(width: Panel.width)
                .background(RoundedWindow(radius: Panel.windowRadius))
        } label: {
            HStack(spacing: 3) {
                Image(systemName: store.pending.isEmpty ? "server.rack" : "hand.raised.fill")
                if !store.pending.isEmpty { Text(store.headline) }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("VM Manager")
            .accessibilityValue(store.pending.isEmpty ? "Nothing waiting" : "\(store.pending.count) waiting for approval")
            .task {
                await Snapshot.previewIfRequested(store: store)
                let environment = ProcessInfo.processInfo.environment
                let developerLaunch = environment.keys.contains { $0.hasPrefix("VM_MANAGER_") }
                if environment["VM_MANAGER_OPEN_PICKER"] == "1"
                    || (!developerLaunch && !ServerPicker.launchedAtLogin && ServerPicker.showOnLaunch) {
                    showPicker()
                }
                await store.start()
                if environment["VM_MANAGER_OPEN_SETTINGS"] == "1" { showSettings() }
                if environment["VM_MANAGER_OPEN_APPROVALS"] == "1" { showApprovals() }
            }
            .onReceive(NotificationCenter.default.publisher(for: .showApprovals)) { _ in showApprovals() }
            .onReceive(NotificationCenter.default.publisher(for: .showServerPicker)) { _ in showPicker() }
        }
        .menuBarExtraStyle(.window)

        Window("VM Manager", id: "settings") {
            SettingsView(store: store)
        }
        .defaultSize(width: 880, height: 600)
        .defaultPosition(.center)

        Window("Choose a Server", id: ServerPicker.windowID) {
            ServerPickerView(store: store)
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 760, height: 760)
        .defaultPosition(.center)

        Window("Approvals", id: "approvals") {
            ApprovalsWindow(store: store)
        }
        .defaultSize(width: 560, height: 460)
        .defaultPosition(.center)
    }

    private func showSettings() {
        NSApp.activate(ignoringOtherApps: true)
        openWindow(id: "settings")
    }

    private func showApprovals() {
        NSApp.activate(ignoringOtherApps: true)
        openWindow(id: "approvals")
    }

    private func showPicker() {
        NSApp.activate(ignoringOtherApps: true)
        openWindow(id: ServerPicker.windowID)
    }
}

struct Panel: View {
    let store: Store
    @Environment(\.openWindow) private var openWindow
    var scrolls = true
    var expandInactive = false
    @State private var showInactive = false

    private static let maxListHeight: CGFloat = 500
    static let width: CGFloat = 340
    static let edge: CGFloat = 8
    static let moduleRadius: CGFloat = 14
    static let windowRadius: CGFloat = moduleRadius + edge

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            if !scrolls {
                VStack(alignment: .leading, spacing: 8) { content }
                    .onAppear { showInactive = expandInactive }
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) { content }
                        .background(
                            GeometryReader { geo in
                                Color.clear.preference(key: ListHeightKey.self, value: geo.size.height)
                            }
                        )
                }
                .scrollIndicators(.automatic)
                .frame(height: min(store.listHeight ?? estimatedHeight, Self.maxListHeight))
                .onPreferenceChange(ListHeightKey.self) { height in
                    guard height > 0 else { return }
                    store.listHeight = height
                }
            }
            Module {
                ActionRow(title: "Refresh") {
                    Task {
                        await store.reload()
                        await store.refreshStatus()
                    }
                }
                ActionRow(title: "Choose Server…") {
                    NSApp.activate(ignoringOtherApps: true)
                    openWindow(id: ServerPicker.windowID)
                }
                ActionRow(title: "Add Server…") { openSettings(.newServer) }
                ActionRow(title: "Settings…") { openSettings(nil) }
                ActionRow(title: "Quit VM Manager") { NSApplication.shared.terminate(nil) }
            }
        }
        .padding(Self.edge)
    }

    private func openSettings(_ route: SettingsRoute?) {
        store.requestedRoute = route
        NSApp.activate(ignoringOtherApps: true)
        openWindow(id: "settings")
    }

    private func openSettings(pane: SettingsPane) {
        store.requestedPane = pane
        NSApp.activate(ignoringOtherApps: true)
        openWindow(id: "settings")
    }

    @ViewBuilder
    private var content: some View {
        if let message = store.loadError {
            Module { Row(icon: "exclamationmark.triangle.fill", title: "Couldn’t load servers", subtitle: message).padding(6) }
        }
        if store.vpnSubnetMissing {
            Module {
                Button {
                    openSettings(pane: .network)
                } label: {
                    Row(icon: "exclamationmark.triangle.fill", tint: .orange, title: "VPN subnet not set", subtitle: "Set it in Settings › Network") {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(.secondary)
                            .accessibilityHidden(true)
                    }
                }
                .buttonStyle(RowButtonStyle())
                .help("VM Manager can’t tell whether OpenVPN is connected until you enter the subnets it routes.")
                .accessibilityHint("Opens Settings on the Network page.")
            }
        }
        if !store.pending.isEmpty {
            Module(title: "Waiting for approval") {
                ForEach(store.pending) { approval in
                    Button {
                        NSApp.activate(ignoringOtherApps: true)
                        openWindow(id: "approvals")
                    } label: {
                        Row(icon: "hand.raised.fill", tint: .orange, title: approval.vm, subtitle: approval.command) {
                            Text("Review")
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(.secondary)
                        }
                    }
                    .buttonStyle(RowButtonStyle())
                    .help("\(approval.requester) wants to run: \(approval.command)")
                    .accessibilityHint("Opens the approvals window to approve or deny this command.")
                }
            }
        }
        if store.inventory != nil {
            ForEach(store.groups, id: \.self) { group in
                Module(title: group) {
                    ForEach(store.activeServers.filter { $0.group == group }) { ServerRow(store: store, server: $0, openSettings: openSettings) }
                }
            }
            let inactive = store.servers.filter { !$0.active }
            if !inactive.isEmpty {
                Module {
                    Button {
                        withAnimation(.easeOut(duration: 0.15)) { showInactive.toggle() }
                    } label: {
                        Row(icon: "archivebox", title: "Inactive", subtitle: "\(inactive.count) servers kept for reference") {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(.secondary)
                                .rotationEffect(.degrees(showInactive ? 90 : 0))
                                .accessibilityHidden(true)
                        }
                    }
                    .buttonStyle(RowButtonStyle())
                    .accessibilityValue(showInactive ? "Expanded" : "Collapsed")
                    if showInactive {
                        ForEach(inactive) { ServerRow(store: store, server: $0, openSettings: openSettings) }
                    }
                }
            }
        } else if store.loadError == nil {
            ProgressView().controlSize(.small).frame(maxWidth: .infinity).padding(12).accessibilityLabel("Loading servers")
        }
    }

    private var estimatedHeight: CGFloat {
        let rows = CGFloat(store.activeServers.count + (store.servers.contains { !$0.active } ? 1 : 0) + store.pending.count)
        let modules = CGFloat(store.groups.count + (store.pending.isEmpty ? 0 : 1) + 1)
        return max(60, modules * 29 + rows * 36 + (modules - 1) * 8)
    }

    private var header: some View {
        HStack(spacing: 6) {
            Text("VM Manager").font(.system(size: 13, weight: .semibold)).lineLimit(1).fixedSize()
            if store.busy || store.checking { ProgressView().controlSize(.mini).accessibilityLabel("Working") }
            Spacer()
            if let network = store.status?.network {
                if !store.vpnRoutes.isEmpty {
                    NetworkChip(title: "VPN", on: network.openvpn.up)
                        .help(network.openvpn.up ? "OpenVPN is connected via \(network.openvpn.interface ?? "a tunnel")" : "OpenVPN is not connected")
                }
                if network.tailscale.installed {
                    NetworkChip(title: "Tailscale", on: network.tailscale.running)
                        .help(network.tailscale.running ? "Tailscale is running" : "Tailscale is stopped")
                }
            }
        }
        .padding(.horizontal, 6)
        .padding(.top, 2)
    }
}

struct NetworkChip: View {
    let title: String
    let on: Bool

    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(on ? Color.green : Color.secondary.opacity(0.5)).frame(width: 6, height: 6)
            Text(title).font(.system(size: 11)).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title) \(on ? "connected" : "not connected")")
    }
}

struct ListHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

struct Module<Content: View>: View {
    var title: String?
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let title {
                Text(title)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 8)
                    .padding(.top, 4)
                    .padding(.bottom, 2)
            }
            content()
        }
        .padding(4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Panel.moduleRadius, style: .continuous).fill(Color.primary.opacity(0.05)))
        .overlay(RoundedRectangle(cornerRadius: Panel.moduleRadius, style: .continuous).strokeBorder(Color.primary.opacity(0.06), lineWidth: 0.5))
    }
}

struct ServerRow: View {
    let store: Store
    let server: Server
    let openSettings: (SettingsRoute?) -> Void

    var body: some View {
        Button {
            store.openTerminal(server)
        } label: {
            Row(icon: "server.rack", title: server.name, subtitle: subtitle, warning: server.keyMissing) {
                HStack(spacing: 8) {
                    EnvBadge(env: server.env)
                    StatusDot(state: server.active ? store.status(of: server)?.state : nil, network: server.network)
                }
            }
            .opacity(server.active ? 1 : 0.6)
        }
        .buttonStyle(RowButtonStyle())
        .help("Click to open \(server.sshCommand) in Terminal")
        .accessibilityHint("Opens a shell on this server in Terminal.")
        .contextMenu {
            Button("Open in Terminal") { store.openTerminal(server) }
            Button("Open in Zed") { store.openInZed(server) }
            Divider()
            Button("Copy IP") { store.copy(server.host) }
            Button("Copy SSH Command") { store.copy(server.sshCommand) }
            Divider()
            Button("Run Status Check") { Task { await store.refreshStatus() } }
            Button("Edit…") { openSettings(.server(server.name)) }
            Divider()
            Text("Agents: \(Policy.title(server.agent))")
            if let status = store.status(of: server) { Text(statusText(status)) }
        }
    }

    private var subtitle: String {
        var parts = [server.host]
        if server.keyMissing { parts.append("⚠️ Key file missing") }
        else if server.auth.kind == "password" && server.hasPassword == false { parts.append("No password saved") }
        else if server.network == "vpn:openvpn" { parts.append("VPN") }
        else if server.network == "tailscale" { parts.append("Tailscale") }
        return parts.joined(separator: " · ")
    }

    private func statusText(_ status: ServerStatus) -> String {
        switch status.state {
        case .reachable: "Reachable" + (status.latencyMs.map { " in \($0) ms" } ?? "")
        case .needs_vpn: "Needs VPN"
        case .unreachable: "Unreachable: \(status.detail)"
        }
    }
}

struct EnvBadge: View {
    let env: String

    var body: some View {
        let prod = env == "prod"
        Text(prod ? "PROD" : "DEV")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(prod ? Color.red : Color.green)
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(Capsule().fill((prod ? Color.red : Color.green).opacity(0.15)))
            .accessibilityLabel(prod ? "Production" : "Development")
    }
}

struct StatusDot: View {
    let state: Reachability?
    var network: String = "public"

    var body: some View {
        let label = Self.label(state, network: network)
        Circle()
            .fill(Self.color(state))
            .frame(width: 8, height: 8)
            .accessibilityLabel(label)
            .help(label)
    }

    static func color(_ state: Reachability?) -> Color {
        switch state {
        case .reachable: .green
        case .needs_vpn: .orange
        case .unreachable: Color.secondary.opacity(0.5)
        case nil: Color.secondary.opacity(0.2)
        }
    }

    static func label(_ state: Reachability?, network: String) -> String {
        switch state {
        case .reachable: "Reachable"
        case .needs_vpn: network == "tailscale" ? "Needs Tailscale" : "Needs VPN"
        case .unreachable: "Unreachable"
        case nil: "Not checked"
        }
    }
}

struct Row<Trailing: View>: View {
    let icon: String
    var tint: Color? = nil
    let title: String
    let subtitle: String
    var warning = false
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(spacing: 10) {
            ZStack {
                Circle().fill(tint ?? Color.primary.opacity(0.1))
                Image(systemName: icon)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(tint == nil ? Color.primary.opacity(0.75) : Color.white)
            }
            .frame(width: 26, height: 26)
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.system(size: 13, weight: .medium)).lineLimit(1).truncationMode(.middle)
                Text(subtitle)
                    .font(.system(size: 11))
                    .foregroundStyle(warning ? AnyShapeStyle(Color.orange) : AnyShapeStyle(.secondary))
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            Spacer(minLength: 8)
            trailing()
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

extension Row where Trailing == EmptyView {
    init(icon: String, tint: Color? = nil, title: String, subtitle: String, warning: Bool = false) {
        self.init(icon: icon, tint: tint, title: title, subtitle: subtitle, warning: warning) { EmptyView() }
    }
}

struct RowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        HoverHighlight(pressed: configuration.isPressed) { configuration.label }
    }
}

struct HoverHighlight<Content: View>: View {
    let pressed: Bool
    @ViewBuilder var content: () -> Content
    @State private var hovering = false

    var body: some View {
        content()
            .padding(.horizontal, 6)
            .padding(.vertical, 5)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color.primary.opacity(pressed ? 0.14 : hovering ? 0.08 : 0))
            )
            .onHover { hovering = $0 }
    }
}

struct ActionRow: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack {
                Text(title).font(.system(size: 13))
                Spacer()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(RowButtonStyle())
    }
}
