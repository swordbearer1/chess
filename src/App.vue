<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import {
  applyMove,
  generateLegalMoves,
  getGameStatus,
  initialPosition,
  PIECE_CHARS,
} from './chess'
import type { Board, Color, GameStatus, Move, Piece, Position, Square } from './chess'

type AiLevel = 'random' | 'search'
type Phase = 'idle' | 'player-anim' | 'thinking' | 'computer-anim'

interface PieceView {
  id: number
  piece: Piece
  row: number
  col: number
}

// 棋盘坐标系常量（与 board.svg 的 viewBox 0 0 600 660 一致）
const BOARD_W = 600
const ORIGIN = 60
const CELL = 60
const PIECE_D = 54 // 棋子直径
const FONT_SIZE = 28

const ANIM_MS = 500 // 落子动画时长
const MIN_THINK_MS = 1500 // 电脑在玩家棋子到达目标点后至少等待 1500ms 才能进入动画

const board = ref(initialPosition().board)
const sideToMove = ref<Color>('red')
const selected = ref<Square | null>(null)
const status = ref<GameStatus>('playing')
const aiLevel = ref<AiLevel>('search')
const muted = ref(false)
const lastMove = ref<Move | null>(null)
const started = ref(false) // 是否已点击「开始对弈」
const gameReady = ref(false) // 转场完成、棋盘完全出现后才允许走棋

const phase = ref<Phase>('idle')
const pendingComputerMove = ref<Move | null>(null)
let thinkDeadline = 0

const gameId = ref(0)
const boardGen = ref(0) // 仅在重开时自增，用于强制重建棋子 DOM，清除残留动画
let worker: Worker | null = null
let resizeObserver: ResizeObserver | null = null

const boardEl = ref<HTMLElement | null>(null)
const scale = ref(1)

const pieceViews = ref<PieceView[]>(buildPieceViews(board.value))
const pieceEls = new Map<number, HTMLElement>()

// 计时器集合，重开时统一清理
const timers = new Set<number>()

const currentPosition = computed<Position>(() => ({
  board: board.value,
  sideToMove: sideToMove.value,
}))

const legalMoves = computed<Move[]>(() => {
  if (status.value !== 'playing' || phase.value !== 'idle') return []
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
  if (phase.value === 'thinking') return '电脑思考中…'
  if (phase.value === 'computer-anim') return '电脑回合（黑方）'
  return '你的回合（红方）'
})

function buildPieceViews(b: Board): PieceView[] {
  const list: PieceView[] = []
  let id = 0
  for (let row = 0; row < 10; row++) {
    for (let col = 0; col < 9; col++) {
      const piece = b[row][col]
      if (piece) list.push({ id: id++, piece, row, col })
    }
  }
  return list
}

function findView(row: number, col: number): PieceView | undefined {
  return pieceViews.value.find((v) => v.row === row && v.col === col)
}

function removeView(id: number): void {
  const idx = pieceViews.value.findIndex((v) => v.id === id)
  if (idx >= 0) pieceViews.value.splice(idx, 1)
}

function setPieceEl(id: number, el: unknown): void {
  if (el instanceof HTMLElement) pieceEls.set(id, el)
  else pieceEls.delete(id)
}

function later(fn: () => void, ms: number): void {
  const id = window.setTimeout(() => {
    timers.delete(id)
    fn()
  }, ms)
  timers.add(id)
}

function clearTimers(): void {
  for (const id of timers) window.clearTimeout(id)
  timers.clear()
}

function canInteract(): boolean {
  return phase.value === 'idle' && status.value === 'playing' && gameReady.value
}

function isLegalTarget(row: number, col: number): boolean {
  return legalTargets.value.some((s) => s.row === row && s.col === col)
}

function onSquareClick(row: number, col: number): void {
  if (!canInteract()) return
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
  selected.value = null
  phase.value = 'player-anim'
  // 先更新棋盘（同步），再启动电脑计算，使 Worker 在红方动画期间并行计算
  animateMove(move, onPlayerArrival)
  startComputerThinking()
}

function onPlayerArrival(): void {
  const st = getGameStatus(currentPosition.value)
  if (st !== 'playing') {
    status.value = st
    phase.value = 'idle'
    return
  }
  phase.value = 'thinking'
  thinkDeadline = performance.now() + MIN_THINK_MS
  if (pendingComputerMove.value !== null) scheduleApplyWhenReady()
}

function startComputerThinking(): void {
  const id = ++gameId.value

  if (aiLevel.value === 'random') {
    const moves = generateLegalMoves(currentPosition.value)
    pendingComputerMove.value = moves.length
      ? moves[Math.floor(Math.random() * moves.length)]
      : null
    return
  }

  const w = getWorker()
  w.postMessage({
    gameId: id,
    position: JSON.parse(JSON.stringify(currentPosition.value)) as Position,
    depth: 3,
  })

  // 安全兜底：Worker 异常挂起时改用随机走法
  later(() => {
    if (phase.value === 'thinking' && pendingComputerMove.value === null) {
      const moves = generateLegalMoves(currentPosition.value)
      pendingComputerMove.value = moves.length
        ? moves[Math.floor(Math.random() * moves.length)]
        : null
      onComputerResultReady()
    }
  }, 8000)
}

function onComputerResultReady(): void {
  if (phase.value === 'player-anim') return // 等红方动画结束
  if (phase.value === 'thinking') scheduleApplyWhenReady()
}

function scheduleApplyWhenReady(): void {
  if (phase.value !== 'thinking' || pendingComputerMove.value === null) return
  const remaining = thinkDeadline - performance.now()
  if (remaining <= 0) {
    applyComputerMoveNow()
  } else {
    later(applyComputerMoveNow, remaining)
  }
}

function applyComputerMoveNow(): void {
  if (phase.value !== 'thinking') return
  const move = pendingComputerMove.value
  if (!move) return
  pendingComputerMove.value = null
  phase.value = 'computer-anim'
  animateMove(move, onComputerArrival)
}

function onComputerArrival(): void {
  status.value = getGameStatus(currentPosition.value)
  phase.value = 'idle'
}

function animateMove(move: Move, onArrival: () => void): void {
  const captured = board.value[move.to.row][move.to.col] !== null
  const capturedView = captured ? findView(move.to.row, move.to.col) : undefined

  const next = applyMove(currentPosition.value, move)
  board.value = next.board
  sideToMove.value = next.sideToMove
  lastMove.value = move

  const attacker = findView(move.from.row, move.from.col)
  if (attacker) {
    movePiece(attacker, move.from, move.to)
  }

  later(() => {
    if (capturedView) removeView(capturedView.id)
    playSound(captured ? 'capture' : 'move')
    onArrival()
  }, ANIM_MS)
}

function movePiece(view: PieceView, from: Square, to: Square): void {
  const el = pieceEls.get(view.id)
  view.row = to.row
  view.col = to.col
  if (el) {
    el.animate(
      [
        { left: px(ORIGIN + CELL * from.col), top: px(ORIGIN + CELL * from.row) },
        { left: px(ORIGIN + CELL * to.col), top: px(ORIGIN + CELL * to.row) },
      ],
      { duration: ANIM_MS, easing: 'ease', fill: 'forwards' },
    )
  }
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
        const moves = generateLegalMoves(currentPosition.value)
        pendingComputerMove.value = moves.length
          ? moves[Math.floor(Math.random() * moves.length)]
          : null
      } else {
        pendingComputerMove.value = move
      }
      onComputerResultReady()
    }
    worker.onerror = (e) => {
      console.error('[AI Worker] 加载或运行错误：', e.message)
    }
  }
  return worker
}

function onStart(): void {
  if (started.value) return // 转场期间只接受一次开始操作
  started.value = true
}

function onBoardEnter(): void {
  // 棋盘进入 DOM 时初始化缩放与尺寸观察器，确保淡入前棋子已对齐
  updateScale()
  if (!resizeObserver) resizeObserver = new ResizeObserver(updateScale)
  if (boardEl.value) resizeObserver.observe(boardEl.value)
}

function onBoardEntered(): void {
  gameReady.value = true
}

function restart(): void {
  gameId.value++ // 使尚未返回的计算结果失效
  boardGen.value++ // 重建棋子 DOM，清除残留的落子动画
  clearTimers() // 清理旧动画/计时的回调
  pendingComputerMove.value = null

  const p = initialPosition()
  board.value = p.board
  sideToMove.value = 'red'
  status.value = 'playing'
  selected.value = null
  lastMove.value = null
  phase.value = 'idle'
  pieceViews.value = buildPieceViews(p.board)
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

function markerStyle(square: Square, size: number) {
  return {
    ...centerStyle(square.row, square.col),
    width: px(size),
    height: px(size),
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

onUnmounted(() => {
  clearTimers()
  resizeObserver?.disconnect()
  worker?.terminate()
  worker = null
})
</script>

<template>
  <div class="app">
    <Transition name="cover">
      <div v-if="!started" class="cover">
        <img class="cover__art" src="/assets/xiangqi/landscape.svg" alt="" draggable="false" />
        <div class="cover__wash" aria-hidden="true"></div>
        <div class="cover__content">
          <h1 class="cover__title">楚河棋局</h1>
          <button class="cover__start" type="button" @click="onStart">开始对弈</button>
        </div>
      </div>
    </Transition>

    <Transition name="board" @enter="onBoardEnter" @after-enter="onBoardEntered">
      <div v-if="started" class="game">
        <header class="header">
          <h1 class="title">楚河棋局</h1>
          <div class="status" :class="`status--${status}`">{{ turnText }}</div>
          <div class="controls">
            <label class="field">
              电脑：
              <select v-model="aiLevel" :disabled="phase !== 'idle' || !gameReady">
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
              <div v-if="lastMove" class="mark mark--from" :style="markerStyle(lastMove.from, PIECE_D + 6)"></div>
              <div v-if="lastMove" class="mark mark--to" :style="markerStyle(lastMove.to, PIECE_D + 10)"></div>

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
                v-for="pv in pieceViews"
                :key="`${boardGen}-${pv.id}`"
                :ref="(el) => setPieceEl(pv.id, el)"
                class="piece"
                :class="pieceClass(pv.piece)"
                :style="pieceStyle(pv.row, pv.col)"
                @click="onSquareClick(pv.row, pv.col)"
              >
                <div class="piece__inner">
                  <span class="piece__char">{{ pieceChar(pv.piece) }}</span>
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.app {
  min-height: 100vh;
  background: #f7f1e6;
}

.game {
  max-width: 720px;
  margin: 0 auto;
  padding: 16px;
}

/* 封面 */
.cover {
  position: fixed;
  inset: 0;
  background: #f7f1e6;
  overflow: hidden;
  display: flex;
  align-items: center;
  padding-left: clamp(40px, 12vw, 160px);
}

.cover__art {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  pointer-events: none;
  transition: opacity 450ms ease, filter 450ms ease;
}

.cover__wash {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(120% 90% at 85% 100%, rgba(120, 110, 95, 0.16), rgba(120, 110, 95, 0) 60%),
    linear-gradient(to top, rgba(255, 255, 255, 0.35), rgba(255, 255, 255, 0) 55%);
  pointer-events: none;
  transition: opacity 450ms ease;
}

.cover__content {
  position: relative;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 36px;
}

.cover__title {
  font-family: 'Noto Serif SC', 'SimSun', serif;
  font-size: clamp(44px, 8vw, 76px);
  font-weight: 700;
  letter-spacing: 10px;
  line-height: 1.1;
  color: #2c2c2c;
}

.cover__start {
  font-family: 'Noto Serif SC', 'SimSun', serif;
  font-size: 18px;
  letter-spacing: 6px;
  color: #fff;
  background: #a93226;
  border: 2px solid #8f2a1f;
  border-radius: 6px;
  padding: 16px 42px;
  cursor: pointer;
  box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.22);
  transition: transform 120ms ease, opacity 150ms ease, background 120ms ease;
}

.cover__start:hover {
  background: #b23a2b;
}

.cover__start:active {
  transform: translateY(2px) scale(0.98);
}

.cover__start:focus-visible {
  outline: 3px solid #8f2a1f;
  outline-offset: 3px;
}

/* 封面 → 对局 转场 */
.cover-leave-active {
  transition: opacity 450ms ease;
}

.cover-leave-to {
  opacity: 0;
}

.cover-leave-active .cover__art {
  opacity: 0.25;
  filter: blur(10px);
}

.cover-leave-active .cover__wash {
  opacity: 0;
}

.board-enter-active {
  transition: opacity 450ms ease 150ms, transform 450ms ease 150ms;
}

.board-enter-from {
  opacity: 0;
  transform: translateY(8px);
}

@media (max-width: 560px) {
  .cover {
    padding-left: 0;
    justify-content: center;
  }

  .cover__content {
    align-items: center;
    text-align: center;
  }
}

@media (prefers-reduced-motion: reduce) {
  .cover-leave-active {
    transition: opacity 120ms ease;
  }

  .cover-leave-active .cover__art {
    opacity: 0.25;
    filter: none;
    transition: opacity 120ms ease;
  }

  .cover-leave-active .cover__wash {
    transition: opacity 120ms ease;
  }

  .board-enter-active {
    transition: opacity 120ms ease;
  }

  .board-enter-from {
    transform: none;
  }

  .cover__start {
    transition: none;
  }
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
  pointer-events: none;
}

.mark--from {
  background: rgba(230, 126, 34, 0.18);
  z-index: 1;
}

.mark--to {
  border: 3px solid #e65100;
  box-sizing: border-box;
  z-index: 3;
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
</style>
