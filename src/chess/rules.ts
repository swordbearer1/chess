import { cloneBoard, opposite, sameSquare } from './board'
import { generateRawMoves } from './moves'
import type { Board, Color, GameStatus, Move, Position, Square } from './types'

export function findKing(board: Board, color: Color): Square | null {
  for (let row = 0; row < board.length; row++) {
    for (let col = 0; col < board[row].length; col++) {
      const piece = board[row][col]
      if (piece && piece.color === color && piece.type === 'general') {
        return { row, col }
      }
    }
  }
  return null
}

/** 纵向（同一列）从 r1 到 r2 之间是否无棋子（不含两端） */
function isClearVertical(board: Board, r1: number, r2: number, col: number): boolean {
  const lo = Math.min(r1, r2)
  const hi = Math.max(r1, r2)
  for (let r = lo + 1; r < hi; r++) {
    if (board[r][col] !== null) return false
  }
  return true
}

/** color 方是否被将军（含将帅照面） */
export function isInCheck(board: Board, color: Color): boolean {
  const king = findKing(board, color)
  if (!king) return true

  const opponent = opposite(color)
  const enemyMoves = generateRawMoves(board, opponent)
  if (enemyMoves.some((m) => sameSquare(m.to, king))) return true

  // 将帅照面：两将同列且中间无子，视为被将军
  const enemyKing = findKing(board, opponent)
  if (enemyKing && enemyKing.col === king.col && isClearVertical(board, king.row, enemyKing.row, king.col)) {
    return true
  }

  return false
}

export function applyMove(position: Position, move: Move): Position {
  const board = cloneBoard(position.board)
  const piece = board[move.from.row][move.from.col]
  board[move.from.row][move.from.col] = null
  board[move.to.row][move.to.col] = piece
  return { board, sideToMove: opposite(position.sideToMove) }
}

/** 生成 color 方所有合法走法（过滤自陷将军） */
export function generateLegalMoves(position: Position): Move[] {
  const moves = generateRawMoves(position.board, position.sideToMove)
  return moves.filter((m) => {
    const next = applyMove(position, m)
    return !isInCheck(next.board, position.sideToMove)
  })
}

export function hasLegalMove(position: Position): boolean {
  return generateLegalMoves(position).length > 0
}

/** 判胜负：无合法走法（将死或困毙）则轮到的一方负 */
export function getGameStatus(position: Position): GameStatus {
  const redKing = findKing(position.board, 'red')
  const blackKing = findKing(position.board, 'black')
  if (!redKing) return 'blackWon'
  if (!blackKing) return 'redWon'

  if (!hasLegalMove(position)) {
    return position.sideToMove === 'red' ? 'blackWon' : 'redWon'
  }
  return 'playing'
}
