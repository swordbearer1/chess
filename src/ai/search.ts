import { applyMove, generateLegalMoves, generateRawMoves, isInCheck } from '../chess'
import type { Color, Move, PieceType, Position } from '../chess'

const PIECE_VALUES: Record<PieceType, number> = {
  general: 10000,
  chariot: 900,
  cannon: 450,
  horse: 400,
  elephant: 200,
  advisor: 200,
  soldier: 100,
}

export const MATE_SCORE = 1_000_000

/** 被将军但尚能将应时的轻微罚分 */
const CHECK_PENALTY = 40

/** 子力（不含将帅）低于该值时视为残局，在叶节点额外校验困毙，避免深度边界漏判终局 */
const ENDGAME_MATERIAL_LIMIT = 1600

/** 时间检查的节点间隔（每 N 个节点检查一次截止时间） */
const TIME_CHECK_INTERVAL = 1024

// —— 位置价值表（红方视角，row 0 在上；黑方按 9 - row 镜像） ——

const HORSE_PST = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 2, 0, 2, 2, 2, 0, 2, 0],
  [2, 4, 10, 6, 6, 6, 10, 4, 2],
  [4, 8, 14, 10, 10, 10, 14, 8, 4],
  [6, 10, 16, 12, 12, 12, 16, 10, 6],
  [6, 10, 16, 12, 12, 12, 16, 10, 6],
  [4, 8, 14, 10, 10, 10, 14, 8, 4],
  [2, 4, 10, 6, 6, 6, 10, 4, 2],
  [0, 2, 0, 2, 2, 2, 0, 2, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
]

const CHARIOT_PST = [
  [8, 10, 12, 14, 14, 14, 12, 10, 8],
  [8, 10, 12, 16, 16, 16, 12, 10, 8],
  [8, 10, 12, 16, 16, 16, 12, 10, 8],
  [10, 12, 14, 18, 18, 18, 14, 12, 10],
  [12, 14, 16, 20, 20, 20, 16, 14, 12],
  [12, 14, 16, 20, 20, 20, 16, 14, 12],
  [10, 12, 14, 18, 18, 18, 14, 12, 10],
  [8, 10, 12, 16, 16, 16, 12, 10, 8],
  [8, 10, 12, 14, 14, 14, 12, 10, 8],
  [8, 10, 12, 14, 14, 14, 12, 10, 8],
]

const CANNON_PST = [
  [2, 4, 6, 8, 8, 8, 6, 4, 2],
  [2, 4, 8, 12, 10, 12, 8, 4, 2],
  [2, 4, 8, 12, 10, 12, 8, 4, 2],
  [4, 8, 12, 16, 14, 16, 12, 8, 4],
  [6, 10, 14, 18, 16, 18, 14, 10, 6],
  [6, 10, 14, 18, 16, 18, 14, 10, 6],
  [4, 8, 12, 16, 14, 16, 12, 8, 4],
  [2, 4, 8, 12, 10, 12, 8, 4, 2],
  [2, 4, 6, 8, 8, 8, 6, 4, 2],
  [2, 4, 6, 8, 8, 8, 6, 4, 2],
]

function pstValue(table: number[][], row: number, col: number, color: Color): number {
  return table[color === 'red' ? row : 9 - row][col]
}

interface EvalResult {
  /** 红方视角的静态评估 */
  score: number
  /** 双方除将帅外的子力总和 */
  material: number
}

/** 红方视角的静态评估：子力 + 位置 + 兵种前进 + 残局将帅活跃度 */
function evaluate(position: Position): EvalResult {
  let score = 0
  let material = 0
  const { board } = position

  for (let row = 0; row < 10; row++) {
    for (let col = 0; col < 9; col++) {
      const piece = board[row][col]
      if (!piece) continue
      const sign = piece.color === 'red' ? 1 : -1
      let v = PIECE_VALUES[piece.type]
      switch (piece.type) {
        case 'horse':
          v += pstValue(HORSE_PST, row, col, piece.color)
          break
        case 'chariot':
          v += pstValue(CHARIOT_PST, row, col, piece.color)
          break
        case 'cannon':
          v += pstValue(CANNON_PST, row, col, piece.color)
          break
        case 'soldier':
          v += piece.color === 'red' ? (6 - row) * 10 : (row - 3) * 10
          break
        default:
          break
      }
      if (piece.type !== 'general') material += PIECE_VALUES[piece.type]
      score += sign * v
    }
  }

  // 残局：将帅走向中心，提高活跃度
  const endgame = Math.max(0, 1 - material / 5000)
  if (endgame > 0) {
    for (const color of ['red', 'black'] as Color[]) {
      const home = color === 'red' ? 8 : 1
      const sign = color === 'red' ? 1 : -1
      for (let row = 0; row < 10; row++) {
        for (let col = 3; col <= 5; col++) {
          const piece = board[row][col]
          if (piece && piece.type === 'general' && piece.color === color) {
            const activity = Math.max(0, 12 - Math.abs(row - home) * 4 - Math.abs(col - 4) * 4)
            score += sign * activity * endgame
          }
        }
      }
    }
  }

  return { score, material }
}

function sameMove(a: Move, b: Move): boolean {
  return (
    a.from.row === b.from.row &&
    a.from.col === b.from.col &&
    a.to.row === b.to.row &&
    a.to.col === b.to.col
  )
}

function moveHash(m: Move): number {
  return (m.from.row * 9 + m.from.col) * 90 + m.to.row * 9 + m.to.col
}

/** 走法排序：吃子（MVV-LVA）优先，其次上一轮最佳走法、杀手走法与历史启发式 */
function orderMoves(
  position: Position,
  moves: Move[],
  ply: number,
  ctx: SearchContext,
  prevBest: Move | null,
): Move[] {
  const killers = ctx.killers[ply] ?? []
  const scored = moves.map((move) => {
    const captured = position.board[move.to.row][move.to.col]
    const attacker = position.board[move.from.row][move.from.col]!
    let value = 0
    if (captured) {
      value = 1_000_000 + PIECE_VALUES[captured.type] * 10 - PIECE_VALUES[attacker.type]
    }
    if (prevBest && sameMove(move, prevBest)) value += 20_000_000
    else if (killers.some((k) => sameMove(k, move))) value += 5_000_000
    else value += ctx.history.get(moveHash(move)) ?? 0
    return { move, value }
  })
  scored.sort((a, b) => b.value - a.value)
  return scored.map((x) => x.move)
}

export interface SearchContext {
  deadline: number
  nodes: number
  aborted: boolean
  /** 每层的杀手走法（引发剪枝的安静走法） */
  killers: Move[][]
  /** 历史启发式得分表 */
  history: Map<number, number>
}

/** 静态搜索的最大延伸深度，防止长将链导致搜索失控 */
const MAX_Q_PLY = 16

/**
 * 静态搜索：到达主搜索深度边界后，只延伸吃子与应将，直到局面安静，
 * 消除“深度恰好在吃子后截止”造成的地平线效应。
 * - 无任何伪合法走法：将死或困毙，直接判负；
 * - 被将军：必须应将，校验所有应将走法（无解则将死）；
 * - 安静局面：以静态评估为基线，只考虑吃子走法；
 * - 残局（子力很少）：额外校验困毙。
 */
function quiescence(position: Position, alpha: number, beta: number, ply: number, ctx: SearchContext): number {
  ctx.nodes++
  if ((ctx.nodes & (TIME_CHECK_INTERVAL - 1)) === 0 && performance.now() > ctx.deadline) {
    ctx.aborted = true
  }
  if (ctx.aborted) return 0

  const side = position.sideToMove
  const { board } = position
  const raw = generateRawMoves(board, side)
  if (raw.length === 0) return -(MATE_SCORE - ply) // 将死或困毙：走子方负

  const ev = evaluate(position)
  const standPat = side === 'red' ? ev.score : -ev.score

  if (isInCheck(board, side)) {
    if (ply >= MAX_Q_PLY) return standPat - CHECK_PENALTY // 截断长将链
    const evasions = raw.filter((m) => !isInCheck(applyMove(position, m).board, side))
    if (evasions.length === 0) return -(MATE_SCORE - ply) // 将死
    let best = -Infinity
    for (const move of orderMoves(position, evasions, ply, ctx, null)) {
      const score = -quiescence(applyMove(position, move), -beta, -alpha, ply + 1, ctx)
      if (ctx.aborted) return 0
      if (score > best) best = score
      if (best > alpha) alpha = best
      if (alpha >= beta) break
    }
    return best
  }

  // 残局：伪合法走法非空但全部非法（困毙），避免漏判
  if (ev.material <= ENDGAME_MATERIAL_LIMIT && generateLegalMoves(position).length === 0) {
    return -(MATE_SCORE - ply)
  }

  if (standPat >= beta) return standPat
  if (standPat > alpha) alpha = standPat

  const captures = raw.filter((m) => board[m.to.row][m.to.col] !== null)
  if (captures.length === 0) return standPat
  const legalCaptures = captures.filter((m) => !isInCheck(applyMove(position, m).board, side))
  if (legalCaptures.length === 0) return standPat

  let best = -Infinity
  for (const move of orderMoves(position, legalCaptures, ply, ctx, null)) {
    const score = -quiescence(applyMove(position, move), -beta, -alpha, ply + 1, ctx)
    if (ctx.aborted) return 0
    if (score > best) best = score
    if (best > alpha) alpha = best
    if (alpha >= beta) break
  }
  return best
}

function negamax(
  position: Position,
  depth: number,
  alpha: number,
  beta: number,
  ply: number,
  ctx: SearchContext,
): number {
  ctx.nodes++
  if ((ctx.nodes & (TIME_CHECK_INTERVAL - 1)) === 0 && performance.now() > ctx.deadline) {
    ctx.aborted = true
  }
  if (ctx.aborted) return 0

  if (depth === 0) return quiescence(position, alpha, beta, ply, ctx)

  const moves = generateLegalMoves(position)
  if (moves.length === 0) return -(MATE_SCORE - ply) // 将死或困毙：走子方负

  let best = -Infinity
  for (const move of orderMoves(position, moves, ply, ctx, null)) {
    const next = applyMove(position, move)
    const score = -negamax(next, depth - 1, -beta, -alpha, ply + 1, ctx)
    if (ctx.aborted) return 0
    if (score > best) best = score
    if (best > alpha) alpha = best
    if (alpha >= beta) {
      // 记录引发剪枝的安静走法：杀手走法 + 历史启发式
      if (position.board[move.to.row][move.to.col] === null) {
        const list = ctx.killers[ply] ?? (ctx.killers[ply] = [])
        if (!list.some((k) => sameMove(k, move))) {
          list.unshift(move)
          if (list.length > 2) list.length = 2
        }
        const h = moveHash(move)
        ctx.history.set(h, (ctx.history.get(h) ?? 0) + depth * depth)
      }
      break
    }
  }
  return best
}

export interface SearchOptions {
  maxDepth: number
  timeBudgetMs: number
}

export interface SearchResult {
  move: Move | null
  /** 完整完成的搜索深度（超时前最后完成的迭代轮次） */
  depth: number
  nodes: number
  timeMs: number
  score: number
}

/**
 * 迭代加深 + Alpha-Beta 搜索。
 * 从深度 1 逐层加深，每轮完成后记录最佳走法；超时则采用上一轮完整搜索的最佳走法。
 */
export function searchBestMove(position: Position, options: SearchOptions): SearchResult {
  const start = performance.now()
  const ctx: SearchContext = {
    deadline: start + options.timeBudgetMs,
    nodes: 0,
    aborted: false,
    killers: [],
    history: new Map(),
  }

  const rootMoves = generateLegalMoves(position)
  if (rootMoves.length === 0) {
    return { move: null, depth: 0, nodes: ctx.nodes, timeMs: performance.now() - start, score: 0 }
  }

  let bestMove: Move | null = null
  let bestScore = 0
  let completedDepth = 0

  for (let depth = 1; depth <= options.maxDepth; depth++) {
    let iterBest: Move | null = null
    let iterScore = -Infinity
    for (const move of orderMoves(position, rootMoves, 0, ctx, bestMove)) {
      if (ctx.aborted) break
      const next = applyMove(position, move)
      const score = -negamax(next, depth - 1, -Infinity, Infinity, 1, ctx)
      if (ctx.aborted) break
      if (score > iterScore) {
        iterScore = score
        iterBest = move
      }
    }
    if (ctx.aborted) break // 本轮未完成：弃用，采用上一轮结果
    if (iterBest === null) break
    bestMove = iterBest
    bestScore = iterScore
    completedDepth = depth
    if (bestScore >= MATE_SCORE - 100) break // 已找到将杀，无需更深
  }

  if (bestMove === null) bestMove = rootMoves[0] // 极端情况兜底：预算极小未完成任何一轮

  return {
    move: bestMove,
    depth: completedDepth,
    nodes: ctx.nodes,
    timeMs: performance.now() - start,
    score: bestScore,
  }
}
