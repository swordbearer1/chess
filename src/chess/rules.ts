import { cloneBoard, inBounds, opposite } from './board'
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

/**
 * 定向攻击检测：sq 是否被 byColor 的棋子攻击（含将帅照面）。
 * 相比“生成全部走法再比对落点”，只扫描目标格周围的直线、马腿与兵位，成本低一个量级。
 */
export function isSquareAttacked(board: Board, sq: Square, byColor: Color): boolean {
  // 直线：车（第一枚子）、炮（隔一枚子后的炮）、将帅照面（同列第一枚子为将）
  const dirs = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ]
  for (const [dr, dc] of dirs) {
    let r = sq.row + dr
    let c = sq.col + dc
    let screened = false
    while (inBounds(r, c)) {
      const p = board[r][c]
      if (p) {
        if (!screened) {
          if (p.color === byColor && (p.type === 'chariot' || p.type === 'general')) return true
          screened = true
        } else {
          if (p.color === byColor && p.type === 'cannon') return true
          break
        }
      }
      r += dr
      c += dc
    }
  }

  // 马：目标格的反向马位 + 蹩腿检查
  const horseSteps: Array<[number, number, number, number]> = [
    [-2, -1, -1, 0],
    [-2, 1, -1, 0],
    [2, -1, 1, 0],
    [2, 1, 1, 0],
    [-1, -2, 0, -1],
    [1, -2, 0, -1],
    [-1, 2, 0, 1],
    [1, 2, 0, 1],
  ]
  for (const [dr, dc, lr, lc] of horseSteps) {
    const hr = sq.row - dr
    const hc = sq.col - dc
    if (!inBounds(hr, hc)) continue
    if (board[hr + lr][hc + lc] !== null) continue // 蹩马腿
    const p = board[hr][hc]
    if (p && p.color === byColor && p.type === 'horse') return true
  }

  // 兵：攻击目标格的兵位于其“来路”一格；过河后还可在两侧
  if (byColor === 'red') {
    if (inBounds(sq.row + 1, sq.col)) {
      const p = board[sq.row + 1][sq.col]
      if (p && p.color === 'red' && p.type === 'soldier') return true
    }
    if (sq.row <= 4) {
      for (const dc of [-1, 1]) {
        if (!inBounds(sq.row, sq.col + dc)) continue
        const p = board[sq.row][sq.col + dc]
        if (p && p.color === 'red' && p.type === 'soldier') return true
      }
    }
  } else {
    if (inBounds(sq.row - 1, sq.col)) {
      const p = board[sq.row - 1][sq.col]
      if (p && p.color === 'black' && p.type === 'soldier') return true
    }
    if (sq.row >= 5) {
      for (const dc of [-1, 1]) {
        if (!inBounds(sq.row, sq.col + dc)) continue
        const p = board[sq.row][sq.col + dc]
        if (p && p.color === 'black' && p.type === 'soldier') return true
      }
    }
  }

  return false
}

/** color 方是否被将军（含将帅照面） */
export function isInCheck(board: Board, color: Color): boolean {
  const king = findKing(board, color)
  if (!king) return true
  return isSquareAttacked(board, king, opposite(color))
}

export function applyMove(position: Position, move: Move): Position {
  const board = cloneBoard(position.board)
  const piece = board[move.from.row][move.from.col]
  board[move.from.row][move.from.col] = null
  board[move.to.row][move.to.col] = piece
  return { board, sideToMove: opposite(position.sideToMove) }
}

/** 生成 color 方所有可走法（不过滤“自陷将军”，允许送将；将帅被吃后由 getGameStatus 判负）。 */
export function generateLegalMoves(position: Position): Move[] {
  const king = findKing(position.board, position.sideToMove)
  if (!king) return []
  return generateRawMoves(position.board, position.sideToMove)
}

export function hasLegalMove(position: Position): boolean {
  return generateLegalMoves(position).length > 0
}

/** 判胜负：将帅被吃、或无子可走（困毙）则轮到的一方负 */
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
