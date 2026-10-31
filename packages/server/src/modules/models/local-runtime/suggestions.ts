/**
 * A short list of Ollama models to offer with one click (ADR 0032 §4). Any other name from
 * <https://ollama.com/library> can be typed in. Sizes are the download as the library lists it,
 * rounded; `memory_bytes` is the least RAM the model is pleasant in, which marks it "fits".
 * Every entry here can call tools, so the hub's agents (the Hermes helper among them) can use it.
 */
export interface SuggestedModel {
  name: string;
  /** About what the download weighs. */
  size_bytes: number;
  memory_bytes: number;
  tools: boolean;
}

const GB = 1024 ** 3;

export const SUGGESTED_MODELS: readonly SuggestedModel[] = [
  { name: 'llama3.2:3b', size_bytes: 2.0 * GB, memory_bytes: 8 * GB, tools: true },
  { name: 'qwen3:4b', size_bytes: 2.5 * GB, memory_bytes: 8 * GB, tools: true },
  { name: 'qwen3:8b', size_bytes: 5.2 * GB, memory_bytes: 16 * GB, tools: true },
  { name: 'llama3.1:8b', size_bytes: 4.9 * GB, memory_bytes: 16 * GB, tools: true },
  { name: 'qwen2.5-coder:7b', size_bytes: 4.7 * GB, memory_bytes: 16 * GB, tools: true },
  { name: 'gpt-oss:20b', size_bytes: 14 * GB, memory_bytes: 24 * GB, tools: true },
];
