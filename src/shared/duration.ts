export function estimateNarrationDuration(text: string): number {
  const hanCount = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const latinText = text.replace(/\p{Script=Han}/gu, ' ');
  const wordCount = latinText.match(/[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*/g)?.length ?? 0;
  if (hanCount + wordCount === 0) {
    return 8;
  }

  const seconds = hanCount / 4 + wordCount / 2.5 + 2;
  const rounded = Math.ceil(seconds * 2) / 2;
  return Math.min(15, Math.max(4, rounded));
}
