import {
  fetchChatCompletion as fetchOpenRouterChatCompletion,
  fetchModels as fetchOpenRouterModels,
} from "./openrouter.js";
import {
  fetchOpenAIChatCompletion,
  fetchOpenAIModels,
} from "./openai.js";

export const AI_PROVIDERS = Object.freeze({
  openrouter: Object.freeze({
    id: "openrouter",
    label: "OpenRouter",
    keyLabel: "OpenRouter API Key",
    defaultModel: "anthropic/claude-sonnet-4.5",
    keyPlaceholder: "sk-or-v1-...",
  }),
  openai: Object.freeze({
    id: "openai",
    label: "OpenAI",
    keyLabel: "",
    defaultModel: "gpt-5.6-sol",
    keyPlaceholder: "",
  }),
});

export function normalizeProviderId(value) {
  return Object.hasOwn(AI_PROVIDERS, value) ? value : "openrouter";
}

export function getProviderDefinition(providerId) {
  return AI_PROVIDERS[normalizeProviderId(providerId)];
}

export function getProviderLabel(providerId) {
  return getProviderDefinition(providerId).label;
}

export async function fetchProviderModels(providerId, apiKey) {
  const provider = normalizeProviderId(providerId);
  if (provider === "openai") return fetchOpenAIModels();
  return fetchOpenRouterModels(apiKey);
}

export async function fetchProviderChatCompletion(
  providerId,
  apiKey,
  requestBody,
  options = {},
) {
  const provider = normalizeProviderId(providerId);
  if (provider === "openai") return fetchOpenAIChatCompletion(requestBody, options);
  const messages = Array.isArray(requestBody?.messages)
    ? requestBody.messages.map(({ openai_response_items, ...message }) => message)
    : requestBody?.messages;
  return fetchOpenRouterChatCompletion(apiKey, { ...requestBody, messages }, options);
}
