/**
 * Sakana Chat model registry.
 *
 * As of 2026-06, chat.sakana.ai exposes a single public model:
 *   sakana/namazu-v6.3
 *
 * The Sakana chat-ui backend (a fork of huggingface/chat-ui) does not expose
 * a public /api/models route — the model list is embedded in the SvelteKit
 * server-side rendered page. We hardcode the model here for the OpenAI
 * /v1/models endpoint, but still attempt a remote refresh when an account
 * is configured (best-effort).
 */

export interface RegisteredModel {
  id: string
  object: 'model'
  created: number
  owned_by: string
  context_window?: number
  multimodal?: boolean
  description?: string
}

const DEFAULT_MODELS: RegisteredModel[] = [
  {
    id: 'sakana/namazu-v6.3',
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'sakana',
    context_window: 128_000,
    multimodal: false,
    description: 'Namazu v6.3 — Sakana AI default chat model, tuned for Japanese and general-purpose dialogue.',
  },
  {
    id: 'sakana/namazu-v6.3-no-thinking',
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'sakana',
    context_window: 128_000,
    multimodal: false,
    description: 'Namazu v6.3 with reasoning/thinking disabled (alias).',
  },
]

const DEFAULT_CONTEXT_WINDOW = 128_000
const MODEL_CONTEXT_WINDOWS = new Map<string, number>([
  ['sakana/namazu-v6.3', 128_000],
  ['sakana/namazu-v6.3-no-thinking', 128_000],
])

export function listRegisteredModels(): RegisteredModel[] {
  return [...DEFAULT_MODELS]
}

export function getModelContextWindow(modelId: string): number {
  const baseId = modelId.replace('-no-thinking', '')
  return MODEL_CONTEXT_WINDOWS.get(baseId) ?? DEFAULT_CONTEXT_WINDOW
}

export function isMultimodalModel(_modelId: string): boolean {
  return false
}

export function isThinkingModel(modelId: string): boolean {
  return !modelId.includes('-no-thinking')
}

export function resolveModelId(input: string): string {
  // Allow callers to pass either the full "sakana/namazu-v6.3" or a short alias
  const trimmed = input.trim()
  if (trimmed === 'namazu' || trimmed === 'sakana') return 'sakana/namazu-v6.3'
  if (trimmed === 'namazu-no-thinking' || trimmed === 'sakana-no-thinking') return 'sakana/namazu-v6.3-no-thinking'
  return trimmed
}
