import AppKit
import ApplicationServices
import ColorSync
import CoreGraphics
import Foundation

// Public workspace lifecycle notifications are documented by Apple:
// https://developer.apple.com/documentation/appkit/nsworkspace/sessiondidresignactivenotification
// CGSessionCopyCurrentDictionary returns nil outside a Quartz GUI session:
// https://developer.apple.com/documentation/coregraphics/cgsessioncopycurrentdictionary()
// The distributed lock/unlock notifications and CGSSessionScreenIsLocked key are
// undocumented macOS integration points, not a stable Apple API contract.
// An absent lock key means unlocked ONLY with a valid, logged-in console session.
// A notification can precede the corresponding CG dictionary update. Polling
// therefore retains pending unlock intent and debounces recovery if it was lost.
struct SessionLockState {
    private(set) var locked = false
    private var unlockPending = false
    private var absentSince: TimeInterval?

    mutating func didLock() {
        locked = true
        unlockPending = false
        absentSince = nil
    }

    mutating func didUnlock() { unlockPending = true }

    mutating func reconcile(observed: Bool?, validConsole: Bool, now: TimeInterval) {
        guard validConsole else { absentSince = nil; return }
        if observed == true {
            locked = true
            absentSince = nil
            // Do not discard a just-received unlock: this read may still be stale.
            return
        }
        if observed == false || unlockPending || !locked {
            locked = false
            unlockPending = false
            absentSince = nil
            return
        }
        // macOS normally omits CGSSessionScreenIsLocked when unlocked. Requiring
        // two seconds of continuous valid-console absence avoids an irreversible
        // latch after a missed unlock while protecting a brief notification race.
        if absentSince == nil { absentSince = now }
        if now - absentSince! >= 2 {
            locked = false
            absentSince = nil
        }
    }
}

func selfTestLockState() {
    var state = SessionLockState()
    state.reconcile(observed: true, validConsole: true, now: 0)
    precondition(state.locked, "startup while locked")
    state.didUnlock()
    state.reconcile(observed: true, validConsole: true, now: 1)
    precondition(state.locked, "unlock must wait for dictionary")
    state.reconcile(observed: nil, validConsole: true, now: 2)
    precondition(!state.locked, "pending unlock survives stale locked read")

    state.didLock()
    state.reconcile(observed: nil, validConsole: true, now: 3)
    state.reconcile(observed: nil, validConsole: true, now: 4)
    precondition(state.locked, "transient absence cannot override lock")
    state.reconcile(observed: true, validConsole: true, now: 5)
    state.reconcile(observed: nil, validConsole: true, now: 6)
    state.reconcile(observed: nil, validConsole: true, now: 7)
    precondition(state.locked, "positive lock resets absence debounce")
    state.reconcile(observed: nil, validConsole: true, now: 8)
    precondition(!state.locked, "missed unlock recovers after stable absence")

    state.didLock()
    state.didUnlock()
    state.didLock()
    state.reconcile(observed: nil, validConsole: true, now: 9)
    precondition(state.locked, "new lock cancels old pending unlock")
    state.reconcile(observed: nil, validConsole: false, now: 100)
    precondition(state.locked, "unknown/inactive GUI cannot unlock")
    state.reconcile(observed: nil, validConsole: true, now: 101)
    precondition(state.locked, "invalid GUI resets absence timer")
    state.reconcile(observed: nil, validConsole: true, now: 103)
    precondition(!state.locked, "valid GUI recovers after fresh debounce")
    state.didLock()
    state.reconcile(observed: false, validConsole: true, now: 104)
    precondition(!state.locked, "explicit unlocked dictionary")
    print("lock-state self-test passed")
}

final class SessionMonitor: NSObject {
    private var reasons = Set<String>()
    private var lockState = SessionLockState()
    private var lastOutput: String?
    private var lastHeartbeat = Date.distantPast

    func reconcile() {
        guard let session = CGSessionCopyCurrentDictionary() as? [String: Any],
              let onConsole = session[kCGSessionOnConsoleKey as String] as? Bool,
              let loggedIn = session[kCGSessionLoginDoneKey as String] as? Bool else {
            lockState.reconcile(observed: nil, validConsole: false, now: ProcessInfo.processInfo.systemUptime)
            reasons.insert("monitor-unavailable")
            return
        }
        reasons.remove("monitor-unavailable")
        if !onConsole || !loggedIn { reasons.insert("inactive-session") }
        else { reasons.remove("inactive-session") }
        lockState.reconcile(observed: session["CGSSessionScreenIsLocked"] as? Bool,
                            validConsole: onConsole && loggedIn, now: ProcessInfo.processInfo.systemUptime)
        if lockState.locked { reasons.insert("locked") } else { reasons.remove("locked") }
        if CGDisplayIsAsleep(CGMainDisplayID()) != 0 { reasons.insert("display-asleep") }
        else { reasons.remove("display-asleep") }
    }

    func emit(force: Bool = false) {
        let priority = ["shutting-down", "sleeping", "locked", "inactive-session", "display-asleep", "monitor-unavailable"]
        let reason = priority.first(where: { reasons.contains($0) }) ?? "active"
        let line = "{\"active\":\(reasons.isEmpty ? "true" : "false"),\"reason\":\"\(reason)\"}\n"
        let now = Date()
        guard force || line != lastOutput || now.timeIntervalSince(lastHeartbeat) >= 2 else { return }
        // All values are fixed strings; no session dictionary/user data reaches stdout.
        guard let data = line.data(using: .utf8), data.count <= 1024 else { return }
        FileHandle.standardOutput.write(data)
        lastOutput = line
        lastHeartbeat = now
    }

    @objc func workspaceChanged(_ note: Notification) {
        switch note.name {
        case NSWorkspace.willSleepNotification: reasons.insert("sleeping")
        case NSWorkspace.didWakeNotification: reasons.remove("sleeping"); reconcile()
        case NSWorkspace.screensDidSleepNotification: reasons.insert("display-asleep")
        case NSWorkspace.screensDidWakeNotification: reasons.remove("display-asleep"); reconcile()
        case NSWorkspace.sessionDidResignActiveNotification: reasons.insert("inactive-session")
        case NSWorkspace.sessionDidBecomeActiveNotification: reconcile()
        case NSWorkspace.willPowerOffNotification: reasons.insert("shutting-down")
        default: return
        }
        emit()
    }

    @objc func lockChanged(_ note: Notification) {
        if note.name.rawValue == "com.apple.screenIsLocked" { lockState.didLock(); reasons.insert("locked") }
        else { lockState.didUnlock(); reconcile() }
        emit()
    }

    @objc func tick(_ timer: Timer) { reconcile(); emit() }

    func start() {
        let workspace = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.willSleepNotification, NSWorkspace.didWakeNotification,
                     NSWorkspace.screensDidSleepNotification, NSWorkspace.screensDidWakeNotification,
                     NSWorkspace.sessionDidResignActiveNotification, NSWorkspace.sessionDidBecomeActiveNotification,
                     NSWorkspace.willPowerOffNotification] {
            workspace.addObserver(self, selector: #selector(workspaceChanged(_:)), name: name, object: nil)
        }
        let distributed = DistributedNotificationCenter.default()
        for name in ["com.apple.screenIsLocked", "com.apple.screenIsUnlocked"] {
            distributed.addObserver(self, selector: #selector(lockChanged(_:)), name: Notification.Name(name), object: nil, suspensionBehavior: .deliverImmediately)
        }
        reconcile()
        emit(force: true)
        let timer = Timer(timeInterval: 1, target: self, selector: #selector(tick(_:)), userInfo: nil, repeats: true)
        RunLoop.main.add(timer, forMode: .common)
        RunLoop.main.run()
    }
}

// Window attributes use public Accessibility APIs, only when trust already exists.
// https://developer.apple.com/documentation/applicationservices/1460720-axisprocesstrusted
// https://developer.apple.com/documentation/applicationservices/1462085-axuielementcopyattributevalue
// Display UUIDs are stable identifiers, unlike transient CGDirectDisplayID values.
// https://developer.apple.com/documentation/colorsync/cgdisplaycreateuuidfromdisplayid(_:)
func displayForWindow(_ window: CGRect, displays: [(CGDirectDisplayID, CGRect)]) -> CGDirectDisplayID? {
    guard window.origin.x.isFinite, window.origin.y.isFinite,
          window.width.isFinite, window.height.isFinite, window.width > 0, window.height > 0 else { return nil }
    var winner: CGDirectDisplayID?
    var largest: CGFloat = 0
    for (id, bounds) in displays {
        let overlap = window.intersection(bounds)
        let area = overlap.isNull ? 0 : overlap.width * overlap.height
        if area > largest { largest = area; winner = id }
    }
    return winner
}
func copyAttribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}
func focusedWindowContext(_ app: NSRunningApplication) -> (String?, String?) {
    // AXIsProcessTrusted performs a check; it does not request or grant permission.
    guard AXIsProcessTrusted() else { return (nil, nil) }
    let application = AXUIElementCreateApplication(app.processIdentifier)
    _ = AXUIElementSetMessagingTimeout(application, 0.15)
    guard let rawWindow = copyAttribute(application, kAXFocusedWindowAttribute),
          CFGetTypeID(rawWindow) == AXUIElementGetTypeID() else { return (nil, nil) }
    let window = unsafeBitCast(rawWindow, to: AXUIElement.self)
    _ = AXUIElementSetMessagingTimeout(window, 0.15)
    let rawTitle = copyAttribute(window, kAXTitleAttribute) as? String
    let title = rawTitle.flatMap { $0.utf16.count <= 512 && $0.utf8.count <= 2048 ? $0 : nil }
    guard let rawPosition = copyAttribute(window, kAXPositionAttribute), CFGetTypeID(rawPosition) == AXValueGetTypeID(),
          let rawSize = copyAttribute(window, kAXSizeAttribute), CFGetTypeID(rawSize) == AXValueGetTypeID() else { return (title, nil) }
    let position = unsafeBitCast(rawPosition, to: AXValue.self)
    let size = unsafeBitCast(rawSize, to: AXValue.self)
    var point = CGPoint.zero, dimensions = CGSize.zero
    guard AXValueGetType(position) == .cgPoint, AXValueGetType(size) == .cgSize,
          AXValueGetValue(position, .cgPoint, &point), AXValueGetValue(size, .cgSize, &dimensions) else { return (title, nil) }
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0, count <= 128 else { return (title, nil) }
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    guard CGGetActiveDisplayList(count, &ids, &count) == .success,
          let display = displayForWindow(CGRect(origin: point, size: dimensions), displays: ids.prefix(Int(count)).map { ($0, CGDisplayBounds($0)) }),
          let uuid = CGDisplayCreateUUIDFromDisplayID(display)?.takeRetainedValue() else { return (title, nil) }
    return (title, CFUUIDCreateString(nil, uuid) as String)
}
func selfTestWindowContext() {
    let displays: [(CGDirectDisplayID, CGRect)] = [(1, CGRect(x: 0, y: 0, width: 100, height: 100)), (2, CGRect(x: 100, y: 0, width: 100, height: 100))]
    precondition(displayForWindow(CGRect(x: 80, y: 10, width: 70, height: 50), displays: displays) == 2)
    precondition(displayForWindow(CGRect(x: 500, y: 0, width: 20, height: 20), displays: displays) == nil)
    precondition(displayForWindow(CGRect(x: 0, y: 0, width: 0, height: 0), displays: displays) == nil)
    precondition(displayForWindow(CGRect(x: 75, y: 0, width: 50, height: 50), displays: displays) == 1)
    print("{\"available\":true,\"appBundleId\":\"com.example.Synthetic\",\"windowTitle\":\"Synthetic window\",\"displayId\":\"00000000-0000-0000-0000-000000000001\"}")
}

// App identity remains available independently of Accessibility permission.
// https://developer.apple.com/documentation/appkit/nsworkspace/frontmostapplication
// https://developer.apple.com/documentation/appkit/nsworkspace/didactivateapplicationnotification
final class ApplicationContextMonitor: NSObject {
    private var lastOutput: Data?
    private var lastHeartbeat: TimeInterval = -.infinity

    func emit(force: Bool = false) {
        let session = CGSessionCopyCurrentDictionary() as? [String: Any]
        let validConsole = session?[kCGSessionOnConsoleKey as String] as? Bool == true
            && session?[kCGSessionLoginDoneKey as String] as? Bool == true
        let app = validConsole ? NSWorkspace.shared.frontmostApplication : nil
        let bundle = app?.bundleIdentifier
        let validBundle = bundle == nil || (!bundle!.isEmpty && bundle!.utf8.count <= 512)
        let available = app != nil && validBundle
        // Never inspect focused windows while the session is locked or display asleep.
        let canInspectWindow = validConsole && session?["CGSSessionScreenIsLocked"] as? Bool != true
            && CGDisplayIsAsleep(CGMainDisplayID()) == 0
        let window = available && canInspectWindow ? focusedWindowContext(app!) : (nil, nil)
        let payload: [String: Any] = ["available": available,
                                      "appBundleId": available ? (bundle as Any? ?? NSNull()) : NSNull(),
                                      "windowTitle": window.0 as Any? ?? NSNull(),
                                      "displayId": window.1 as Any? ?? NSNull()]
        guard var data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
              data.count <= 8192 else { return }
        data.append(10)
        let now = ProcessInfo.processInfo.systemUptime
        guard force || data != lastOutput || now - lastHeartbeat >= 2 else { return }
        FileHandle.standardOutput.write(data)
        lastOutput = data
        lastHeartbeat = now
    }

    @objc func changed(_ note: Notification) { emit() }
    @objc func tick(_ timer: Timer) { emit() }
    func start() {
        let center = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.didActivateApplicationNotification,
                     NSWorkspace.sessionDidBecomeActiveNotification,
                     NSWorkspace.sessionDidResignActiveNotification] {
            center.addObserver(self, selector: #selector(changed(_:)), name: name, object: nil)
        }
        emit(force: true)
        let timer = Timer(timeInterval: 0.25, target: self, selector: #selector(tick(_:)), userInfo: nil, repeats: true)
        RunLoop.main.add(timer, forMode: .common)
        RunLoop.main.run()
    }
}

signal(SIGPIPE, SIG_IGN)
let monitor = SessionMonitor()
if CommandLine.arguments.contains("--self-test") {
    selfTestLockState()
} else if CommandLine.arguments.contains("--context-self-test") {
    selfTestWindowContext()
} else if CommandLine.arguments.contains("--context-once") {
    ApplicationContextMonitor().emit(force: true)
} else if CommandLine.arguments.contains("--context") {
    ApplicationContextMonitor().start()
} else if CommandLine.arguments.contains("--once") {
    monitor.reconcile()
    monitor.emit(force: true)
} else {
    monitor.start()
}
