import { COLS, ROWS, inBounds, inPalace, onOwnSide } from './board'
import type { Board, Color, Move, Piece, Square } from './types'

/** 生成 color 方所有伪合法走法（不做自陷将军过滤）。不含“将帅照面”作为走法，照面作为将军规则处理。 */
export function generateRawMoves(board: Board, color: Color): Move[] {
  const moves: Move[] = []
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const piece = board[row][col]
      if (!piece || piece.color !== color) continue
      addPieceMoves(board, { row, col }, piece, moves)
    }
  }
  return moves
}

function addPieceMoves(board: Board, from: Square, piece: Piece, moves: Move[]): void {
  switch (piece.type) {
    case 'general':
      addGeneralMoves(board, from, piece.color, moves)
      break
    case 'advisor':
      addAdvisorMoves(board, from, piece.color, moves)
      break
    case 'elephant':
      addElephantMoves(board, from, piece.color, moves)
      break
    case 'horse':
      addHorseMoves(board, from, piece.color, moves)
      break
    case 'chariot':
      addChariotMoves(board, from, piece.color, moves)
      break
    case 'cannon':
      addCannonMoves(board, from, piece.color, moves)
      break
    case 'soldier':
      addSoldierMoves(board, from, piece.color, moves)
      break
  }
}

/** 落点必须在棋盘内，且不能吃掉己方棋子 */
function pushMove(board: Board, from: Square, to: Square, moves: Move[]): void {
  if (!inBounds(to.row, to.col)) return
  const target = board[to.row][to.col]
  if (target && target.color === board[from.row][from.col]!.color) return
  moves.push({ from: { row: from.row, col: from.col }, to: { row: to.row, col: to.col } })
}

function addGeneralMoves(board: Board, from: Square, color: Color, moves: Move[]): void {
  const dirs = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ]
  for (const [dr, dc] of dirs) {
    const to = { row: from.row + dr, col: from.col + dc }
    if (inPalace(to.row, to.col, color)) {
      pushMove(board, from, to, moves)
    }
  }
}

function addAdvisorMoves(board: Board, from: Square, color: Color, moves: Move[]): void {
  const dirs = [
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1],
  ]
  for (const [dr, dc] of dirs) {
    const to = { row: from.row + dr, col: from.col + dc }
    if (inPalace(to.row, to.col, color)) {
      pushMove(board, from, to, moves)
    }
  }
}

function addElephantMoves(board: Board, from: Square, color: Color, moves: Move[]): void {
  const dirs = [
    [-2, -2],
    [-2, 2],
    [2, -2],
    [2, 2],
  ]
  for (const [dr, dc] of dirs) {
    const to = { row: from.row + dr, col: from.col + dc }
    if (!inBounds(to.row, to.col)) continue
    if (!onOwnSide(to.row, color)) continue
    // 象眼
    const eye = { row: from.row + dr / 2, col: from.col + dc / 2 }
    if (board[eye.row][eye.col] !== null) continue
    pushMove(board, from, to, moves)
  }
}

function addHorseMoves(board: Board, from: Square, _color: Color, moves: Move[]): void {
  // [目标行差, 目标列差, 马腿行差, 马腿列差]
  const steps: Array<[number, number, number, number]> = [
    [-2, -1, -1, 0],
    [-2, 1, -1, 0],
    [2, -1, 1, 0],
    [2, 1, 1, 0],
    [-1, -2, 0, -1],
    [1, -2, 0, -1],
    [-1, 2, 0, 1],
    [1, 2, 0, 1],
  ]
  for (const [dr, dc, lr, lc] of steps) {
    const to = { row: from.row + dr, col: from.col + dc }
    if (!inBounds(to.row, to.col)) continue
    const leg = { row: from.row + lr, col: from.col + lc }
    if (board[leg.row][leg.col] !== null) continue // 蹩马腿
    pushMove(board, from, to, moves)
  }
}

function addChariotMoves(board: Board, from: Square, color: Color, moves: Move[]): void {
  const dirs = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ]
  for (const [dr, dc] of dirs) {
    let r = from.row + dr
    let c = from.col + dc
    while (inBounds(r, c)) {
      const target = board[r][c]
      if (target === null) {
        moves.push({ from: { row: from.row, col: from.col }, to: { row: r, col: c } })
      } else {
        if (target.color !== color) {
          moves.push({ from: { row: from.row, col: from.col }, to: { row: r, col: c } })
        }
        break
      }
      r += dr
      c += dc
    }
  }
}

function addCannonMoves(board: Board, from: Square, color: Color, moves: Move[]): void {
  const dirs = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ]
  for (const [dr, dc] of dirs) {
    let r = from.row + dr
    let c = from.col + dc
    // 平移：走到第一个阻挡或棋盘边缘
    while (inBounds(r, c) && board[r][c] === null) {
      moves.push({ from: { row: from.row, col: from.col }, to: { row: r, col: c } })
      r += dr
      c += dc
    }
    // 越过炮架（第一枚棋子）
    if (!inBounds(r, c)) continue
    r += dr
    c += dc
    // 吃子：炮架之后第一枚敌方棋子
    while (inBounds(r, c) && board[r][c] === null) {
      r += dr
      c += dc
    }
    if (inBounds(r, c) && board[r][c]!.color !== color) {
      moves.push({ from: { row: from.row, col: from.col }, to: { row: r, col: c } })
    }
  }
}

function addSoldierMoves(board: Board, from: Square, color: Color, moves: Move[]): void {
  const forward = color === 'red' ? -1 : 1
  pushMove(board, from, { row: from.row + forward, col: from.col }, moves)
  const crossed = color === 'red' ? from.row <= 4 : from.row >= 5
  if (crossed) {
    pushMove(board, from, { row: from.row, col: from.col - 1 }, moves)
    pushMove(board, from, { row: from.row, col: from.col + 1 }, moves)
  }
}
