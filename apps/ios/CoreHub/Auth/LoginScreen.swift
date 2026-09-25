// The sign-in screen (preAuth `login`): pair by scanning the QR the web shows, paste the code,
// or give the hub's address with a username and password. Its title is `terms.login`.
import SwiftUI

struct LoginScreen: View {
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n

    @AppStorage(Product.storagePrefix + "last_hub") private var hubText = ""
    @State private var username = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?
    @State private var scanning = false
    @State private var pasting = false
    @State private var pasted = ""

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.s6) {
                    header
                    if let notice = app.notice {
                        NoticeView(text: notice, tone: .warning)
                    }
                    if let error {
                        NoticeView(text: error, tone: .danger)
                    }
                    pairingSection
                    divider
                    passwordSection
                }
                .padding(Space.s6)
                .frame(maxWidth: Layout.readingMax)
                .frame(maxWidth: .infinity)
            }
            .background(Tone.bg)
            .navigationTitle(l10n("nav.login"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { LanguageMenu() }
            }
            .sheet(isPresented: $scanning) {
                QRScannerSheet { text in
                    scanning = false
                    pair(with: text)
                }
            }
            .alert(l10n("login.paste"), isPresented: $pasting) {
                TextField(l10n("login.paste"), text: $pasted)
                    .environment(\.layoutDirection, .leftToRight)
                Button(l10n("common.cancel"), role: .cancel) { pasted = "" }
                Button(l10n("login.pair")) {
                    let text = pasted
                    pasted = ""
                    pair(with: text)
                }
            } message: {
                Text(l10n("login.paste_hint"))
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            BrandMark(size: 44)
            Text(l10n.productName)
                .font(.system(size: FontSize.size2xl, weight: .bold))
                .foregroundStyle(Tone.text)
        }
    }

    private var pairingSection: some View {
        VStack(alignment: .leading, spacing: Space.s3) {
            Text(l10n("login.scanner_hint"))
                .font(.system(size: FontSize.sizeSm))
                .foregroundStyle(Tone.textMuted)
            Button {
                error = nil
                scanning = true
            } label: {
                Label(l10n("login.scan"), systemImage: "qrcode.viewfinder")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(busy)
            .accessibilityIdentifier("login.scan")
            Button {
                error = nil
                pasting = true
            } label: {
                Label(l10n("login.paste"), systemImage: "doc.on.clipboard")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .disabled(busy)
        }
    }

    private var divider: some View {
        HStack {
            Rectangle().fill(Tone.border).frame(height: 1)
            Text(l10n("login.or")).foregroundStyle(Tone.textFaint).font(.system(size: FontSize.sizeSm))
            Rectangle().fill(Tone.border).frame(height: 1)
        }
    }

    private var passwordSection: some View {
        VStack(alignment: .leading, spacing: Space.s3) {
            LabeledField(label: l10n("login.hub_url")) {
                TextField(l10n("login.hub_url_hint"), text: $hubText)
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .environment(\.layoutDirection, .leftToRight)
                    .accessibilityIdentifier("login.hub")
            }
            LabeledField(label: l10n("login.username")) {
                TextField("", text: $username)
                    .textContentType(.username)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("login.username")
            }
            LabeledField(label: l10n("login.password")) {
                SecureField("", text: $password)
                    .textContentType(.password)
                    .accessibilityIdentifier("login.password")
                    .onSubmit { signIn() }
            }
            Button {
                signIn()
            } label: {
                HStack {
                    if busy { ProgressView() }
                    Text(l10n("login.submit"))
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(busy || username.isEmpty || password.isEmpty || hubText.isEmpty)
            .accessibilityIdentifier("login.submit")
        }
    }

    private func signIn() {
        guard let hub = HubAddress.normalise(hubText) else {
            error = l10n("login.invalid_url")
            return
        }
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                try await app.signIn(hub: hub, username: username, password: password)
                hubText = hub.absoluteString
                password = ""
            } catch SignInProblem.setupRequired {
                error = l10n("login.setup_required")
            } catch {
                self.error = HubFailure(error).describe(l10n)
            }
        }
    }

    private func pair(with text: String) {
        switch PairingPayload.parse(text) {
        case .failure(.expired):
            error = l10n("login.pairing_expired")
        case .failure(.notAPairingCode):
            error = l10n("login.pairing_invalid")
        case .success(let payload):
            busy = true
            error = nil
            Task {
                defer { busy = false }
                do {
                    try await app.pair(payload)
                    hubText = payload.hubURL.absoluteString
                } catch {
                    self.error = HubFailure(error).describe(l10n)
                }
            }
        }
    }
}

struct LabeledField<Content: View>: View {
    let label: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s1) {
            Text(label)
                .font(.system(size: FontSize.sizeSm, weight: .medium))
                .foregroundStyle(Tone.textMuted)
            content
                .padding(.horizontal, Space.s3)
                .frame(minHeight: Control.heightLg)
                .background(Tone.surface, in: RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).strokeBorder(Tone.border))
        }
    }
}
