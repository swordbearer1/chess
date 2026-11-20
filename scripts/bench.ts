/**
 * 各档难度实测基准：用固定棋局比较战术表现、实际用时、完成深度与搜索节点数。
 * 运行：npx vite-node scripts/bench.ts
 */
import { createEmptyBoard, initialPosition } from '../src/chess'
import type { Board, Color, PieceType, Position } from '../src/chess'
import { MATE_SCORE, searchBestMove } from '../src/ai/search'
import { AI_LEVELS, type AiLevel } from '../src/ai/levels'

function place(board: Board, row: number, col: number, type: PieceType, color: Color): void {
  board[row][col] = { type, color }
}

/** 中局吃子战术：红车吃无保护的黑车 */
function positionCapture(): Position {
  const b = createEmptyBoard()
  place(b, 9, 4, 'general', 'red')
  place(b, 0, 3, 'general', 'black')
  place(b, 5, 0, 'chariot', 'red')
  place(b, 5, 1, 'chariot', 'black')
  return { board: b, sideToMove: 'red' }
}

/** 一步杀：红车 (5,4) 吃卒 (4,4) 沉底将杀 */
function positionMateIn1(): Position {
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
  return { board: b, sideToMove: 'red' }
}

/** 两步杀（三层搜索可找到）：1. 车(2,2)→(2,4)+ 黑将 (0,4) 被迫逃 (0,3)；2. 车(5,5)→(5,3)# */
function positionMateIn2(): Position {
  const b = createEmptyBoard()
  place(b, 0, 4, 'general', 'black')
  place(b, 4, 4, 'soldier', 'black')
  place(b, 9, 4, 'general', 'red')
  place(b, 2, 2, 'chariot', 'red')
  place(b, 5, 5, 'chariot', 'red')
  return { board: b, sideToMove: 'red' }
}

interface CaseDef {
  name: string
  position: Position
  /** 期望走法（用于判断战术是否找到） */
  expect?: { from: [number, number]; to: [number, number] }
  expectMate?: boolean
}

const CASES: CaseDef[] = [
  { name: '开局（初始局面）', position: initialPosition() },
  {
    name: '中局吃车',
    position: positionCapture(),
    expect: { from: [5, 0], to: [5, 1] },
  },
  {
    name: '一步杀',
    position: positionMateIn1(),
    expect: { from: [5, 4], to: [4, 4] },
    expectMate: true,
  },
  {
    name: '两步杀',
    position: positionMateIn2(),
    expectMate: true,
  },
]

function moveText(move: { from: { row: number; col: number }; to: { row: number; col: number } } | null): string {
  if (!move) return '—'
  return `(${move.from.row},${move.from.col})→(${move.to.row},${move.to.col})`
}

const SEARCH_LEVELS: AiLevel[] = ['normal', 'hard', 'expert']

interface Row {
  局面: string
  难度: string
  走法: string
  评估: number
  完成深度: number
  节点数: number
  '用时(ms)': number
  结果: string
}

function main(): void {
  const rows: Row[] = []
  for (const level of SEARCH_LEVELS) {
    const cfg = AI_LEVELS[level]
    for (const c of CASES) {
      // 预热一次，避免首次 JIT 偏差
      searchBestMove(c.position, { maxDepth: cfg.maxDepth, timeBudgetMs: 200 })
      const t0 = performance.now()
      const r = searchBestMove(c.position, { maxDepth: cfg.maxDepth, timeBudgetMs: cfg.timeBudgetMs })
      const ms = performance.now() - t0

      let verdict = '合法走法'
      if (c.expectMate) {
        verdict = r.score >= MATE_SCORE - 100 ? '找到将杀' : '未找到将杀'
      } else if (c.expect && r.move) {
        const ok =
          r.move.from.row === c.expect.from[0] &&
          r.move.from.col === c.expect.from[1] &&
          r.move.to.row === c.expect.to[0] &&
          r.move.to.col === c.expect.to[1]
        verdict = ok ? '找到最佳走法' : '未找到最佳走法'
      }
      rows.push({
        局面: c.name,
        难度: cfg.label,
        走法: moveText(r.move),
        评估: r.score,
        完成深度: r.depth,
        节点数: r.nodes,
        '用时(ms)': Math.round(ms * 10) / 10,
        结果: verdict,
      })
    }
  }

  console.table(rows)
  console.log('注：入门档为随机合法走法，不参与搜索基准。')
  console.log('注：以上数值在 Node（vite-node）下测得，浏览器 Worker 中会有 ±20% 左右浮动。')
}

main()
