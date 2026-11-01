import AppKit

// Draws the VM Manager app icon: a blue-gray tile with a three-unit server rack.
// Usage: swift make-icon.swift AppIcon-1024.png   (make-icns.sh turns it into AppIcon.icns)

let size: CGFloat = 1024
let output = CommandLine.arguments.dropFirst().first ?? "AppIcon-1024.png"

func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    NSColor(
        srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
        green: CGFloat((hex >> 8) & 0xFF) / 255,
        blue: CGFloat(hex & 0xFF) / 255,
        alpha: alpha
    ).cgColor
}

let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { _ in
    guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
    let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
    let squircle = CGPath(roundedRect: tile, cornerWidth: 185, cornerHeight: 185, transform: nil)

    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: 24, color: NSColor.black.withAlphaComponent(0.28).cgColor)
    ctx.addPath(squircle)
    ctx.setFillColor(color(0x4A5B6E))
    ctx.fillPath()
    ctx.restoreGState()

    ctx.saveGState()
    ctx.addPath(squircle)
    ctx.clip()
    let background = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [color(0x7D93AB), color(0x465A70)] as CFArray, locations: [0, 1])!
    ctx.drawLinearGradient(background, start: CGPoint(x: 512, y: 924), end: CGPoint(x: 512, y: 100), options: [])

    // Three rack units, top to bottom.
    let unitWidth: CGFloat = 540
    let unitHeight: CGFloat = 150
    let gap: CGFloat = 34
    let left = (size - unitWidth) / 2
    let totalHeight = unitHeight * 3 + gap * 2
    let bottom = (size - totalHeight) / 2
    for i in 0..<3 {
        let y = bottom + CGFloat(2 - i) * (unitHeight + gap)
        let unit = CGRect(x: left, y: y, width: unitWidth, height: unitHeight)
        ctx.addPath(CGPath(roundedRect: unit, cornerWidth: 34, cornerHeight: 34, transform: nil))
        ctx.setFillColor(NSColor.white.withAlphaComponent(i == 0 ? 1 : 0.88).cgColor)
        ctx.fillPath()

        // Drive slots.
        ctx.setFillColor(color(0x465A70, 0.35))
        for s in 0..<3 {
            let slot = CGRect(x: left + 64 + CGFloat(s) * 56, y: y + unitHeight / 2 - 32, width: 26, height: 64)
            ctx.addPath(CGPath(roundedRect: slot, cornerWidth: 13, cornerHeight: 13, transform: nil))
            ctx.fillPath()
        }
        // Status light.
        let led = CGRect(x: left + unitWidth - 108, y: y + unitHeight / 2 - 22, width: 44, height: 44)
        ctx.setFillColor(i == 1 ? color(0xF5A524) : color(0x34C759))
        ctx.fillEllipse(in: led)
    }
    ctx.restoreGState()
    return true
}

let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
image.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: output))
