<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  applyMove,
  generateLegalMoves,
  getGameStatus,
  initialPosition,
  PIECE_CHARS,
} from './chess'
import type { Color, GameStatus, Move, Piece, Position, Square } from './chess'

type AiLevel = 'random' | 'search'

// 棋盘坐标系常量（与 board.svg 的 viewBox 0 0 600 660 一致）
const BOARD_W = 600
const ORIGIN = 60
const CELL = 60
const PIECE_D = 54 // 棋子直径
const FONT_SIZE = 28

const board = ref(initialPosition().board)
const sideToMove = ref<Color>('red')
const selected = ref<Square | null>(null)
const status = ref<GameStatus>('playing')
const aiLevel = ref<AiLevel>('search')
const thinking = ref(false)
const muted = ref(false)
const lastMove = ref<Move | null>(null)

const gameId = ref(0)
let worker: Worker | null = null
let resizeObserver: ResizeObserver | null = null

const boardEl = ref<HTMLElement | null>(null)
const scale = ref(1)

const currentPosition = computed<Position>(() => ({
  board: board.value,
  sideToMove: sideToMove.value,
}))

const pieces = computed<Array<{ row: number; col: number; piece: Piece }>>(() => {
  const list: Array<{ row: number; col: number; piece: Piece }> = []
  for (let row = 0; row < 10; row++) {
    for (let col = 0; col < 9; col++) {
      const piece = board.value[row][col]
      if (piece) list.push({ row, col, piece })
    }
  }
  return list
})

const legalMoves = computed<Move[]>(() => {
  if (status.value !== 'playing') return []
  return generateLegalMoves(currentPosition.value)
})

const legalTargets = computed<Square[]>(() => {
  if (!selected.value) return []
  return legalMoves.value
    .filter((m) => m.from.row === selected.value!.row && m.from.col === selected.value!.col)
    .map((m) => m.to)
})

const turnText = computed(() => {
  if (status.value === 'redWon') return '红方胜（你赢了）'
  if (status.value === 'blackWon') return '黑方胜（电脑赢了）'
  return sideToMove.value === 'red' ? '你的回合（红方）' : '电脑回合（黑方）'
})

function isPlayerTurn(): boolean {
  return status.value === 'playing' && sideToMove.value === 'red' && !thinking.value
}

function isLegalTarget(row: number, col: number): boolean {
  return legalTargets.value.some((s) => s.row === row && s.col === col)
}

function onSquareClick(row: number, col: number): void {
  if (!isPlayerTurn()) return
  const piece = board.value[row][col]

  if (selected.value) {
    if (isLegalTarget(row, col)) {
      const move = legalMoves.value.find(
        (m) =>
          m.from.row === selected.value!.row &&
          m.from.col === selected.value!.col &&
          m.to.row === row &&
          m.to.col === col,
      )
      if (move) {
        applyPlayerMove(move)
      }
      return
    }
    if (piece && piece.color === 'red') {
      selected.value = { row, col }
      return
    }
    selected.value = null
    return
  }

  if (piece && piece.color === 'red') {
    selected.value = { row, col }
  }
}

function applyPlayerMove(move: Move): void {
  doMove(move)
  selected.value = null
  afterMove()
}

function doMove(move: Move): void {
  const captured = board.value[move.to.row][move.to.col] !== null
  const next = applyMove(currentPosition.value, move)
  board.value = next.board
  sideToMove.value = next.sideToMove
  lastMove.value = move
  playSound(captured ? 'capture' : 'move')
}

function afterMove(): void {
  const st = getGameStatus(currentPosition.value)
  status.value = st
  if (st !== 'playing') {
    thinking.value = false
    return
  }
  if (sideToMove.value === 'black') {
    scheduleComputer()
  }
}

function scheduleComputer(): void {
  thinking.value = true
  const id = ++gameId.value

  if (aiLevel.value === 'random') {
    window.setTimeout(() => {
      if (id !== gameId.value) return
      const moves = generateLegalMoves(currentPosition.value)
      if (moves.length === 0) {
        thinking.value = false
        return
      }
      const move = moves[Math.floor(Math.random() * moves.length)]
      doMove(move)
      afterMove()
    }, 350)
    return
  }

  const w = getWorker()
  w.postMessage({
    gameId: id,
    position: JSON.parse(JSON.stringify(currentPosition.value)) as Position,
    depth: 3,
  })

  // 兜底：若搜索 6 秒仍未返回（如 Worker 异常），改用随机走法保证对局可继续
  window.setTimeout(() => {
    if (id !== gameId.value || !thinking.value) return
    gameId.value++ // 使仍在计算的结果失效
    console.warn('[AI] 搜索超时，兜底使用随机走法')
    thinking.value = false
    const moves = generateLegalMoves(currentPosition.value)
    if (moves.length > 0) {
      const move = moves[Math.floor(Math.random() * moves.length)]
      doMove(move)
      afterMove()
    }
  }, 6000)
}

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./ai/worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent) => {
      const { gameId: id, move, error } = event.data as {
        gameId: number
        move: Move | null
        error?: string
      }
      if (id !== gameId.value) return // 忽略上一局尚未返回的结果
      if (error) {
        console.error('[AI Worker] 搜索出错：', error)
        thinking.value = false
        const moves = generateLegalMoves(currentPosition.value)
        if (moves.length > 0) {
          const move = moves[Math.floor(Math.random() * moves.length)]
          doMove(move)
          afterMove()
        }
        return
      }
      thinking.value = false
      if (move) {
        doMove(move)
        afterMove()
      }
    }
    worker.onerror = (e) => {
      console.error('[AI Worker] 加载或运行错误：', e.message)
    }
  }
  return worker
}

function restart(): void {
  gameId.value++ // 使尚未返回的计算结果失效
  board.value = initialPosition().board
  sideToMove.value = 'red'
  selected.value = null
  status.value = 'playing'
  thinking.value = false
  lastMove.value = null
}

function playSound(kind: 'move' | 'capture'): void {
  if (muted.value) return
  try {
    const audio = new Audio(`/assets/xiangqi/${kind}.ogg`)
    void audio.play()
  } catch {
    /* ignore */
  }
}

// 棋盘缩放：以容器宽度映射到 600 坐标系
function px(v: number): string {
  return `${(v * scale.value).toFixed(2)}px`
}

function centerStyle(row: number, col: number) {
  return {
    left: px(ORIGIN + CELL * col),
    top: px(ORIGIN + CELL * row),
  }
}

function pieceStyle(row: number, col: number) {
  return {
    ...centerStyle(row, col),
    width: px(PIECE_D),
    height: px(PIECE_D),
    fontSize: px(FONT_SIZE),
  }
}

function ringStyle(square: Square) {
  return {
    ...centerStyle(square.row, square.col),
    width: px(PIECE_D),
    height: px(PIECE_D),
  }
}

function dotStyle(square: Square) {
  const occupied = board.value[square.row][square.col] !== null
  const size = occupied ? PIECE_D : 14
  return {
    ...centerStyle(square.row, square.col),
    width: px(size),
    height: px(size),
  }
}

function pieceClass(piece: Piece): string {
  return `piece piece--${piece.color}`
}

function pieceChar(piece: Piece): string {
  return PIECE_CHARS[piece.color][piece.type]
}

function updateScale(): void {
  if (boardEl.value) {
    scale.value = boardEl.value.clientWidth / BOARD_W
  }
}

onMounted(() => {
  updateScale()
  resizeObserver = new ResizeObserver(updateScale)
  if (boardEl.value) resizeObserver.observe(boardEl.value)
})

onUnmounted(() => {
  resizeObserver?.disconnect()
  worker?.terminate()
  worker = null
})
</script>

<template>
  <div class="app">
    <header class="header">
      <h1 class="title">楚河棋局</h1>
      <div class="status" :class="`status--${status}`">{{ turnText }}</div>
      <div class="controls">
        <label class="field">
          电脑：
          <select v-model="aiLevel" :disabled="thinking">
            <option value="random">随机</option>
            <option value="search">搜索（Minimax）</option>
          </select>
        </label>
        <button class="btn" @click="muted = !muted">{{ muted ? '开启声音' : '静音' }}</button>
        <button class="btn" @click="restart">重新开始</button>
      </div>
    </header>

    <main class="board-wrap">
      <div class="board" ref="boardEl">
        <img class="board__img" src="/assets/xiangqi/board.svg" alt="棋盘" draggable="false" />

        <div class="board__layer">
          <div v-if="lastMove" class="mark" :style="ringStyle(lastMove.from)"></div>
          <div v-if="lastMove" class="mark" :style="ringStyle(lastMove.to)"></div>

          <div v-if="selected" class="selected-ring" :style="ringStyle(selected)"></div>

          <div
            v-for="t in legalTargets"
            :key="`t-${t.row}-${t.col}`"
            class="dot"
            :class="{ 'dot--capture': board[t.row][t.col] !== null }"
            :style="dotStyle(t)"
            @click="onSquareClick(t.row, t.col)"
          ></div>

          <div
            v-for="p in pieces"
            :key="`p-${p.row}-${p.col}`"
            class="piece"
            :class="pieceClass(p.piece)"
            :style="pieceStyle(p.row, p.col)"
            @click="onSquareClick(p.row, p.col)"
          >
            <div class="piece__inner">
              <span class="piece__char">{{ pieceChar(p.piece) }}</span>
            </div>
          </div>
        </div>

        <div v-if="thinking" class="thinking">电脑思考中…</div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.app {
  max-width: 720px;
  margin: 0 auto;
  padding: 16px;
}

.header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.title {
  font-size: 28px;
  letter-spacing: 4px;
}

.status {
  font-size: 15px;
  padding: 4px 12px;
  border-radius: 999px;
  background: #e9dcc3;
}

.controls {
  margin-left: auto;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.field {
  font-size: 14px;
}

.field select {
  font-family: inherit;
  font-size: 14px;
  padding: 4px 6px;
}

.btn {
  font-family: inherit;
  font-size: 14px;
  padding: 6px 12px;
  border: 1px solid #b89c6f;
  border-radius: 6px;
  background: #fbf2df;
  cursor: pointer;
}

.btn:hover {
  background: #f3e6cd;
}

.board-wrap {
  display: flex;
  justify-content: center;
}

.board {
  position: relative;
  width: min(92vw, 600px);
  aspect-ratio: 600 / 660;
  user-select: none;
}

.board__img {
  width: 100%;
  height: 100%;
  display: block;
}

.board__layer {
  position: absolute;
  inset: 0;
}

.mark {
  position: absolute;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background: rgba(46, 125, 50, 0.14);
  z-index: 1;
  pointer-events: none;
}

.selected-ring {
  position: absolute;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  border: 3px solid #2e7d32;
  box-sizing: border-box;
  z-index: 1;
  pointer-events: none;
}

.piece {
  position: absolute;
  transform: translate(-50%, -50%);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 2;
}

.piece__inner {
  position: relative;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  background: #fbf2df;
  border: 1.3px solid currentColor;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.18);
}

.piece__inner::before {
  content: '';
  position: absolute;
  width: 83%;
  height: 83%;
  border: 0.8px solid currentColor;
  border-radius: 50%;
  box-sizing: border-box;
}

.piece__char {
  position: relative;
  z-index: 1;
  font-weight: 700;
  line-height: 1;
}

.piece--red {
  color: #952f29;
}

.piece--black {
  color: #292726;
}

.dot {
  position: absolute;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background: rgba(46, 125, 50, 0.55);
  cursor: pointer;
  z-index: 3;
}

.dot--capture {
  background: transparent;
  border: 3px solid rgba(46, 125, 50, 0.8);
  box-sizing: border-box;
}

.thinking {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  padding: 8px 16px;
  border-radius: 8px;
  font-size: 15px;
  pointer-events: none;
}
</style>
