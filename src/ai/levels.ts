/** 四档难度配置：入门随机走法，其余三档复用同一搜索引擎（迭代加深 + 时间预算） */
export type AiLevel = 'beginner' | 'normal' | 'hard' | 'expert'

export interface AiLevelConfig {
  label: string
  /** random：随机合法走法；search：迭代加深搜索 */
  mode: 'random' | 'search'
  /** 搜索最大深度（迭代加深的上限，达到时间预算会提前停止） */
  maxDepth: number
  /** 思考时间预算（毫秒）。超时采用上一轮完整搜索的最佳走法 */
  timeBudgetMs: number
  /** 「电脑思考中…」至少展示的时长（毫秒），保证思考过程可感知 */
  minThinkMs: number
}

export const AI_LEVELS: Record<AiLevel, AiLevelConfig> = {
  beginner: { label: '入门', mode: 'random', maxDepth: 1, timeBudgetMs: 0, minThinkMs: 0 },
  normal: { label: '普通', mode: 'search', maxDepth: 3, timeBudgetMs: 800, minThinkMs: 300 },
  hard: { label: '困难', mode: 'search', maxDepth: 4, timeBudgetMs: 2500, minThinkMs: 400 },
  expert: { label: '专家', mode: 'search', maxDepth: 5, timeBudgetMs: 12000, minThinkMs: 500 },
}

export const DEFAULT_AI_LEVEL: AiLevel = 'normal'
