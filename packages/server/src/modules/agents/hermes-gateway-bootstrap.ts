/**
 * The ticket for attaching to a profile's running Hermes gateway (`adapters/hermes-gateway-channel.ts`).
 *
 * Hermes's own clients get it the same way (`ui-tui/scripts/gateway_bootstrap.py` in its MIT
 * source, which the image does not ship): with Hermes's Python, discover the profile's gateway
 * (`hermes_cli.gateway_runtime.discover_gateway_endpoint`), ask the control socket of the home
 * that serves it (`control_home_for`: a profile the default gateway multiplexes has none of its
 * own) for an `interactive` session ticket, and turn endpoint and ticket into the WebSocket
 * address and subprotocols (`hermes_cli.gateway_client.gateway_ws_target`). The control socket
 * only answers its own OS user, so the ticket never leaves this host's processes.
 *
 * The hub never starts a gateway here: in its own home it runs the gateway itself (a
 * conversation arriving while that one restarts waits and asks again), and a Hermes somebody
 * else runs is theirs to start.
 *
 * A Hermes whose stdio entry still serves a home beside the gateway (before v0.22.2, no
 * `_claim_launch_home`) answers `unsupported`, and the hub keeps speaking to it over stdio.
 */
import { execFile } from 'node:child_process';
import type { GatewayBootstrap } from './adapters/hermes-gateway-channel.js';

/** One line of JSON on stdout: `{kind, url?, protocols?, reason?}`. Never the ticket in a log. */
export const GATEWAY_BOOTSTRAP_SCRIPT = String.raw`
import importlib.util, json, os, sys
def say(**fields):
    print(json.dumps(fields))
    sys.exit(0)
try:
    spec = importlib.util.find_spec('tui_gateway.entry')
    with open(spec.origin, encoding='utf-8') as source:
        refuses = '_claim_launch_home' in source.read()
except Exception:
    refuses = False
if not refuses:
    say(kind='unsupported')
try:
    from hermes_constants import get_hermes_home
    from hermes_cli.gateway_runtime import attachable, control_home_for, discover_gateway_endpoint
    from hermes_cli.gateway_client import gateway_ws_target
except ImportError as exc:
    say(kind='unavailable', reason='this Hermes cannot be attached to: %s' % exc)
try:
    home = get_hermes_home().resolve()
    receipt = discover_gateway_endpoint(home, timeout=5)
    if not attachable(receipt):
        say(kind='unavailable', reason='gateway %s: %s' % (receipt.state, receipt.reason_code or 'not ready'))
    endpoint = receipt.endpoint
    control = control_home_for(home, endpoint)
    request = json.dumps({'protocol': 1, 'id': 1, 'verb': 'session-ticket', 'params': {
        'profile_id': endpoint.profile_id, 'instance_id': endpoint.instance_id,
        'purpose': 'interactive'}}).encode() + b'\n'
    if os.name == 'nt':
        from gateway.runtime_bootstrap_windows import query_runtime_control
        raw = query_runtime_control(control, request, 5)
    else:
        from hermes_cli.gateway_runtime_discovery import connect_private
        with connect_private(control, 5) as peer:
            peer.sendall(request)
            with peer.makefile('rb') as stream:
                raw = stream.readline(65537)
    answer = json.loads(raw)
    grant = answer.get('result', {})
    if (answer.get('ok') is not True or grant.get('instance_id') != endpoint.instance_id
            or grant.get('profile_id') != endpoint.profile_id or not isinstance(grant.get('ticket'), str)):
        say(kind='unavailable', reason='the gateway refused a session ticket')
    url, protocols = gateway_ws_target(endpoint, grant['ticket'])
    say(kind='attach', url=url, protocols=list(protocols))
except SystemExit:
    raise
except Exception as exc:
    say(kind='unavailable', reason='%s: %s' % (type(exc).__name__, str(exc)[:200]))
`;

/** Runs the bootstrap with Hermes's Python, in `home` (the root home, or a profile's). */
export function bootstrapGateway(input: {
  python: string;
  env: NodeJS.ProcessEnv;
  home: string;
  timeoutMs?: number;
}): Promise<GatewayBootstrap> {
  return new Promise((resolve) => {
    execFile(
      input.python,
      ['-c', GATEWAY_BOOTSTRAP_SCRIPT],
      {
        env: { ...input.env, HERMES_HOME: input.home },
        cwd: input.home,
        timeout: input.timeoutMs ?? 30_000,
        maxBuffer: 256 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        const line = String(stdout ?? '')
          .trim()
          .split('\n')
          .pop();
        try {
          const parsed = JSON.parse(line ?? '') as Record<string, unknown>;
          if (
            parsed.kind === 'attach' &&
            typeof parsed.url === 'string' &&
            Array.isArray(parsed.protocols)
          ) {
            resolve({ kind: 'attach', url: parsed.url, protocols: parsed.protocols.map(String) });
            return;
          }
          if (parsed.kind === 'unsupported') {
            resolve({ kind: 'unsupported' });
            return;
          }
          if (parsed.kind === 'unavailable') {
            resolve({ kind: 'unavailable', reason: String(parsed.reason ?? 'not ready') });
            return;
          }
        } catch {
          // not our line: said below
        }
        // A Python that did not run the script at all is not attachable, and not a reason to go
        // back to stdio either: beside a gateway that is down, stdio would take its home.
        resolve({
          kind: 'unavailable',
          reason: error
            ? `the Hermes bootstrap failed (${error.message.slice(0, 200)})`
            : 'no answer',
        });
      },
    );
  });
}
