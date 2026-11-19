export type Color = 'red' | 'black'

export type PieceType =
  | 'general'
  | 'advisor'
  | 'elephant'
  | 'horse'
  | 'chariot'
  | 'cannon'
  | 'soldier'

export interface Piece {
  type: PieceType
  color: Color
}

/** board[row][col]，row 0 在上（黑方），row 9 在下（红方） */
export type Board = (Piece | null)[][]

export interface Position {
  board: Board
  sideToMove: Color
}

export interface Square {
  row: number
  col: number
}

export interface Move {
  from: Square
  to: Square
}

export type GameStatus = 'playing' | 'redWon' | 'blackWon'

export const PIECE_CHARS: Record<Color, Record<PieceType, string>> = {
  red: {
    general: '帅',
    advisor: '仕',
    elephant: '相',
    horse: '马',
    chariot: '车',
    cannon: '炮',
    soldier: '兵',
  },
  black: {
    general: '将',
    advisor: '士',
    elephant: '象',
    horse: '马',
    chariot: '车',
    cannon: '炮',
    soldier: '卒',
  },
}
