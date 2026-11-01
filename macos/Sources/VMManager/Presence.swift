import AppKit
import SwiftUI

/// A menu bar app has no Dock icon until one of its windows opens, and drops it again when the last one closes.
@MainActor
enum AppPresence {
    private static var openWindows = 0

    static func windowAppeared() {
        openWindows += 1
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }

    static func windowDisappeared() {
        openWindows = max(0, openWindows - 1)
        if openWindows == 0 { NSApp.setActivationPolicy(.accessory) }
    }
}

extension View {
    func appWindowPresence() -> some View {
        onAppear { AppPresence.windowAppeared() }
            .onDisappear { AppPresence.windowDisappeared() }
    }
}
