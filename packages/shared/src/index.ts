// Categories that users can make predictions on
export type PredictionCategory = "accuracy" | "speed" | "code_length";

// Represents the information needed to identify an LLM
export interface LLMModel {
  id: string;
  name: string;
  provider: string;
}
