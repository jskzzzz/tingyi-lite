import { sha256Hex, stableJson } from "../core/hash";
import { isSessionId } from "../core/ids";
import type {
  AudioChunkRecord,
  CaptionSegment,
  LiteEvent,
  SessionId,
  SessionRecord,
  SourceRecord,
  TranslationRecord
} from "../core/schema";

export interface LearningBundleInput {
  bundleHash: string;
  session: SessionRecord;
  sources: SourceRecord[];
  captions: CaptionSegment[];
  audioChunks: AudioChunkRecord[];
  translations: TranslationRecord[];
  events: LiteEvent[];
}

export interface CloudLearningMaterial {
  schemaVersion: 1;
  materialId: string;
  sessionId: SessionId;
  sourceBundleHash: string;
  materialHash: string;
  title: string;
  generatedAt: string;
  generator: {
    kind: "baseline" | "external-agent";
    name: string;
  };
  lesson: {
    title: string;
    summary: string;
    objectives: string[];
    keySentences: Array<{
      segmentId: string;
      text: string;
      startMs: number;
      endMs: number;
    }>;
  };
  cards: CloudLearningCard[];
  reviewPlan: CloudReviewPlanItem[];
}

export interface CloudLearningCard {
  cardId: string;
  kind: "shadowing" | "listening-gap" | "vocabulary" | "note" | "review-seed" | "comprehension" | "correction" | "custom";
  segmentId?: string;
  prompt: string;
  answer?: string;
  sourceText?: string;
}

export interface CloudReviewPlanItem {
  dayOffset: number;
  title: string;
  cardIds: string[];
}

export type CloudLearningMaterialDraft = Omit<CloudLearningMaterial, "materialId" | "materialHash" | "generatedAt"> & {
  materialId?: string;
  materialHash?: string;
  generatedAt?: string;
};

export async function generateBaselineLearningMaterial(input: {
  bundle: LearningBundleInput;
  generatedAt: string;
  generatorName?: string;
}): Promise<CloudLearningMaterial> {
  const captions = input.bundle.captions
    .filter((caption) => caption.isFinal && caption.text.trim())
    .sort((left, right) => left.startMs - right.startMs || left.createdAt.localeCompare(right.createdAt));
  const keySentences = captions.slice(0, 8).map((caption) => ({
    segmentId: caption.segmentId,
    text: caption.text,
    startMs: caption.startMs,
    endMs: caption.endMs
  }));
  const cards = [
    ...shadowingCards(captions),
    ...listeningGapCards(captions),
    ...vocabularyCards(captions)
  ].slice(0, 40);
  const content = {
    schemaVersion: 1 as const,
    sessionId: input.bundle.session.sessionId,
    sourceBundleHash: input.bundle.bundleHash,
    title: input.bundle.session.title,
    generator: {
      kind: "baseline" as const,
      name: input.generatorName?.trim() || "tingyi-baseline-v1"
    },
    lesson: {
      title: input.bundle.session.title,
      summary: summarizeCaptions(captions),
      objectives: [
        "Understand the main spoken content.",
        "Shadow key sentences with accurate rhythm.",
        "Review vocabulary and listening gaps from the session."
      ],
      keySentences
    },
    cards,
    reviewPlan: buildReviewPlan(cards)
  };
  const materialHash = await sha256Hex(stableJson(content));
  return {
    ...content,
    generatedAt: input.generatedAt,
    materialId: `material_${materialHash.slice(0, 16)}`,
    materialHash
  };
}

export async function normalizeExternalLearningMaterial(input: {
  material: unknown;
  sessionId: SessionId;
  sourceBundleHash: string;
  generatedAt: string;
  captionSegmentIds?: Set<string>;
}): Promise<CloudLearningMaterial> {
  if (!isRecord(input.material)) {
    throw new Error("Invalid learning material");
  }
  const draft = input.material as Partial<CloudLearningMaterialDraft>;
  if (draft.schemaVersion !== 1) {
    throw new Error("Invalid learning material schemaVersion");
  }
  if (draft.sessionId !== input.sessionId) {
    throw new Error("Learning material sessionId does not match route");
  }
  if (draft.sourceBundleHash !== input.sourceBundleHash) {
    throw new Error("Learning material sourceBundleHash does not match current bundle");
  }
  if (!isNonEmptyString(draft.title)) {
    throw new Error("Invalid learning material title");
  }
  if (!isRecord(draft.generator) || draft.generator.kind !== "external-agent" || !isNonEmptyString(draft.generator.name)) {
    throw new Error("Invalid learning material generator");
  }
  if (!isRecord(draft.lesson)) {
    throw new Error("Invalid learning material lesson");
  }
  const lesson = {
    title: requireNonEmptyString(draft.lesson.title, "Invalid learning material lesson.title"),
    summary: requireNonEmptyString(draft.lesson.summary, "Invalid learning material lesson.summary"),
    objectives: requireStringArray(draft.lesson.objectives, "Invalid learning material lesson.objectives"),
    keySentences: requireKeySentences(draft.lesson.keySentences)
  };
  const cards = requireCards(draft.cards);
  const reviewPlan = requireReviewPlan(draft.reviewPlan, new Set(cards.map((card) => card.cardId)));
  if (input.captionSegmentIds) {
    validateReferencedSegmentIds(lesson.keySentences, cards, input.captionSegmentIds);
  }
  const content = {
    schemaVersion: 1 as const,
    sessionId: input.sessionId,
    sourceBundleHash: input.sourceBundleHash,
    title: draft.title,
    generator: {
      kind: "external-agent" as const,
      name: draft.generator.name.trim()
    },
    lesson,
    cards,
    reviewPlan
  };
  const materialHash = await sha256Hex(stableJson(content));
  if (draft.materialHash !== undefined && draft.materialHash !== materialHash) {
    throw new Error("Learning material materialHash does not match content");
  }
  const materialId = `material_${materialHash.slice(0, 16)}`;
  if (draft.materialId !== undefined && draft.materialId !== materialId) {
    throw new Error("Learning material materialId does not match content");
  }
  return {
    ...content,
    generatedAt: isNonEmptyString(draft.generatedAt) ? draft.generatedAt.trim() : input.generatedAt,
    materialId,
    materialHash
  };
}

export async function validateStoredLearningMaterial(input: {
  material: unknown;
  sessionId?: SessionId;
}): Promise<CloudLearningMaterial> {
  if (!isRecord(input.material)) {
    throw new Error("Invalid learning material");
  }
  const draft = input.material as Partial<CloudLearningMaterial>;
  if (draft.schemaVersion !== 1) {
    throw new Error("Invalid learning material schemaVersion");
  }
  const sessionId = requireSessionId(draft.sessionId, "Invalid learning material sessionId");
  if (input.sessionId !== undefined && sessionId !== input.sessionId) {
    throw new Error("Learning material sessionId does not match route");
  }
  const sourceBundleHash = requireSha256(draft.sourceBundleHash, "Invalid learning material sourceBundleHash");
  if (!isRecord(draft.generator) || !isGeneratorKind(draft.generator.kind) || !isNonEmptyString(draft.generator.name)) {
    throw new Error("Invalid learning material generator");
  }
  if (!isRecord(draft.lesson)) {
    throw new Error("Invalid learning material lesson");
  }
  const lesson = {
    title: requireNonEmptyString(draft.lesson.title, "Invalid learning material lesson.title"),
    summary: requireNonEmptyString(draft.lesson.summary, "Invalid learning material lesson.summary"),
    objectives: requireStringArray(draft.lesson.objectives, "Invalid learning material lesson.objectives"),
    keySentences: requireKeySentences(draft.lesson.keySentences)
  };
  const cards = requireCards(draft.cards);
  const reviewPlan = requireReviewPlan(draft.reviewPlan, new Set(cards.map((card) => card.cardId)));
  const content = {
    schemaVersion: 1 as const,
    sessionId,
    sourceBundleHash,
    title: requireNonEmptyString(draft.title, "Invalid learning material title"),
    generator: {
      kind: draft.generator.kind,
      name: draft.generator.name.trim()
    },
    lesson,
    cards,
    reviewPlan
  };
  const materialHash = await sha256Hex(stableJson(content));
  if (draft.materialHash !== materialHash) {
    throw new Error("Learning material materialHash does not match content");
  }
  const materialId = `material_${materialHash.slice(0, 16)}`;
  if (draft.materialId !== materialId) {
    throw new Error("Learning material materialId does not match content");
  }
  return {
    ...content,
    generatedAt: requireTimestamp(draft.generatedAt, "Invalid learning material generatedAt"),
    materialId,
    materialHash
  };
}

function validateReferencedSegmentIds(
  keySentences: CloudLearningMaterial["lesson"]["keySentences"],
  cards: CloudLearningCard[],
  captionSegmentIds: Set<string>
): void {
  for (const sentence of keySentences) {
    if (!captionSegmentIds.has(sentence.segmentId)) {
      throw new Error(`Unknown learning material segmentId: ${sentence.segmentId}`);
    }
  }
  for (const card of cards) {
    if (card.segmentId && !captionSegmentIds.has(card.segmentId)) {
      throw new Error(`Unknown learning material segmentId: ${card.segmentId}`);
    }
  }
}

function requireCards(value: unknown): CloudLearningCard[] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid learning material cards");
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`Invalid learning material cards[${index}]`);
    }
    const cardId = requireNonEmptyString(item.cardId, `Invalid learning material cards[${index}].cardId`);
    if (seen.has(cardId)) {
      throw new Error(`Duplicate learning material cardId: ${cardId}`);
    }
    seen.add(cardId);
    const kind = requireCardKind(item.kind, `Invalid learning material cards[${index}].kind`);
    const card: CloudLearningCard = {
      cardId,
      kind,
      prompt: requireNonEmptyString(item.prompt, `Invalid learning material cards[${index}].prompt`)
    };
    if (isNonEmptyString(item.segmentId)) {
      card.segmentId = item.segmentId.trim();
    }
    if (isNonEmptyString(item.answer)) {
      card.answer = item.answer.trim();
    }
    if (isNonEmptyString(item.sourceText)) {
      card.sourceText = item.sourceText.trim();
    }
    return card;
  });
}

function requireReviewPlan(value: unknown, cardIds: Set<string>): CloudReviewPlanItem[] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid learning material reviewPlan");
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`Invalid learning material reviewPlan[${index}]`);
    }
    if (typeof item.dayOffset !== "number" || !Number.isInteger(item.dayOffset) || item.dayOffset < 0) {
      throw new Error(`Invalid learning material reviewPlan[${index}].dayOffset`);
    }
    const planCardIds = requireStringArray(item.cardIds, `Invalid learning material reviewPlan[${index}].cardIds`);
    for (const cardId of planCardIds) {
      if (!cardIds.has(cardId)) {
        throw new Error(`Unknown learning material cardId in reviewPlan: ${cardId}`);
      }
    }
    return {
      dayOffset: item.dayOffset,
      title: requireNonEmptyString(item.title, `Invalid learning material reviewPlan[${index}].title`),
      cardIds: planCardIds
    };
  });
}

function requireKeySentences(value: unknown): CloudLearningMaterial["lesson"]["keySentences"] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid learning material lesson.keySentences");
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`Invalid learning material lesson.keySentences[${index}]`);
    }
    if (typeof item.startMs !== "number" || !Number.isFinite(item.startMs) || item.startMs < 0) {
      throw new Error(`Invalid learning material lesson.keySentences[${index}].startMs`);
    }
    if (typeof item.endMs !== "number" || !Number.isFinite(item.endMs) || item.endMs < item.startMs) {
      throw new Error(`Invalid learning material lesson.keySentences[${index}].endMs`);
    }
    return {
      segmentId: requireNonEmptyString(item.segmentId, `Invalid learning material lesson.keySentences[${index}].segmentId`),
      text: requireNonEmptyString(item.text, `Invalid learning material lesson.keySentences[${index}].text`),
      startMs: Math.floor(item.startMs),
      endMs: Math.floor(item.endMs)
    };
  });
}

function requireStringArray(value: unknown, message: string): string[] {
  if (!Array.isArray(value) || value.some((item) => !isNonEmptyString(item))) {
    throw new Error(message);
  }
  return value.map((item) => item.trim());
}

function requireCardKind(value: unknown, message: string): CloudLearningCard["kind"] {
  if (
    value === "shadowing" ||
    value === "listening-gap" ||
    value === "vocabulary" ||
    value === "note" ||
    value === "review-seed" ||
    value === "comprehension" ||
    value === "correction" ||
    value === "custom"
  ) {
    return value;
  }
  throw new Error(message);
}

function isGeneratorKind(value: unknown): value is CloudLearningMaterial["generator"]["kind"] {
  return value === "baseline" || value === "external-agent";
}

function requireSessionId(value: unknown, message: string): SessionId {
  if (isSessionId(value)) {
    return value;
  }
  throw new Error(message);
}

function requireSha256(value: unknown, message: string): string {
  if (typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) {
    return value;
  }
  throw new Error(message);
}

function requireTimestamp(value: unknown, message: string): string {
  if (isNonEmptyString(value) && Number.isFinite(Date.parse(value))) {
    return value.trim();
  }
  throw new Error(message);
}

function requireNonEmptyString(value: unknown, message: string): string {
  if (!isNonEmptyString(value)) {
    throw new Error(message);
  }
  return value.trim();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shadowingCards(captions: CaptionSegment[]): CloudLearningCard[] {
  return captions.slice(0, 8).map((caption, index) => ({
    cardId: `shadow_${index + 1}_${caption.segmentId}`,
    kind: "shadowing",
    segmentId: caption.segmentId,
    prompt: `Shadow this sentence: ${caption.text}`,
    answer: caption.text,
    sourceText: caption.text
  }));
}

function listeningGapCards(captions: CaptionSegment[]): CloudLearningCard[] {
  return captions
    .map((caption) => ({ caption, gap: makeGapPrompt(caption.text) }))
    .filter((item): item is { caption: CaptionSegment; gap: { prompt: string; answer: string } } => Boolean(item.gap))
    .slice(0, 6)
    .map((item, index) => ({
      cardId: `gap_${index + 1}_${item.caption.segmentId}`,
      kind: "listening-gap",
      segmentId: item.caption.segmentId,
      prompt: item.gap.prompt,
      answer: item.gap.answer,
      sourceText: item.caption.text
    }));
}

function vocabularyCards(captions: CaptionSegment[]): CloudLearningCard[] {
  const seen = new Set<string>();
  const cards: CloudLearningCard[] = [];
  for (const caption of captions) {
    for (const word of extractVocabulary(caption.text)) {
      const key = word.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      cards.push({
        cardId: `vocab_${cards.length + 1}_${caption.segmentId}`,
        kind: "vocabulary",
        segmentId: caption.segmentId,
        prompt: `Explain and reuse: ${word}`,
        answer: word,
        sourceText: caption.text
      });
      if (cards.length >= 8) {
        return cards;
      }
    }
  }
  return cards;
}

function buildReviewPlan(cards: CloudLearningCard[]): CloudReviewPlanItem[] {
  const first = cards.slice(0, 12).map((card) => card.cardId);
  const second = cards.slice(0, 20).map((card) => card.cardId);
  const all = cards.map((card) => card.cardId);
  return [
    { dayOffset: 0, title: "Initial shadowing and comprehension", cardIds: first },
    { dayOffset: 1, title: "Recall vocabulary and listening gaps", cardIds: second },
    { dayOffset: 3, title: "Spaced review", cardIds: all },
    { dayOffset: 7, title: "Final retention check", cardIds: all }
  ].filter((item) => item.cardIds.length > 0);
}

function summarizeCaptions(captions: CaptionSegment[]): string {
  if (captions.length === 0) {
    return "No final captions are available yet.";
  }
  const totalSeconds = Math.max(1, Math.round((captions.at(-1)?.endMs ?? 0) / 1000));
  return `${captions.length} final caption segments over about ${totalSeconds} seconds.`;
}

function makeGapPrompt(text: string): { prompt: string; answer: string } | undefined {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 4) {
    return undefined;
  }
  const target = [...words]
    .map((word) => ({ raw: word, clean: cleanWord(word) }))
    .filter((word) => word.clean.length >= 5)
    .sort((left, right) => right.clean.length - left.clean.length)[0];
  if (!target) {
    return undefined;
  }
  return {
    prompt: text.replace(target.raw, "____"),
    answer: target.clean
  };
}

function extractVocabulary(text: string): string[] {
  return text
    .split(/\s+/)
    .map(cleanWord)
    .filter((word) => word.length >= 7 && !COMMON_WORDS.has(word.toLowerCase()));
}

function cleanWord(word: string): string {
  return word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

const COMMON_WORDS = new Set([
  "because",
  "between",
  "without",
  "through",
  "another",
  "something",
  "everything",
  "anything"
]);
