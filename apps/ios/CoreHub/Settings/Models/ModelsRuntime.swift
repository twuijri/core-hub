// "I added a provider — did anything happen?" (the web's RuntimeChecks): the steps the hub takes to
// hand a provider to the agent runtime, as five checks from `models.getRuntime`, on the Models
// page's Providers tab; and «Fetch» in Add a provider, which asks the endpoint itself for its
// models before anything is saved (`models.probeProvider`), in the endpoint's own words.
import CoreHubClient
import SwiftUI

enum RuntimeRules {
    /// The order the steps happen in, which is the order to read them in.
    static let order: [RuntimeCheck.Id] = [.runtimeWritable, .providerKeys, .providerVerified, .modelSelected, .gatewayReloaded]

    /// What failed first, each half in the order the steps happen in.
    static func failingFirst(_ checks: [RuntimeCheck]) -> [RuntimeCheck] {
        let sorted = checks.sorted { (order.firstIndex(of: $0.id) ?? 99) < (order.firstIndex(of: $1.id) ?? 99) }
        return sorted.filter { !$0.ok } + sorted.filter(\.ok)
    }

    /// The hub's own restart of Hermes on its way (DECISIONS §145): `scheduled` or `waiting_for_run`.
    static func restartOnItsWay(_ check: RuntimeCheck) -> Bool {
        check.id == .gatewayReloaded && !check.ok && (check.detail == "scheduled" || check.detail == "waiting_for_run")
    }

    /// The words for one check: the hub's restart on its way has its own.
    static func textKey(_ check: RuntimeCheck) -> String {
        if restartOnItsWay(check), let detail = check.detail { return "models_runtime.\(check.id.rawValue).\(detail)" }
        return "models_runtime.\(check.id.rawValue).\(check.ok ? "ok" : "missing")"
    }

    /// A pending restart is a thing to do, not a thing broken.
    static func onlyRestartPending(_ checks: [RuntimeCheck]) -> Bool {
        checks.allSatisfy { $0.ok || $0.id == .gatewayReloaded } && checks.contains { !$0.ok }
    }

    /// The chat models a probe found (a model that only draws is never a chat default).
    static func chatModels(_ result: ProviderProbeResult) -> [ProviderProbeResultModelsInner] {
        result.models.filter { $0.imageOnly != true }
    }
}

/// The Runtime card: one line while every check passes (a tap lists them), open by itself the
/// moment one fails, with Restart now when only a restart is missing.
struct RuntimeCardSection: View {
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var report: RuntimeReport?
    @State private var expanded = false
    @State private var restarting = false
    @State private var note: String?

    var body: some View {
        Section {
            if let report {
                let checks = RuntimeRules.failingFirst(report.checks)
                let passed = checks.filter(\.ok).count
                let allOK = !checks.isEmpty && passed == checks.count
                Button {
                    expanded.toggle()
                } label: {
                    HStack {
                        StatusPill(
                            text: allOK ? l10n("models_runtime.ready", ["passed": String(passed), "total": String(checks.count)])
                                : l10n("models_runtime.passed", ["passed": String(passed), "total": String(checks.count)]),
                            kind: allOK ? .good : RuntimeRules.onlyRestartPending(checks) ? .warn : .bad
                        )
                        Spacer()
                        LucideIcon(expanded || !allOK ? .chevronUp : .chevronDown, size: 14).foregroundStyle(Tone.textFaint)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("models.runtime")
                if expanded || !allOK {
                    Text(l10n("models_runtime.hint")).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                    ForEach(checks, id: \.id) { check in
                        let pending = !check.ok && check.id == .gatewayReloaded
                        HStack(alignment: .firstTextBaseline, spacing: Space.s2) {
                            LucideIcon(check.ok ? .check : pending ? .triangleAlert : .x, size: 14)
                                .foregroundStyle(check.ok ? Tone.successSoftText : pending ? Tone.warningSoftText : Tone.dangerSoftText)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(l10n(RuntimeRules.textKey(check)))
                                    .font(.system(size: FontSize.sizeSm, weight: check.ok ? .regular : .medium))
                                if let detail = check.detail, !detail.isEmpty, check.id != .gatewayReloaded {
                                    Text(detail).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                                }
                            }
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("models.runtime.\(check.id.rawValue)")
                    }
                    // Only when no restart of the hub's own is coming: the way out, not the normal flow.
                    if checks.contains(where: { $0.id == .gatewayReloaded && !$0.ok && !RuntimeRules.restartOnItsWay($0) }),
                       let hermes = restartable {
                        Button(l10n("models_runtime.restart_now")) { Task { await restart(hermes) } }
                            .disabled(restarting)
                            .accessibilityIdentifier("models.runtime.restart")
                    }
                    if let note { Text(note).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted) }
                }
            }
        } header: {
            Text(l10n("models_runtime.title"))
        }
        .task(id: app.currentProfile) {
            await load()
            // While the hub's own restart is on its way, ask again until it has happened.
            while !Task.isCancelled, report?.checks.contains(where: RuntimeRules.restartOnItsWay) == true {
                try? await Task.sleep(for: .seconds(2))
                await load()
            }
        }
    }

    /// The profile's Hermes, when this person may restart it.
    private var restartable: Agent? {
        guard app.isAdmin else { return nil }
        return app.agentDirectory.agents(app.currentProfile).first { $0.kind == .hermes && AgentCardRules.canRestart($0) }
    }

    private func load() async {
        let profile = app.currentProfile
        report = try? await app.api.call { try await ModelsAPI.modelsGetRuntime(xHubProfile: profile, apiConfiguration: $0) }
    }

    private func restart(_ agent: Agent) async {
        let profile = app.currentProfile, id = agent.id, api = app.api
        restarting = true
        defer { restarting = false }
        do {
            let accepted = try await api.call { try await AgentsAPI.agentsRestart(xHubProfile: profile, agentId: id, apiConfiguration: $0) }
            let job = try await AgentJobs.follow(accepted.jobId, profile: profile, api: api) { _ in }
            note = job.status == .succeeded ? nil : (job.error?.error ?? l10n("agents2.ch.status.error"))
        } catch is CancellationError {
            return
        } catch {
            note = HubFailure(error).describe(l10n)
        }
        await load()
    }
}

/// «Fetch»: asks the endpoint for its models before anything is saved, and shows what came back —
/// the models, or the endpoint's own words.
struct ProviderProbeSection: View {
    let preset: String?
    let baseURL: String
    let key: String
    var kind: ProviderKind? = nil
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var busy = false
    @State private var found: [ProviderProbeResultModelsInner]?
    @State private var problem: String?

    var body: some View {
        Section {
            Button {
                Task { await probe() }
            } label: {
                LucideLabel(l10n(busy ? "models_runtime.fetching" : "models_runtime.fetch"), icon: .refreshCw, size: 16)
            }
            .disabled(busy || baseURL.trimmingCharacters(in: .whitespaces).isEmpty && preset == nil)
            .accessibilityIdentifier("provider.fetch")
            if let problem { NoticeView(text: problem, tone: .warning) }
            if let found, !found.isEmpty {
                Text(l10n("models_runtime.fetched", ["count": String(found.count)])).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                ForEach(found.prefix(30), id: \.id) { model in
                    Text(model.label == model.id ? model.id : "\(model.label) · \(model.id)")
                        .font(.system(size: FontSize.sizeXs, design: .monospaced))
                        .environment(\.layoutDirection, .leftToRight)
                }
            }
        } footer: {
            Text(l10n("models_runtime.fetch_hint"))
        }
    }

    private func probe() async {
        busy = true
        defer { busy = false }
        found = nil
        problem = nil
        let profile = app.currentProfile
        let url = baseURL.trimmingCharacters(in: .whitespaces), secret = key.trimmingCharacters(in: .whitespaces)
        let body = ProviderProbe(preset: preset, baseUrl: url.isEmpty ? nil : url, apiKey: secret.isEmpty ? nil : secret, kind: kind)
        do {
            let result = try await app.api.call { try await ModelsAPI.modelsProbeProvider(xHubProfile: profile, providerProbe: body, apiConfiguration: $0) }
            guard result.ok else {
                problem = result.message ?? l10n("models_runtime.fetch_failed")
                return
            }
            let chat = kind == nil || kind == .llm ? RuntimeRules.chatModels(result) : result.models
            found = chat
            if chat.isEmpty { problem = l10n("models_runtime.fetch_empty") }
        } catch {
            problem = HubFailure(error).describe(l10n)
        }
    }
}
