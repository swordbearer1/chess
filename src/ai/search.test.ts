import { describe, expect, it } from 'vitest'
import {
  createEmptyBoard,
  generateLegalMoves,
  initialPosition,
  type Board,
  type Color,
  type PieceType,
  type Position,
} from '../chess'
import { searchBestMove } from './search'

function place(board: Board, row: number, col: number, type: PieceType, color: Color): void {
  board[row][col] = { type, color }
}

describe('Minimax/Alpha-Beta 搜索', () => {
  it('从初始局面返回一个合法走法', () => {
    const p = initialPosition()
    const move = searchBestMove(p, 3)
    expect(move).not.toBeNull()
    const legal = generateLegalMoves(p)
    expect(
      legal.some(
        (m) =>
          m.from.row === move!.from.row &&
          m.from.col === move!.from.col &&
          m.to.row === move!.to.row &&
          m.to.col === move!.to.col,
      ),
    ).toBe(true)
  })

  it('能发现吃大子（吃掉无保护的车）', () => {
    const b = createEmptyBoard()
    place(b, 9, 4, 'general', 'red')
    place(b, 0, 3, 'general', 'black')
    place(b, 5, 0, 'chariot', 'red')
    place(b, 5, 1, 'chariot', 'black')
    const p: Position = { board: b, sideToMove: 'red' }
    const move = searchBestMove(p, 2)
    expect(move).not.toBeNull()
    expect(move!.from.row === 5 && move!.from.col === 0).toBe(true)
    expect(move!.to.row === 5 && move!.to.col === 1).toBe(true)
  })

  it('将死局面返回 null', () => {
    const b = createEmptyBoard()
    place(b, 9, 4, 'general', 'red')
    place(b, 0, 3, 'general', 'black')
    place(b, 9, 0, 'chariot', 'black')
    place(b, 8, 0, 'chariot', 'black')
    const p: Position = { board: b, sideToMove: 'red' }
    expect(searchBestMove(p, 3)).toBeNull()
  })
})
