import type { Board, Color, Piece, PieceType, Position } from './types'

export const ROWS = 10
export const COLS = 9

export function createEmptyBoard(): Board {
  return Array.from({ length: ROWS }, () => Array<Piece | null>(COLS).fill(null))
}

export function cloneBoard(board: Board): Board {
  return board.map((row) => row.slice())
}

const BACK_RANK: PieceType[] = [
  'chariot',
  'horse',
  'elephant',
  'advisor',
  'general',
  'advisor',
  'elephant',
  'horse',
  'chariot',
]

export function initialPosition(): Position {
  const board = createEmptyBoard()

  for (let col = 0; col < COLS; col++) {
    board[0][col] = { type: BACK_RANK[col], color: 'black' }
    board[9][col] = { type: BACK_RANK[col], color: 'red' }
  }

  board[2][1] = { type: 'cannon', color: 'black' }
  board[2][7] = { type: 'cannon', color: 'black' }
  board[7][1] = { type: 'cannon', color: 'red' }
  board[7][7] = { type: 'cannon', color: 'red' }

  for (let col = 0; col < COLS; col += 2) {
    board[3][col] = { type: 'soldier', color: 'black' }
    board[6][col] = { type: 'soldier', color: 'red' }
  }

  return { board, sideToMove: 'red' }
}

export function opposite(color: Color): Color {
  return color === 'red' ? 'black' : 'red'
}

export function inBounds(row: number, col: number): boolean {
  return row >= 0 && row < ROWS && col >= 0 && col < COLS
}

/** 九宫格范围：红方在下方（行 7-9），黑方在上方（行 0-2），列均为 3-5 */
export function inPalace(row: number, col: number, color: Color): boolean {
  if (col < 3 || col > 5) return false
  return color === 'red' ? row >= 7 && row <= 9 : row >= 0 && row <= 2
}

/** 象/相 不能过河 */
export function onOwnSide(row: number, color: Color): boolean {
  return color === 'red' ? row >= 5 : row <= 4
}

export function sameSquare(a: { row: number; col: number }, b: { row: number; col: number }): boolean {
  return a.row === b.row && a.col === b.col
}
