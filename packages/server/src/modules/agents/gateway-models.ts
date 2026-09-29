/**
 * The model names a coding agent on the hub's model gateway is started with (ADR 0029). The agent
 * never learns which model it really runs on: the gateway resolves each of these to the model the
 * person chose for the turn, so the picker works for every agent with no switch inside it.
 * `models/gateway/gateway.ts` answers to the same names.
 */
export const GATEWAY_MAIN_MODEL = 'corehub-main';
export const GATEWAY_SMALL_MODEL = 'corehub-small';
