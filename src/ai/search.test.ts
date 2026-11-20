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
import { MATE_SCORE, searchBestMove } from './search'

function place(board: Board, row: number, col: number, type: PieceType, color: Color): void {
  board[row][col] = { type, color }
}

function isLegalMove(p: Position, move: { from: { row: number; col: number }; to: { row: number; col: number } }): boolean {
  return generateLegalMoves(p).some(
    (m) =>
      m.from.row === move.from.row &&
      m.from.col === move.from.col &&
      m.to.row === move.to.row &&
      m.to.col === move.to.col,
  )
}

describe('迭代加深 + Alpha-Beta 搜索', () => {
  it('从初始局面返回一个合法走法（红方）', () => {
    const p = initialPosition()
    const result = searchBestMove(p, { maxDepth: 4, timeBudgetMs: 1500 })
    expect(result.move).not.toBeNull()
    expect(result.depth).toBeGreaterThanOrEqual(2)
    expect(isLegalMove(p, result.move!)).toBe(true)
  })

  it('支持黑方走子（换边搜索）', () => {
    const p = initialPosition()
    const blackTurn: Position = { board: p.board, sideToMove: 'black' }
    const result = searchBestMove(blackTurn, { maxDepth: 3, timeBudgetMs: 1500 })
    expect(result.move).not.toBeNull()
    expect(isLegalMove(blackTurn, result.move!)).toBe(true)
  })

  it('能发现吃大子（吃掉无保护的车）', () => {
    const b = createEmptyBoard()
    place(b, 9, 4, 'general', 'red')
    place(b, 0, 3, 'general', 'black')
    place(b, 5, 0, 'chariot', 'red')
    place(b, 5, 1, 'chariot', 'black')
    const p: Position = { board: b, sideToMove: 'red' }
    const result = searchBestMove(p, { maxDepth: 3, timeBudgetMs: 3000 })
    expect(result.move).not.toBeNull()
    expect(result.move!.from.row === 5 && result.move!.from.col === 0).toBe(true)
    expect(result.move!.to.row === 5 && result.move!.to.col === 1).toBe(true)
  })

  it('将死局面返回 null', () => {
    const b = createEmptyBoard()
    place(b, 9, 4, 'general', 'red')
    place(b, 0, 3, 'general', 'black')
    place(b, 9, 0, 'chariot', 'black')
    place(b, 8, 0, 'chariot', 'black')
    const p: Position = { board: b, sideToMove: 'red' }
    expect(searchBestMove(p, { maxDepth: 3, timeBudgetMs: 3000 }).move).toBeNull()
  })

  it('一步杀：深度 1 也能发现将杀，不遗漏深度边界终局', () => {
    // 黑将 (0,4) 被两侧红马与两路红车锁死，红车 (5,4) 吃卒 (4,4) 沉底将杀
    const b = createEmptyBoard()
    place(b, 0, 4, 'general', 'black')
    place(b, 4, 4, 'soldier', 'black')
    place(b, 9, 4, 'general', 'red')
    place(b, 0, 0, 'chariot', 'red')
    place(b, 0, 8, 'chariot', 'red')
    place(b, 1, 1, 'chariot', 'red')
    place(b, 5, 4, 'chariot', 'red')
    place(b, 0, 3, 'horse', 'red')
    place(b, 0, 5, 'horse', 'red')
    const p: Position = { board: b, sideToMove: 'red' }
    const result = searchBestMove(p, { maxDepth: 3, timeBudgetMs: 3000 })
    expect(result.move).not.toBeNull()
    expect(result.move!.from.row === 5 && result.move!.from.col === 4).toBe(true)
    expect(result.move!.to.row === 4 && result.move!.to.col === 4).toBe(true)
    expect(result.score).toBeGreaterThanOrEqual(MATE_SCORE - 100)
  })

  it('两步杀：两层看不到将杀，三层找到强制将杀线路', () => {
    // 将帅只能直线走一格。1. 车(2,2)→(2,4) 将军，黑将 (0,4) 只能逃到 (0,3)；
    // 2. 车(5,5)→(5,3) 照面关门将杀。黑卒 (4,4) 封住将帅照面并充当闲步。
    const b = createEmptyBoard()
    place(b, 0, 4, 'general', 'black')
    place(b, 4, 4, 'soldier', 'black')
    place(b, 9, 4, 'general', 'red')
    place(b, 2, 2, 'chariot', 'red')
    place(b, 5, 5, 'chariot', 'red')
    const p: Position = { board: b, sideToMove: 'red' }

    // 深度 2（两层）无法看到三步后的将杀
    const shallow = searchBestMove(p, { maxDepth: 2, timeBudgetMs: 3000 })
    expect(shallow.move).not.toBeNull()
    expect(shallow.score).toBeLessThan(MATE_SCORE - 100)

    // 深度 3（三层）必须找到将杀
    const result = searchBestMove(p, { maxDepth: 3, timeBudgetMs: 3000 })
    expect(result.move).not.toBeNull()
    expect(result.score).toBeGreaterThanOrEqual(MATE_SCORE - 100)
  })

  it('残局困毙：车(1,2)→(1,5) 令黑方无棋可走即胜', () => {
    // 黑将 (0,4) 未将军，但全部落点被红方车马控制
    const b = createEmptyBoard()
    place(b, 0, 4, 'general', 'black')
    place(b, 9, 3, 'general', 'red')
    place(b, 1, 1, 'horse', 'red')
    place(b, 1, 2, 'chariot', 'red')
    const p: Position = { board: b, sideToMove: 'red' }
    const result = searchBestMove(p, { maxDepth: 2, timeBudgetMs: 3000 })
    expect(result.move).not.toBeNull()
    expect(result.score).toBeGreaterThanOrEqual(MATE_SCORE - 100)
    expect(result.move!.from.row === 1 && result.move!.from.col === 2).toBe(true)
    expect(result.move!.to.row === 1 && result.move!.to.col === 5).toBe(true)
  })

  it('超时预算下仍返回合法走法，且报告完成深度', () => {
    const p = initialPosition()
    const result = searchBestMove(p, { maxDepth: 8, timeBudgetMs: 300 })
    expect(result.move).not.toBeNull()
    expect(isLegalMove(p, result.move!)).toBe(true)
    expect(result.depth).toBeGreaterThanOrEqual(1)
    expect(result.nodes).toBeGreaterThan(0)
  })
})
