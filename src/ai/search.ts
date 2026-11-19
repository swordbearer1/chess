import { applyMove, generateLegalMoves } from '../chess'
import type { Move, PieceType, Position } from '../chess'

const PIECE_VALUES: Record<PieceType, number> = {
  general: 10000,
  chariot: 900,
  cannon: 450,
  horse: 400,
  elephant: 200,
  advisor: 200,
  soldier: 100,
}

const MATE_SCORE = 1_000_000

/** 从红方视角的静态评估 */
function evaluate(position: Position): number {
  let score = 0
  const { board } = position
  for (let row = 0; row < board.length; row++) {
    for (let col = 0; col < board[row].length; col++) {
      const piece = board[row][col]
      if (!piece) continue
      let v = PIECE_VALUES[piece.type]
      if (piece.type === 'soldier') {
        v += piece.color === 'red' ? (6 - row) * 10 : (row - 3) * 10
      }
      score += piece.color === 'red' ? v : -v
    }
  }
  return score
}

/** 从当前走子方视角的评估 */
function evaluateSide(position: Position): number {
  const s = evaluate(position)
  return position.sideToMove === 'red' ? s : -s
}

function orderMoves(position: Position, moves: Move[]): Move[] {
  return moves
    .map((move) => {
      const captured = position.board[move.to.row][move.to.col]
      return { move, value: captured ? PIECE_VALUES[captured.type] : 0 }
    })
    .sort((a, b) => b.value - a.value)
    .map((x) => x.move)
}

function negamax(position: Position, depth: number, alpha: number, beta: number): number {
  if (depth === 0) return evaluateSide(position)

  const moves = generateLegalMoves(position)
  if (moves.length === 0) {
    // 将死或困毙：走子方负
    return -MATE_SCORE
  }

  let best = -Infinity
  for (const move of orderMoves(position, moves)) {
    const next = applyMove(position, move)
    const score = -negamax(next, depth - 1, -beta, -alpha)
    if (score > best) best = score
    if (best > alpha) alpha = best
    if (alpha >= beta) break
  }
  return best
}

export function searchBestMove(position: Position, depth: number): Move | null {
  const moves = generateLegalMoves(position)
  if (moves.length === 0) return null

  let bestMove = moves[0]
  let bestScore = -Infinity
  for (const move of orderMoves(position, moves)) {
    const next = applyMove(position, move)
    const score = -negamax(next, depth - 1, -Infinity, Infinity)
    if (score > bestScore) {
      bestScore = score
      bestMove = move
    }
  }
  return bestMove
}
