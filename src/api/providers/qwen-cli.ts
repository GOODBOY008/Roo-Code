import type { Anthropic } from "@anthropic-ai/sdk"
import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"
import axios from "axios"

import { type ModelInfo, type QwenCliModelId, qwenCliDefaultModelId, qwenCliModels } from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"
import { t } from "../../i18n"

import type { ApiStream } from "../transform/stream"
import { getModelParams } from "../transform/model-params"

import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "../index"
import { BaseProvider } from "./base-provider"

// OAuth2 configuration matching qwen-code implementation
const QWEN_OAUTH_BASE_URL = "https://chat.qwen.ai"
const QWEN_OAUTH_TOKEN_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/token`
const QWEN_OAUTH_CLIENT_ID = "f0304373b74a44d2b584a3fb70ca9e56"
const QWEN_DIR = ".qwen"
const QWEN_CREDENTIAL_FILENAME = "oauth_creds.json"
const DEFAULT_QWEN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"

interface QwenOAuthCredentials {
	access_token?: string
	refresh_token?: string
	id_token?: string
	expiry_date?: number
	token_type?: string
	resource_url?: string
}

interface QwenApiRequestBody {
	model: string
	messages: Array<{ role: string; content: string }>
	stream?: boolean
	temperature?: number
	max_tokens?: number
	thinking?: unknown
}

interface QwenUsageMetadata {
	prompt_tokens?: number
	completion_tokens?: number
	total_tokens?: number
}

interface QwenStreamResponse {
	choices?: Array<{
		delta?: { content?: string }
		finish_reason?: string
	}>
	usage?: QwenUsageMetadata
}

interface QwenCompletionResponse {
	choices?: Array<{
		message?: { content?: string }
	}>
	usage?: QwenUsageMetadata
}

export class QwenCliHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: ApiHandlerOptions
	private credentials: QwenOAuthCredentials | null = null
	private baseUrl = DEFAULT_QWEN_BASE_URL

	constructor(options: ApiHandlerOptions) {
		super()
		this.options = options
	}

	private async loadQwenCredentials(): Promise<void> {
		try {
			const credPath =
				this.options.qwenCliOAuthPath || path.join(os.homedir(), QWEN_DIR, QWEN_CREDENTIAL_FILENAME)
			const credData = await fs.readFile(credPath, "utf-8")
			this.credentials = JSON.parse(credData)

			// Update base URL if resource_url is provided
			if (this.credentials?.resource_url) {
				this.baseUrl = this.normalizeEndpoint(this.credentials.resource_url)
			}
		} catch (error) {
			throw new Error(t("common:errors.geminiCli.oauthLoadFailed", { error }))
		}
	}

	private async ensureAuthenticated(): Promise<void> {
		if (!this.credentials) {
			await this.loadQwenCredentials()
		}

		// Check if token needs refresh (30 second buffer)
		if (this.credentials?.expiry_date && this.credentials.expiry_date < Date.now() + 30000) {
			await this.refreshToken()
		}
	}

	private async refreshToken(): Promise<void> {
		if (!this.credentials?.refresh_token) {
			throw new Error(t("common:errors.geminiCli.noRefreshToken"))
		}

		try {
			const response = await axios.post(
				QWEN_OAUTH_TOKEN_ENDPOINT,
				new URLSearchParams({
					grant_type: "refresh_token",
					refresh_token: this.credentials.refresh_token,
					client_id: QWEN_OAUTH_CLIENT_ID,
				}),
				{
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
						Accept: "application/json",
					},
				},
			)

			if (response.data.access_token) {
				this.credentials = {
					access_token: response.data.access_token,
					refresh_token: response.data.refresh_token || this.credentials.refresh_token,
					token_type: response.data.token_type || "Bearer",
					expiry_date: response.data.expires_in
						? Date.now() + response.data.expires_in * 1000
						: Date.now() + 3600 * 1000,
					resource_url: response.data.resource_url,
				}

				// Update base URL if provided
				if (this.credentials.resource_url) {
					this.baseUrl = this.normalizeEndpoint(this.credentials.resource_url)
				}

				// Save refreshed credentials
				const credPath =
					this.options.qwenCliOAuthPath || path.join(os.homedir(), QWEN_DIR, QWEN_CREDENTIAL_FILENAME)
				await fs.mkdir(path.dirname(credPath), { recursive: true })
				await fs.writeFile(credPath, JSON.stringify(this.credentials, null, 2))
			}
		} catch (error) {
			throw new Error(t("common:errors.geminiCli.tokenRefreshFailed", { error }))
		}
	}

	private normalizeEndpoint(endpoint: string): string {
		const suffix = "/v1"
		const normalizedUrl = endpoint.startsWith("http") ? endpoint : `https://${endpoint}`
		return normalizedUrl.endsWith(suffix) ? normalizedUrl : `${normalizedUrl}${suffix}`
	}

	/**
	 * Call a Qwen CLI API endpoint
	 */
	private async callEndpoint(
		endpoint: string,
		body: QwenApiRequestBody,
		streaming: boolean = false,
	): Promise<NodeJS.ReadableStream | QwenCompletionResponse> {
		await this.ensureAuthenticated()

		if (!this.credentials?.access_token) {
			throw new Error(t("common:errors.geminiCli.noAccessToken"))
		}

		const url = `${this.baseUrl}/${endpoint}`

		try {
			const response = await axios({
				method: "POST",
				url,
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.credentials.access_token}`,
				},
				data: JSON.stringify(body),
				responseType: streaming ? "stream" : "json",
			})

			return response.data
		} catch (error: unknown) {
			console.error(`[QwenCLI] Error calling ${endpoint}:`, error)

			// If we get a 401, try refreshing the token once
			if (axios.isAxiosError(error) && error.response?.status === 401) {
				await this.refreshToken()
				// Retry the request
				const retryResponse = await axios({
					method: "POST",
					url,
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${this.credentials?.access_token}`,
					},
					data: JSON.stringify(body),
					responseType: streaming ? "stream" : "json",
				})
				return retryResponse.data
			}

			throw error
		}
	}

	/**
	 * Parse Server-Sent Events from a stream
	 */
	private async *parseSSEStream(stream: NodeJS.ReadableStream): AsyncGenerator<QwenStreamResponse> {
		let buffer = ""

		for await (const chunk of stream) {
			buffer += chunk.toString()
			const lines = buffer.split("\n")
			buffer = lines.pop() || ""

			for (const line of lines) {
				if (line.startsWith("data: ")) {
					const data = line.slice(6).trim()
					if (data === "[DONE]") continue

					try {
						const parsed = JSON.parse(data) as QwenStreamResponse
						yield parsed
					} catch (e) {
						console.error("Error parsing SSE data:", e)
					}
				}
			}
		}
	}

	async *createMessage(
		systemInstruction: string,
		messages: Anthropic.Messages.MessageParam[],
		_metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const { id: model, reasoning: thinkingConfig, maxTokens } = this.getModel()

		// Convert messages to OpenAI-compatible format (since Qwen CLI uses OpenAI-compatible API)
		const openaiMessages = [
			{
				role: "system" as const,
				content: systemInstruction,
			},
			...messages.map((msg) => {
				let content = ""
				if (typeof msg.content === "string") {
					content = msg.content
				} else if (Array.isArray(msg.content)) {
					content = msg.content
						.map((contentBlock) => {
							if (contentBlock.type === "text") {
								return contentBlock.text
							} else if (contentBlock.type === "image") {
								// Handle image content if needed
								return `[Image: ${contentBlock.source.type}]`
							}
							return ""
						})
						.join("")
				}
				return {
					role: msg.role,
					content,
				}
			}),
		]

		// Prepare request body for Qwen CLI API
		const requestBody: QwenApiRequestBody = {
			model: model,
			messages: openaiMessages,
			stream: true,
			temperature: this.options.modelTemperature ?? 0.7,
			max_tokens: this.options.modelMaxTokens ?? maxTokens ?? 32768,
		}

		// Add thinking config if applicable
		if (thinkingConfig) {
			requestBody.thinking = thinkingConfig
		}

		try {
			// Call Qwen CLI streaming endpoint
			const stream = await this.callEndpoint("chat/completions", requestBody, true)

			// Process the SSE stream
			let lastUsageMetadata: QwenUsageMetadata | undefined = undefined

			for await (const jsonData of this.parseSSEStream(stream as NodeJS.ReadableStream)) {
				const choice = jsonData.choices?.[0]

				if (choice?.delta?.content) {
					yield {
						type: "text",
						text: choice.delta.content,
					}
				}

				// Store usage metadata for final reporting
				if (jsonData.usage) {
					lastUsageMetadata = jsonData.usage
				}

				// Check if this is the final chunk
				if (choice?.finish_reason) {
					break
				}
			}

			// Yield final usage information
			if (lastUsageMetadata) {
				const inputTokens = lastUsageMetadata.prompt_tokens ?? 0
				const outputTokens = lastUsageMetadata.completion_tokens ?? 0

				yield {
					type: "usage",
					inputTokens,
					outputTokens,
					totalCost: 0, // Free tier - all costs are 0
				}
			}
		} catch (error: unknown) {
			console.error("[QwenCLI] API Error:", error)

			if (axios.isAxiosError(error)) {
				if (error.response?.status === 429) {
					throw new Error(t("common:errors.geminiCli.rateLimitExceeded"))
				}
				if (error.response?.status === 400) {
					throw new Error(
						t("common:errors.geminiCli.badRequest", {
							details: JSON.stringify(error.response?.data) || error.message,
						}),
					)
				}
			}

			const errorMessage = error instanceof Error ? error.message : String(error)
			throw new Error(t("common:errors.geminiCli.apiError", { error: errorMessage }))
		}
	}

	override getModel() {
		const modelId = this.options.apiModelId
		const id = modelId && modelId in qwenCliModels ? (modelId as QwenCliModelId) : qwenCliDefaultModelId
		const info: ModelInfo = qwenCliModels[id]
		const params = getModelParams({ format: "openai", modelId: id, model: info, settings: this.options })

		// Return the model ID
		return { id, info, ...params }
	}

	async completePrompt(prompt: string): Promise<string> {
		const { id: model } = this.getModel()

		try {
			const requestBody: QwenApiRequestBody = {
				model: model,
				messages: [{ role: "user", content: prompt }],
				temperature: this.options.modelTemperature ?? 0.7,
			}

			const response = await this.callEndpoint("chat/completions", requestBody, false)

			// Extract text from response (non-streaming)
			if (response && typeof response === "object" && "choices" in response) {
				const typedResponse = response as QwenCompletionResponse
				if (typedResponse.choices && typedResponse.choices.length > 0) {
					const choice = typedResponse.choices[0]
					if (choice.message?.content) {
						return choice.message.content
					}
				}
			}

			return ""
		} catch (error) {
			if (error instanceof Error) {
				throw new Error(t("common:errors.geminiCli.completionError", { error: error.message }))
			}
			throw error
		}
	}

	override async countTokens(content: Array<Anthropic.Messages.ContentBlockParam>): Promise<number> {
		// For OAuth/free tier, we can't use a token counting API
		// Fall back to the base provider's tiktoken implementation
		return super.countTokens(content)
	}
}
