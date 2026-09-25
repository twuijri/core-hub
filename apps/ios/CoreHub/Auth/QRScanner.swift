// The camera half of pairing: AVFoundation reads a QR code and hands its text back once.
// No camera (the simulator) or no permission says so, with the paste route still open.
import AVFoundation
import SwiftUI
import UIKit

struct QRScannerSheet: View {
    let onCode: (String) -> Void
    @Environment(\.l10n) private var l10n
    @Environment(\.dismiss) private var dismiss
    @State private var access: AVAuthorizationStatus = AVCaptureDevice.authorizationStatus(for: .video)

    var body: some View {
        NavigationStack {
            Group {
                if AVCaptureDevice.default(for: .video) == nil {
                    message(l10n("login.camera_unavailable"))
                } else {
                    switch access {
                    case .authorized:
                        QRCameraView(onCode: onCode)
                            .ignoresSafeArea()
                            .overlay(alignment: .bottom) {
                                Text(l10n("login.scanner_hint"))
                                    .font(.system(size: FontSize.sizeSm))
                                    .padding(Space.s3)
                                    .floatingChrome()
                                    .padding(Space.s4)
                            }
                    case .notDetermined:
                        ProgressView().task {
                            let granted = await AVCaptureDevice.requestAccess(for: .video)
                            access = granted ? .authorized : .denied
                        }
                    default:
                        message(l10n("login.camera_denied"))
                    }
                }
            }
            .navigationTitle(l10n("login.scan"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(l10n("common.close")) { dismiss() }
                }
            }
        }
    }

    private func message(_ text: String) -> some View {
        Text(text)
            .multilineTextAlignment(.center)
            .foregroundStyle(Tone.textMuted)
            .padding(Space.s6)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct QRCameraView: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> QRCameraController {
        let controller = QRCameraController()
        controller.onCode = onCode
        return controller
    }

    func updateUIViewController(_ controller: QRCameraController, context: Context) {}
}

final class QRCameraController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?
    private let session = AVCaptureSession()
    private var preview: AVCaptureVideoPreviewLayer?
    private var delivered = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else { return }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(layer)
        preview = layer
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        let session = self.session
        DispatchQueue.global(qos: .userInitiated).async { session.startRunning() }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        let session = self.session
        DispatchQueue.global(qos: .userInitiated).async { session.stopRunning() }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !delivered,
              let code = metadataObjects.compactMap({ $0 as? AVMetadataMachineReadableCodeObject }).first?.stringValue
        else { return }
        delivered = true
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        onCode?(code)
    }
}
