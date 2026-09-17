import type { CaptionPreviewUpsertMessage } from "../core/captionPreview";

export interface DurableLiveCaptionLine {
  key: string;
  text: string;
  translation?: string;
  startMs: number;
}

export interface LiveCaptionLine extends DurableLiveCaptionLine {
  preview: boolean;
}

export function selectLiveCaptionLines(
  durableNewestFirst: DurableLiveCaptionLine[],
  preview: CaptionPreviewUpsertMessage | null,
  limit: number
): LiveCaptionLine[] {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("Live caption line limit must be a positive safe integer");
  }
  const durable = durableNewestFirst.map((line) => ({ ...line, preview: false }));
  const previewDuplicatesLatest = preview && durable[0]?.text.trim() === preview.text.trim();
  return [
    ...(preview && !previewDuplicatesLatest
      ? [{ key: `preview:${preview.streamId}`, text: preview.text, startMs: preview.startMs, preview: true }]
      : []),
    ...durable
  ].slice(0, limit);
}
