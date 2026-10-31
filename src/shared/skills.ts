export const SKILL_NAMES = [
  '3d-animation-short-generator',
  'brand-promo-video-generator',
  'co-op-game-intro-generator',
  'h3-prompt-writing',
  'handdrawn-live-video-generator',
  'minimalist-product-ad-generator',
  'music-video-subtitle-generator',
  'paper-collage-explainer-generator',
  'papercraft-stop-motion-explainer',
] as const;

export type SkillName = (typeof SKILL_NAMES)[number];
