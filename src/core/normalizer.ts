export interface CaptionNormalizationResult {
  text: string;
  comparableText: string;
  changed: boolean;
}

export function normalizeCaptionText(input: string): CaptionNormalizationResult {
  const text = input
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([([{])\s+/g, "$1")
    .replace(/\s+([)\]}])/g, "$1")
    .replace(/[‐‑‒–—]+/g, "-")
    .trim();

  return {
    text,
    comparableText: comparableCaptionText(text),
    changed: text !== input
  };
}

export function comparableCaptionText(input: string): string {
  return input
    .replace(/[‐‑‒–—-]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function captionsOverlap(left: string, right: string): boolean {
  const normalizedLeft = comparableCaptionText(left);
  const normalizedRight = comparableCaptionText(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  return normalizedLeft === normalizedRight || normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft);
}
