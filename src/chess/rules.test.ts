import { describe, expect, it } from 'vitest'
import {
  applyMove,
  createEmptyBoard,
  generateLegalMoves,
  generateRawMoves,
  getGameStatus,
  initialPosition,
  isInCheck,
  opposite,
} from './index'
import type { Board, Color, Move, PieceType, Position, Square } from './index'

function place(board: Board, row: number, col: number, type: PieceType, color: Color): void {
  board[row][col] = { type, color }
}

function pos(board: Board, sideToMove: Color): Position {
  return { board, sideToMove }
}

function hasMove(moves: Move[], from: Square, to: Square): boolean {
  return moves.some((m) => m.from.row === from.row && m.from.col === from.col && m.to.row === to.row && m.to.col === to.col)
}

function kingsBoard(): Board {
  const b = createEmptyBoard()
  place(b, 9, 4, 'general', 'red')
  place(b, 0, 3, 'general', 'black')
  return b
}

describe('初始局面', () => {
  it('红方先行且双方都有合法走法', () => {
    const p = initialPosition()
    expect(p.sideToMove).toBe('red')
    expect(generateLegalMoves(p).length).toBeGreaterThan(0)

    const black = { ...p, sideToMove: 'black' as Color }
    expect(generateLegalMoves(black).length).toBeGreaterThan(0)
  })

  it('初始局面双方均未被将军', () => {
    const p = initialPosition()
    expect(isInCheck(p.board, 'red')).toBe(false)
    expect(isInCheck(p.board, 'black')).toBe(false)
  })
})

describe('炮的走法', () => {
  it('隔一子吃子', () => {
    const b = kingsBoard()
    place(b, 5, 0, 'cannon', 'red')
    place(b, 5, 1, 'soldier', 'black') // 炮架
    place(b, 5, 2, 'chariot', 'black') // 目标
    const moves = generateRawMoves(b, 'red')
    expect(hasMove(moves, { row: 5, col: 0 }, { row: 5, col: 2 })).toBe(true)
    // 炮不能直接吃紧邻的炮架
    expect(hasMove(moves, { row: 5, col: 0 }, { row: 5, col: 1 })).toBe(false)
  })

  it('无炮架时不能吃子', () => {
    const b = kingsBoard()
    place(b, 5, 0, 'cannon', 'red')
    place(b, 5, 2, 'chariot', 'black') // 中间无子
    const moves = generateRawMoves(b, 'red')
    expect(hasMove(moves, { row: 5, col: 0 }, { row: 5, col: 2 })).toBe(false)
  })

  it('炮架后是己方棋子时不能吃', () => {
    const b = kingsBoard()
    place(b, 5, 0, 'cannon', 'red')
    place(b, 5, 1, 'soldier', 'black')
    place(b, 5, 2, 'chariot', 'red')
    const moves = generateRawMoves(b, 'red')
    expect(hasMove(moves, { row: 5, col: 0 }, { row: 5, col: 2 })).toBe(false)
  })
})

describe('马的走法', () => {
  it('蹩马腿', () => {
    const b = kingsBoard()
    place(b, 5, 4, 'horse', 'red')
    place(b, 4, 4, 'soldier', 'black') // 蹩住上方马腿
    const moves = generateRawMoves(b, 'red')
    // 上方两个目标被蹩
    expect(hasMove(moves, { row: 5, col: 4 }, { row: 3, col: 3 })).toBe(false)
    expect(hasMove(moves, { row: 5, col: 4 }, { row: 3, col: 5 })).toBe(false)
    // 不受影响的方向仍可走
    expect(hasMove(moves, { row: 5, col: 4 }, { row: 6, col: 2 })).toBe(true)
    expect(hasMove(moves, { row: 5, col: 4 }, { row: 7, col: 3 })).toBe(true)
  })
})

describe('象/相的走法', () => {
  it('象眼被塞时不能走', () => {
    const b = kingsBoard()
    place(b, 5, 2, 'elephant', 'red')
    place(b, 6, 3, 'soldier', 'black') // 塞象眼
    const moves = generateRawMoves(b, 'red')
    expect(hasMove(moves, { row: 5, col: 2 }, { row: 3, col: 4 })).toBe(false)
  })

  it('象不能过河', () => {
    const b = kingsBoard()
    place(b, 5, 2, 'elephant', 'red')
    const moves = generateRawMoves(b, 'red')
    // 红象只能落在第 5 行及以下（row>=5）
    for (const m of moves) {
      expect(m.to.row).toBeGreaterThanOrEqual(5)
    }
  })
})

describe('将帅照面', () => {
  it('撤开将帅间的挡子属于自陷将军，非法', () => {
    const b = createEmptyBoard()
    place(b, 9, 4, 'general', 'red')
    place(b, 0, 4, 'general', 'black') // 同列
    place(b, 5, 4, 'chariot', 'red') // 挡子
    const p = pos(b, 'red')

    const moves = generateLegalMoves(p)
    // 挡子仍留在同一列（例如下移一格）合法
    expect(hasMove(moves, { row: 5, col: 4 }, { row: 6, col: 4 })).toBe(true)
    // 挡子移出该列则两将照面，非法
    expect(hasMove(moves, { row: 5, col: 4 }, { row: 5, col: 0 })).toBe(false)
  })

  it('两将同列且中间无子视为被将军', () => {
    const b = createEmptyBoard()
    place(b, 9, 4, 'general', 'red')
    place(b, 0, 4, 'general', 'black')
    expect(isInCheck(b, 'red')).toBe(true)
    expect(isInCheck(b, 'black')).toBe(true)
  })
})

describe('被将军时的应对', () => {
  function checkPosition(): Position {
    const b = createEmptyBoard()
    place(b, 9, 4, 'general', 'red')
    place(b, 0, 3, 'general', 'black')
    place(b, 9, 0, 'chariot', 'black') // 沿第 9 行将军
    place(b, 7, 2, 'horse', 'red') // 可跳马到 (9,3) 挡将
    return pos(b, 'red')
  }

  it('处于将军状态', () => {
    const p = checkPosition()
    expect(isInCheck(p.board, 'red')).toBe(true)
  })

  it('仅允许解将的走法', () => {
    const p = checkPosition()
    const moves = generateLegalMoves(p)
    for (const m of moves) {
      const next = applyMove(p, m)
      expect(isInCheck(next.board, 'red')).toBe(false)
    }
    // 跳马挡将合法
    expect(hasMove(moves, { row: 7, col: 2 }, { row: 9, col: 3 })).toBe(true)
    // 将逃离合法
    expect(hasMove(moves, { row: 9, col: 4 }, { row: 8, col: 4 })).toBe(true)
    // 不解决将军的走法非法
    expect(hasMove(moves, { row: 7, col: 2 }, { row: 5, col: 3 })).toBe(false)
  })
})

describe('胜负判定', () => {
  it('将死（无合法走法且被将军）判负', () => {
    const b = createEmptyBoard()
    place(b, 9, 4, 'general', 'red')
    place(b, 0, 3, 'general', 'black')
    place(b, 9, 0, 'chariot', 'black') // 将军
    place(b, 8, 0, 'chariot', 'black') // 封住 (8,4)
    const p = pos(b, 'red')
    expect(isInCheck(p.board, 'red')).toBe(true)
    expect(generateLegalMoves(p).length).toBe(0)
    expect(getGameStatus(p)).toBe('blackWon')
  })

  it('困毙（无合法走法但未被将军）判负', () => {
    const b = createEmptyBoard()
    place(b, 9, 4, 'general', 'red')
    place(b, 0, 3, 'general', 'black')
    place(b, 8, 0, 'chariot', 'black') // 攻击 (8,4)
    place(b, 9, 2, 'soldier', 'black') // 攻击 (9,3)
    place(b, 9, 6, 'soldier', 'black') // 攻击 (9,5)
    const p = pos(b, 'red')
    expect(isInCheck(p.board, 'red')).toBe(false)
    expect(generateLegalMoves(p).length).toBe(0)
    expect(getGameStatus(p)).toBe('blackWon')
  })
})

describe('兵/卒的走法', () => {
  it('未过河只能前进，过河后可横走', () => {
    const b = kingsBoard()
    place(b, 6, 4, 'soldier', 'red')
    const redMoves = generateRawMoves(b, 'red').filter((m) => m.from.row === 6 && m.from.col === 4)
    // 前进合法
    expect(redMoves.some((m) => m.to.row === 5 && m.to.col === 4)).toBe(true)
    // 未过河不能横走
    expect(redMoves.some((m) => m.to.col === 3)).toBe(false)
    expect(redMoves.some((m) => m.to.col === 5)).toBe(false)
    // 不能后退
    expect(redMoves.some((m) => m.to.row === 7)).toBe(false)

    // 黑卒已过河（row>=5）
    place(b, 5, 6, 'soldier', 'black')
    const blackMoves = generateRawMoves(b, 'black').filter((m) => m.from.row === 5 && m.from.col === 6)
    // 前进合法
    expect(blackMoves.some((m) => m.to.row === 6 && m.to.col === 6)).toBe(true)
    // 过河后可横走
    expect(blackMoves.some((m) => m.to.row === 5 && m.to.col === 5)).toBe(true)
    expect(blackMoves.some((m) => m.to.row === 5 && m.to.col === 7)).toBe(true)
    // 不能后退
    expect(blackMoves.some((m) => m.to.row === 4)).toBe(false)
  })
})

describe('自陷将军过滤', () => {
  it('走棋后仍被将军的走法被过滤', () => {
    const b = createEmptyBoard()
    place(b, 9, 4, 'general', 'red')
    place(b, 0, 3, 'general', 'black')
    place(b, 8, 4, 'advisor', 'red')
    place(b, 9, 0, 'chariot', 'black') // 沿第 9 行将军
    const p = pos(b, 'red')
    const moves = generateLegalMoves(p)
    // 仕不能走到仍被将军的位置（实际上仕只能斜走，验证所有走法都解将）
    for (const m of moves) {
      expect(isInCheck(applyMove(p, m).board, 'red')).toBe(false)
    }
  })
})

describe('工具函数', () => {
  it('opposite', () => {
    expect(opposite('red')).toBe('black')
    expect(opposite('black')).toBe('red')
  })
})
