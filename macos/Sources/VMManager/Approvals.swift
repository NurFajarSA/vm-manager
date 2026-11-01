import SwiftUI

/// The window a notification opens: every waiting command, in full, with Approve and Deny.
struct ApprovalsWindow: View {
    let store: Store

    var body: some View {
        Group {
            if store.pending.isEmpty {
                ContentUnavailableView(
                    "Nothing to approve",
                    systemImage: "checkmark.seal",
                    description: Text("When an agent asks to change a server that needs approval, the exact command shows up here.")
                )
            } else {
                ScrollView {
                    VStack(spacing: 12) {
                        ForEach(store.pending) { ApprovalCard(store: store, approval: $0) }
                    }
                    .padding(16)
                }
            }
        }
        .frame(minWidth: 480, minHeight: 320)
        .task { await store.reloadApprovals() }
        .appWindowPresence()
    }
}

struct ApprovalCard: View {
    let store: Store
    let approval: Approval
    @State private var deciding = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                EnvBadge(env: approval.env)
                Text(approval.vm).font(.headline)
                Spacer()
                TimelineView(.periodic(from: .now, by: 30)) { _ in
                    Text(timing).font(.caption).foregroundStyle(.secondary)
                }
            }
            CommandBox(command: approval.command)
            if let why = approval.why {
                Label(why, systemImage: "text.bubble").font(.callout)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text("From \(approval.requester)")
                Text("Why it needs approval: \(approval.reason)")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            HStack {
                Spacer()
                Button("Deny", role: .destructive) { decide(approve: false) }
                    .disabled(deciding)
                Button("Approve") { decide(approve: true) }
                    .buttonStyle(.borderedProminent)
                    .tint(approval.env == "prod" ? .red : .accentColor)
                    .disabled(deciding)
                    .help(approval.env == "prod" ? "Runs this command on a production server" : "Runs this command")
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.primary.opacity(0.04)))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.5))
        .accessibilityElement(children: .contain)
    }

    private var timing: String {
        let asked = approval.created.map { "Asked \($0.formatted(.relative(presentation: .named)))" } ?? ""
        guard let expires = approval.expires else { return asked }
        let minutes = max(0, Int(expires.timeIntervalSinceNow / 60))
        return "\(asked) · expires in \(minutes) min"
    }

    private func decide(approve: Bool) {
        deciding = true
        Task {
            if approve { await store.approve(approval) } else { await store.deny(approval) }
            deciding = false
        }
    }
}

struct CommandBox: View {
    let command: String

    var body: some View {
        Text(command)
            .font(.system(.body, design: .monospaced))
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color(nsColor: .textBackgroundColor)))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Color.primary.opacity(0.1), lineWidth: 0.5))
            .accessibilityLabel("Command: \(command)")
    }
}
