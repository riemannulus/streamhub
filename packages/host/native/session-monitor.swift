import AppKit
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

signal(SIGPIPE, SIG_IGN)
let monitor = SessionMonitor()
if CommandLine.arguments.contains("--self-test") {
    selfTestLockState()
} else if CommandLine.arguments.contains("--once") {
    monitor.reconcile()
    monitor.emit(force: true)
} else {
    monitor.start()
}
