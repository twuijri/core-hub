// The host variables of a multi-provider agent (DECISIONS §139): what it reads to reach the
// providers it supports, beyond the keys the hub hands it.
/**
 * The provider variables a multi-provider agent reads (Goose, OpenCode, Pi): a person who set
 * one in the host's environment for that agent keeps it working.
 */
export const PROVIDER_HOST_ENV: readonly string[] = [
  'ANTHROPIC_*',
  'OPENAI_*',
  'AZURE_*',
  'OPENROUTER_*',
  'GEMINI_*',
  'GOOGLE_*',
  'VERTEX_*',
  'GCP_*',
  'AWS_*',
  'GROQ_*',
  'MISTRAL_*',
  'DEEPSEEK_*',
  'XAI_*',
  'CEREBRAS_*',
  'TOGETHER_*',
  'FIREWORKS_*',
  'PERPLEXITY_*',
  'OLLAMA_*',
  'LMSTUDIO_*',
  'LITELLM_*',
  'DATABRICKS_*',
  'HF_TOKEN',
  'HUGGINGFACE_*',
  'DASHSCOPE_*',
  'MOONSHOT_*',
  'ZAI_*',
  'MINIMAX_*',
];
