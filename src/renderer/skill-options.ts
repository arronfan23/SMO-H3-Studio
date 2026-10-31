import type { SkillName } from '../shared/skills';

export interface SkillOption {
  title: string;
  description: string;
}

export const AUTO_SKILL_OPTION: SkillOption = {
  title: '自动选择（推荐）',
  description: '由系统根据你的描述自动挑选最合适的视频风格。',
};

export const SKILL_OPTIONS: Record<SkillName, SkillOption> = {
  'h3-prompt-writing': {
    title: '通用视频创作',
    description: '把你的想法改写成结构化的 H3 视频提示词，是所有生成模式的基础。',
  },
  '3d-animation-short-generator': {
    title: '3D 动画短片',
    description: '从一个故事想法出发，一步步做出有角色、有镜头的完整 3D 动画短片。',
  },
  'brand-promo-video-generator': {
    title: '品牌宣传视频',
    description: '为品牌、产品或个人项目策划并生成一支带行动号召的宣传短片。',
  },
  'co-op-game-intro-generator': {
    title: '双人合作游戏开场',
    description: '生成带两名角色、玩家卡片和菜单互动的双人合作游戏开场动画。',
  },
  'handdrawn-live-video-generator': {
    title: '手绘真人口播',
    description: '把粗糙发光的手绘画风叠进真人场景，做出有创意的短视频。',
  },
  'minimalist-product-ad-generator': {
    title: '极简产品广告',
    description: '把产品图片和卖点变成干净、高级的极简风电商广告短片。',
  },
  'music-video-subtitle-generator': {
    title: '音乐视频字幕',
    description: '跟着节拍和人声设计歌词字幕排版，生成音乐视频或情绪短片。',
  },
  'paper-collage-explainer-generator': {
    title: '纸张拼贴讲解',
    description: '用撕纸拼贴的画面语言讲解知识、观点或抽象话题。',
  },
  'papercraft-stop-motion-explainer': {
    title: '纸艺定格讲解',
    description: '用纸艺手工加定格动画的方式讲解科学、教育类知识。',
  },
};
