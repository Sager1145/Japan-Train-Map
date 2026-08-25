import UIKit

/// When the app may ask for its next presentation.
///
/// Every alert, confirmation and sheet the workspace puts over itself is
/// presented by ONE controller — the resident sheet's, see
/// `ContentView.withPresentations` — and a controller that is already
/// presenting cannot present again. UIKit does not queue the second request:
/// it drops it, writes *"Attempt to present … which is already presenting"* to
/// the console, and the surface the reader asked for never appears. Nothing
/// about that failure is visible in the app. It is a tap that did nothing.
///
/// Two view files had grown the same private helper for this, and both waited
/// a fixed 350 ms — long enough for the menu whose callback they run inside,
/// but a guess about the alert underneath it. How long a dismissal takes is
/// not ours to know: an alert on iOS 26 animates out over the best part of a
/// second, and a duration measured on this simulator is not a promise about a
/// device or about the next release. So the wait is on the CONDITION as well —
/// UIKit is asked whether anything is still on screen or mid-transition, and
/// the action is published the moment nothing is.
@MainActor
enum PresentationHost {
    /// The delay every menu, context-menu and alert action callback needs
    /// before it may publish state that starts a presentation: they all run
    /// while UIKit is still tearing their own controller down.
    private static let teardown = Duration.milliseconds(350)

    /// Publishes state that will start a presentation, once the controller
    /// that would present it is free to.
    static func afterTeardown(_ action: @escaping @MainActor () -> Void) {
        Task { @MainActor in
            try? await Task.sleep(for: teardown)
            await settle()
            action()
        }
    }

    /// Waits for the presentation stack to go quiet, and gives up after
    /// `timeout` rather than leaving the caller's state unpublished for ever:
    /// a surface that appears late is a smaller failure than one that never
    /// appears at all, which is the failure this type exists to end.
    static func settle(timeout: Duration = .milliseconds(1500)) async {
        let started = ContinuousClock.now
        while !isIdle, ContinuousClock.now - started < timeout {
            try? await Task.sleep(for: .milliseconds(16))
        }
    }

    /// Whether the host can present right now.
    ///
    /// An alert — `UIAlertController`, which is what SwiftUI's `.alert` and
    /// `.confirmationDialog` both become — is the one thing that takes the
    /// slot the workspace needs and then leaves on its own. A sheet does not
    /// count: the sheets here are driven by state SwiftUI swaps for itself,
    /// and waiting for one to close would hold the next surface back for as
    /// long as the reader keeps it open.
    static var isIdle: Bool {
        guard let top = topmost else { return true }
        if top.isBeingPresented || top.isBeingDismissed { return false }
        return !(top is UIAlertController)
    }

    private static var topmost: UIViewController? {
        let window = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow }
        var controller = window?.rootViewController
        while let presented = controller?.presentedViewController {
            controller = presented
        }
        return controller
    }
}
