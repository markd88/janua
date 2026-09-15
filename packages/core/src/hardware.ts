export interface HardwareProfile {
  cpuCount: number;
  totalMemoryGb: number;
}

export interface ModelRecommendation {
  provider: "ollama" | "openai";
  model: string;
  reason: string;
  warning?: string;
}

export interface HardwareRecommendation {
  profile: HardwareProfile;
  recommendation: ModelRecommendation;
}

export function recommendOllamaModel(profile: HardwareProfile): ModelRecommendation {
  if (profile.cpuCount >= 8 && profile.totalMemoryGb >= 24) {
    return {
      provider: "ollama",
      model: "qwen2.5:14b",
      reason: "This machine has enough CPU and memory for a higher quality local model.",
    };
  }

  if (profile.cpuCount >= 4 && profile.totalMemoryGb >= 12) {
    return {
      provider: "ollama",
      model: "qwen2.5:7b",
      reason: "This machine should handle a balanced local model for better answer quality.",
    };
  }

  if (profile.cpuCount >= 2 && profile.totalMemoryGb >= 6) {
    return {
      provider: "ollama",
      model: "llama3.2:3b",
      reason: "This machine is better suited to a smaller local model for acceptable latency.",
      warning: "Responses may still feel slow on CPU-only hardware. Use OpenAI if lead capture latency matters.",
    };
  }

  return {
    provider: "openai",
    model: "gpt-4o-mini",
    reason: "This machine is below the recommended local model baseline.",
    warning: "Use OpenAI or upgrade the host before relying on local Ollama for production traffic.",
  };
}
