import AppKit
import CoreGraphics
import Foundation

guard CommandLine.arguments.count >= 5,
      (CommandLine.arguments.count - 3).isMultiple(of: 2),
      let sourceX = Double(CommandLine.arguments[1]),
      let sourceY = Double(CommandLine.arguments[2]) else {
  fputs("usage: drag-action.swift SOURCE_X SOURCE_Y TARGET_X TARGET_Y [TARGET_X TARGET_Y ...]\n", stderr)
  exit(2)
}

let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "com.elgato.StreamDeck")
guard let streamDeck = apps.first else {
  fputs("Stream Deck is not running\n", stderr)
  exit(3)
}
streamDeck.activate(options: [.activateAllWindows])
usleep(150_000)

let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
guard let window = windows.first(where: {
  ($0[kCGWindowOwnerPID as String] as? pid_t) == streamDeck.processIdentifier &&
  ($0[kCGWindowLayer as String] as? Int) == 0
}), let boundsDictionary = window[kCGWindowBounds as String] as? NSDictionary,
   let bounds = CGRect(dictionaryRepresentation: boundsDictionary) else {
  fputs("Could not locate the Stream Deck window\n", stderr)
  exit(4)
}

let source = CGPoint(x: bounds.minX + sourceX, y: bounds.minY + sourceY)
func post(_ type: CGEventType, at point: CGPoint) {
  CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
}

for argumentIndex in stride(from: 3, to: CommandLine.arguments.count, by: 2) {
  guard let targetX = Double(CommandLine.arguments[argumentIndex]),
        let targetY = Double(CommandLine.arguments[argumentIndex + 1]) else {
    fputs("target coordinates must be numbers\n", stderr)
    exit(5)
  }
  let target = CGPoint(x: bounds.minX + targetX, y: bounds.minY + targetY)

  post(.mouseMoved, at: source)
  usleep(100_000)
  post(.leftMouseDown, at: source)
  usleep(160_000)
  for step in 1...18 {
    let progress = CGFloat(step) / 18
    let point = CGPoint(
      x: source.x + (target.x - source.x) * progress,
      y: source.y + (target.y - source.y) * progress
    )
    post(.leftMouseDragged, at: point)
    usleep(18_000)
  }
  usleep(120_000)
  post(.leftMouseUp, at: target)
  usleep(350_000)
  print("Dragged action to (\(targetX), \(targetY))")
}
