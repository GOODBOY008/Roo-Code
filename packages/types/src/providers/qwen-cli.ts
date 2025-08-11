import type { ModelInfo } from "../model.js"

// Qwen CLI models with free tier pricing (all $0)
export type QwenCliModelId = keyof typeof qwenCliModels

export const qwenCliDefaultModelId: QwenCliModelId = "qwen3-coder-plus"

export const qwenCliModels = {
	"qwen3-coder-plus": {
		maxTokens: 32_768,
		contextWindow: 1_048_576,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 0,
		outputPrice: 0,
	},
} as const satisfies Record<string, ModelInfo>
