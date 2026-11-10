import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { createMockModel, createMockScreenModel, type MockBehavior } from "./mock-model";

export interface ModelConfig {
  provider: "mock" | "ollama" | "anthropic";
  model: string;
  mockBehavior?: MockBehavior;
  ollamaUrl?: string;
  anthropicApiKey?: string;
}

export function createModel(c: ModelConfig): { model: LanguageModel; name: string } {
  switch (c.provider) {
    case "mock": {
      const model = createMockModel(c.mockBehavior);
      return { model, name: model.modelId };
    }
    case "ollama": {
      const p = createOpenAICompatible({ name: "ollama", baseURL: c.ollamaUrl ?? "http://localhost:11434/v1" });
      return { model: p(c.model), name: `ollama/${c.model}` };
    }
    case "anthropic":
      return { model: createAnthropic({ apiKey: c.anthropicApiKey })(c.model), name: c.model };
  }
}

export function createScreenModel(c: ModelConfig & { screen?: "blind" | "paranoid" }): LanguageModel {
  return c.provider === "mock" ? createMockScreenModel(c.screen ?? "blind") : createModel(c).model;
}
