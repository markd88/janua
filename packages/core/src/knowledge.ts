import type { BusinessInfo, KnowledgeContext, KnowledgeSource, QAPair } from "./types.js";

export interface BuildKnowledgeContextInput {
  businessInfo: BusinessInfo;
  qaPairs: QAPair[];
  userMessage: string;
  maxCharacters?: number;
}

export function buildKnowledgeContext(input: BuildKnowledgeContextInput): KnowledgeContext {
  const maxCharacters = input.maxCharacters ?? 4_000;
  const sources: KnowledgeSource[] = [];
  const sections: string[] = [];

  const businessLines = [
    ["business_name", input.businessInfo.business_name],
    ["phone", input.businessInfo.phone],
    ["email", input.businessInfo.email],
    ["address", input.businessInfo.address],
    ["store_hours", input.businessInfo.store_hours],
    ["services", input.businessInfo.services],
    ...Object.entries(input.businessInfo.custom_fields),
  ].filter(([, value]) => value.trim().length > 0);

  if (businessLines.length > 0) {
    sections.push(
      [
        "Business Info:",
        ...businessLines.map(([field, value]) => {
          sources.push({ type: "business_info", field });
          return `- ${field}: ${value}`;
        }),
      ].join("\n"),
    );
  }

  const selectedPairs = selectRelevantPairs(input.qaPairs, input.userMessage);
  const qaLines: string[] = [];
  for (const pair of selectedPairs) {
    const next = [`Q: ${pair.question}`, `A: ${pair.answer}`].join("\n");
    const candidate = [...sections, "Q&A:", ...qaLines, next].join("\n\n");
    if (candidate.length > maxCharacters) break;
    qaLines.push(next);
    sources.push({ type: "qa", id: pair.id, question: pair.question });
  }

  if (qaLines.length > 0) {
    sections.push(["Q&A:", ...qaLines].join("\n\n"));
  }

  return {
    promptPart: sections.join("\n\n"),
    sources,
  };
}

function selectRelevantPairs(qaPairs: QAPair[], userMessage: string): QAPair[] {
  const terms = normalize(userMessage).split(/\s+/).filter((term) => term.length > 2);
  return [...qaPairs].sort((a, b) => {
    const scoreDiff = scorePair(b, terms) - scorePair(a, terms);
    if (scoreDiff !== 0) return scoreDiff;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

function scorePair(pair: QAPair, terms: string[]): number {
  const haystack = normalize(`${pair.question} ${pair.answer} ${pair.tags.join(" ")}`);
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ");
}
