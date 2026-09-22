// Contract entity types, taken from the generated client (ADR 0003). Nothing here is hand-typed.
import type { components } from '@majlis/contracts';

export type Schemas = components['schemas'];
export type Agent = Schemas['Agent'];
export type Approval = Schemas['Approval'];
export type ApprovalDecision = Schemas['ApprovalDecision'];
export type Device = Schemas['Device'];
export type Message = Schemas['Message'];
export type Meta = Schemas['Meta'];
export type Model = Schemas['Model'];
export type ModelDefaults = Schemas['ModelDefaults'];
export type ModelRef = Schemas['ModelRef'];
export type Provider = Schemas['Provider'];
export type ProviderPreset = Schemas['ProviderPreset'];
export type ProviderHost = Schemas['ProviderHost'];
export type Pairing = Schemas['Pairing'];
export type PairingResult = Schemas['PairingResult'];
export type Run = Schemas['Run'];
export type RunAccepted = Schemas['RunAccepted'];
export type Session = Schemas['Session'];
export type SessionDetail = Schemas['SessionDetail'];
export type TokenPair = Schemas['TokenPair'];
export type ToolCall = Schemas['ToolCall'];
export type Usage = Schemas['Usage'];
export type Attachment = Schemas['Attachment'];
export type User = Schemas['User'];
