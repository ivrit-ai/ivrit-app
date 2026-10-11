import Capacitor
import UIKit

/// Capacitor's web view, with the app's own plugin: Capacitor finds packaged
/// plugins by itself, but one in the app is registered here.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(IvritNativePlugin())
    }
}
