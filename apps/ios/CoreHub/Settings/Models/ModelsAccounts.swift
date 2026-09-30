// A subscription signed in to through Core Hub's gateway (DECISIONS §143), on the phone: the
// provider's page lists its accounts as the web's dialog does — who, how each stands, its usage
// windows with what is left and when each resets, its requests, the vendor's last words — with
// "Check now". "Add provider" offers the subscriptions too; the sign-in itself is the page every
// sign-in uses, which takes a pasted-back address for a sign-in by link. A hub without any of this
// answers 404 and the phone shows nothing new.
import CoreHubClient
import SwiftUI

struct ProviderAccountsSection: View {
    let providerId: String
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var answer: ProviderAccounts?
    @State private var error: String?
    @State private var checking: String?

    var body: some View {
        Section {
            if let error { NoticeView(text: error, tone: .danger) }
            if let answer {
                if !answer.available {
                    NoticeView(text: l10n("subscriptions.unavailable", ["reason": answer.reason ?? "—"]), tone: .warning)
                } else if answer.accounts.isEmpty {
                    Text(l10n("subscriptions.none")).font(.system(size: FontSize.sizeSm)).foregroundStyle(Tone.textMuted)
                }
                ForEach(answer.accounts, id: \.id) { account in
                    accountRow(account)
                }
                if !answer.errors.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(l10n("subscriptions.errors")).font(.system(size: FontSize.sizeSm, weight: .medium))
                        ForEach(Array(answer.errors.prefix(5).enumerated()), id: \.offset) { _, item in
                            Text(item.status.map { "\($0) · \(item.message)" } ?? item.message)
                                .font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                                .contentDirection(of: item.message)
                        }
                    }
                    .accessibilityIdentifier("provider.accounts.errors")
                }
            } else if error == nil {
                ProgressView().frame(maxWidth: .infinity)
            }
        } header: {
            Text(l10n("subscriptions.accounts"))
        }
        .task(id: providerId) { await load() }
    }

    private func accountRow(_ account: ProviderAccount) -> some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            HStack {
                Text(account.label).font(.system(size: FontSize.sizeMd, weight: .medium))
                    .environment(\.layoutDirection, .leftToRight)
                Spacer()
                if let plan = account.plan { StatusPill(text: plan, kind: .neutral) }
                StatusPill(text: l10n("subscriptions.status.\(account.status.rawValue)"), kind: kind(account.status))
                    .accessibilityIdentifier("provider.account.status")
            }
            if let message = account.statusMessage {
                Text(message).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted).contentDirection(of: message)
            }
            if let retry = account.nextRetryAt {
                Text("\(l10n("subscriptions.retry_at")) \(relative(retry))").font(.system(size: FontSize.sizeXs))
            }
            ForEach(account.windows, id: \.id) { window in
                windowRow(window)
            }
            if account.windows.isEmpty {
                Text(l10n("subscriptions.no_windows")).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
            }
            if let reason = account.checkError {
                NoticeView(text: l10n("subscriptions.check_failed", ["reason": reason]), tone: .warning)
            }
            Text(l10n("subscriptions.requests", ["success": String(account.requests.success), "failed": String(account.requests.failed)]))
                .font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                .accessibilityIdentifier("provider.account.requests")
            if app.isAdmin {
                Button {
                    Task { await check(account) }
                } label: {
                    LucideLabel(l10n("subscriptions.check"), icon: .refreshCw, size: 14)
                }
                .buttonStyle(.bordered)
                .disabled(checking != nil)
                .accessibilityIdentifier("provider.account.check")
            }
        }
        .padding(.vertical, Space.s1)
        .accessibilityIdentifier("provider.account.\(account.id)")
    }

    private func windowRow(_ window: UsageWindow) -> some View {
        let used = min(100, max(0, window.usedPercent ?? 0))
        return VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(window.label ?? window.id).font(.system(size: FontSize.sizeXs, weight: .medium))
                if window.usedPercent != nil {
                    Text(l10n("subscriptions.left", ["percent": String(Int((100 - used).rounded()))]))
                        .font(.system(size: FontSize.sizeXs))
                        .accessibilityIdentifier("provider.account.left")
                }
                Spacer()
                if let resets = window.resetsAt {
                    Text("\(l10n("subscriptions.resets")) \(relative(resets))")
                        .font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                }
            }
            if window.usedPercent != nil {
                ProgressView(value: used, total: 100).tint(used >= 90 ? Tone.danger : Tone.accent)
            }
        }
    }

    private func kind(_ status: ProviderAccount.Status) -> StatusPill.Kind {
        switch status {
        case .active: return .good
        case .cooling, .refreshing: return .warn
        case .error: return .bad
        case .disabled, .unknown: return .neutral
        }
    }

    private func relative(_ date: Date) -> String {
        date.formatted(Date.RelativeFormatStyle(presentation: .named).locale(app.language.locale))
    }

    private func load() async {
        let profile = app.currentProfile, id = providerId
        do {
            answer = try await app.api.call { try await ModelsAPI.modelsGetProviderAccounts(xHubProfile: profile, providerId: id, apiConfiguration: $0) }
            error = nil
        } catch is CancellationError {
        } catch {
            self.error = HubFailure(error).describe(l10n)
        }
    }

    private func check(_ account: ProviderAccount) async {
        checking = account.id
        defer { checking = nil }
        let profile = app.currentProfile, id = providerId, accountID = account.id
        do {
            _ = try await app.api.call { try await ModelsAPI.modelsCheckProviderAccount(xHubProfile: profile, providerId: id, accountId: accountID, apiConfiguration: $0) }
            await load()
        } catch {
            self.error = HubFailure(error).describe(l10n)
        }
    }
}

/// "Sign in with a subscription" in "Add provider": the vendors the hub's gateway signs in to. A
/// subscription added before in the same scope is signed in to again (another account, or the
/// same one renewed). Nothing is shown on a hub that does not offer it.
struct SubscriptionVendorsSection: View {
    let scope: ProviderScope
    let added: [Provider]
    let done: (Provider?) -> Void
    /// Set when the hub can sign in to subscriptions, so the page leaves out what they replace.
    @Binding var available: Bool
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var vendors: SubscriptionVendors?
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        Group {
            if let vendors, !vendors.items.isEmpty {
                Section {
                    if !vendors.available {
                        NoticeView(text: l10n("subscriptions.unavailable", ["reason": vendors.reason ?? "—"]), tone: .warning)
                    }
                    if let error { NoticeView(text: error, tone: .danger) }
                    ForEach(vendors.items, id: \.preset) { vendor in
                        Button {
                            Task { await choose(vendor) }
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(vendor.label).foregroundStyle(Tone.text)
                                Text(l10n(vendor.flow == .device ? "subscriptions.flow_device" : "subscriptions.flow_link"))
                                    .font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                            }
                        }
                        .disabled(!vendors.available || busy)
                        .accessibilityIdentifier("subscription.\(vendor.vendor)")
                    }
                } header: {
                    Text(l10n("subscriptions.title"))
                } footer: {
                    if let note = vendors.note { Text(note) }
                }
            }
        }
        .task(id: app.currentProfile) { await load() }
    }

    private func load() async {
        let profile = app.currentProfile
        // An older hub has no such list (404): nothing to offer, nothing to say.
        vendors = try? await app.api.call { try await ModelsAPI.modelsListSubscriptionVendors(xHubProfile: profile, apiConfiguration: $0) }
        available = vendors?.available == true
    }

    private func choose(_ vendor: SubscriptionVendor) async {
        if let existing = added.first(where: { $0.slug == vendor.preset && $0.scope == scope }) {
            done(existing)
            return
        }
        busy = true
        defer { busy = false }
        let profile = app.currentProfile
        let body = ProviderCreate(preset: vendor.preset, label: vendor.label, kind: .llm, scope: scope)
        do {
            let provider = try await app.api.call { try await ModelsAPI.modelsCreateProvider(xHubProfile: profile, providerCreate: body, apiConfiguration: $0) }
            done(provider)
        } catch {
            self.error = HubFailure(error).describe(l10n)
        }
    }
}
