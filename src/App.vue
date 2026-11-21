<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import {
  applyMove,
  generateLegalMoves,
  getGameStatus,
  initialPosition,
  opposite,
  PIECE_CHARS,
} from './chess'
import type { Board, Color, GameStatus, Move, Piece, Position, Square } from './chess'
import { AI_LEVELS, type AiLevel } from './ai/levels'
import { OnlineClient } from './online'
import type { PeersInfo, ServerMoveEvent, ServerState } from './online'

type SideChoice = 'red' | 'black' | 'random'
type Phase = 'idle' | 'player-anim' | 'thinking' | 'computer-anim'

interface PieceView {
  id: number
  piece: Piece
  row: number
  col: number
}

// 棋盘坐标系常量（与 board.svg 的 viewBox 0 0 600 660 一致）
const BOARD_W = 600
const BOARD_H = 660
const ORIGIN = 60
const CELL = 60
const PIECE_D = 54 // 棋子直径
const FONT_SIZE = 28

const ANIM_MS = 500 // 落子动画时长

// 封面：执色与难度选项（对局开始前选择）
const SIDE_OPTIONS: { value: SideChoice; label: string }[] = [
  { value: 'red', label: '执红' },
  { value: 'black', label: '执黑' },
  { value: 'random', label: '随机' },
]

const AI_LEVEL_OPTIONS: { value: AiLevel; label: string; desc: string }[] = [
  { value: 'beginner', label: '入门', desc: '随机落子，轻松上手' },
  { value: 'normal', label: '普通', desc: '基础算路，稳扎稳打' },
  { value: 'hard', label: '困难', desc: '深谋远虑，步步紧逼' },
  { value: 'expert', label: '专家', desc: '极限算力，巅峰对决' },
]

// 选边与难度
const sideChoice = ref<SideChoice>('red') // 新局选边：执红 / 执黑 / 随机，默认执红
const aiLevel = ref<AiLevel>('normal') // 难度四档，默认普通
const mode = ref<'ai' | 'online'>('ai') // 对弈模式：人机 / 联机
const playerColor = ref<Color>('red') // 本局玩家实际执色
const computerColor = computed<Color>(() => opposite(playerColor.value))
const flipped = computed(() => playerColor.value === 'black') // 执黑时棋盘 180° 翻转，己方在下

const board = ref(initialPosition().board)
const sideToMove = ref<Color>('red')
const selected = ref<Square | null>(null)
const status = ref<GameStatus>('playing')
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

// —— 联机状态（服务端为权威，本地棋盘在服务端确认后更新）——
const roomCode = ref('') // 本局房间码（用于邀请对手）
const seatColor = ref<Color | null>(null) // 本座位执色（服务端分配）
const opponentJoined = ref(false) // 对手是否已入座
const opponentConnected = ref(false) // 对手是否在线
const host = ref(false) // 本座位是否为房主（仅房主可重新开始）
const serverVersion = ref(0) // 服务端棋局版本号（每步递增）
const moveInFlight = ref(false) // 走子已发出、等待服务端确认
const connectionState = ref<'connecting' | 'connected' | 'disconnected'>('disconnected')
const onlineBusy = ref(false) // 创建/加入进行中，防止重复提交
const onlineError = ref('') // 联机错误提示（封面与对局共用）
const joinCodeInput = ref('')
let online: OnlineClient | null = null
let moveSeq = 0

const boardEl = ref<HTMLElement | null>(null)
const boardWrapEl = ref<HTMLElement | null>(null)
const scale = ref(1)

// —— 封面鼠标视差：把归一化坐标写入 CSS 变量，各图层按不同系数平移 ——
const coverEl = ref<HTMLElement | null>(null)
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
const coarsePointer = window.matchMedia('(pointer: coarse)').matches
let parallaxX = 0
let parallaxY = 0
let parallaxRaf = 0

function onCoverPointerMove(e: MouseEvent): void {
  if (reduceMotion || coarsePointer) return
  parallaxX = (e.clientX / window.innerWidth) * 2 - 1
  parallaxY = (e.clientY / window.innerHeight) * 2 - 1
  if (!parallaxRaf) parallaxRaf = window.requestAnimationFrame(applyParallax)
}

function onCoverPointerLeave(): void {
  parallaxX = 0
  parallaxY = 0
  if (!parallaxRaf) parallaxRaf = window.requestAnimationFrame(applyParallax)
}

function applyParallax(): void {
  parallaxRaf = 0
  const el = coverEl.value
  if (!el) return
  el.style.setProperty('--px', parallaxX.toFixed(3))
  el.style.setProperty('--py', parallaxY.toFixed(3))
}

const pieceViews = ref<PieceView[]>(buildPieceViews(board.value))
const pieceEls = new Map<number, HTMLElement>()

// 计时器集合，重开/离开对局时统一清理
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
  if (mode.value === 'online') {
    const label = seatColor.value === 'red' ? '红方' : '黑方'
    if (status.value === 'redWon') return seatColor.value === 'red' ? '红方胜 · 你赢了' : '红方胜 · 你输了'
    if (status.value === 'blackWon') return seatColor.value === 'black' ? '黑方胜 · 你赢了' : '黑方胜 · 你输了'
    if (connectionState.value === 'disconnected') return '连接已断开，正在重连…'
    if (!opponentJoined.value) return '等待对手加入…'
    if (!opponentConnected.value) return '对手已断线，等待重连…'
    if (moveInFlight.value) return '走子确认中…'
    if (sideToMove.value === seatColor.value) return `你的回合（${label}）`
    return '对手走子中…'
  }

  const playerLabel = playerColor.value === 'red' ? '红方' : '黑方'
  const computerLabel = computerColor.value === 'red' ? '红方' : '黑方'
  if (status.value === 'redWon') {
    return playerColor.value === 'red' ? '红方胜 · 你赢了' : '红方胜 · 电脑赢了'
  }
  if (status.value === 'blackWon') {
    return playerColor.value === 'black' ? '黑方胜 · 你赢了' : '黑方胜 · 电脑赢了'
  }
  if (phase.value === 'thinking') return '电脑思考中…'
  if (phase.value === 'computer-anim') return `电脑回合（${computerLabel}）`
  return `你的回合（${playerLabel}）`
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
  return (
    phase.value === 'idle' &&
    status.value === 'playing' &&
    gameReady.value &&
    sideToMove.value === playerColor.value &&
    !moveInFlight.value &&
    (mode.value !== 'online' || connectionState.value === 'connected')
  )
}

function isLegalTarget(row: number, col: number): boolean {
  return legalTargets.value.some((s) => s.row === row && s.col === col)
}

// 点击棋盘：参数一律为原始棋盘坐标，界面坐标映射只发生在渲染层
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
      if (move) applyPlayerMove(move)
      return
    }
    if (piece && piece.color === playerColor.value) {
      selected.value = { row, col }
      return
    }
    selected.value = null
    return
  }

  if (piece && piece.color === playerColor.value) {
    selected.value = { row, col }
  }
}

function applyPlayerMove(move: Move): void {
  selected.value = null
  if (mode.value === 'online') {
    // 联机：发服务端校验，收到 moved 广播后才更新棋盘
    moveInFlight.value = true
    online?.sendMove(move, nextMoveId())
    return
  }
  phase.value = 'player-anim'
  // 先更新棋盘（同步），再启动电脑计算，使 Worker 在玩家动画期间并行计算
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
  thinkDeadline = performance.now() + AI_LEVELS[aiLevel.value].minThinkMs
  if (pendingComputerMove.value !== null) scheduleApplyWhenReady()
}

/** 电脑回合开始（玩家执黑时，棋盘就绪后电脑执红先走） */
function beginComputerTurn(): void {
  if (status.value !== 'playing') return
  if (sideToMove.value !== computerColor.value) return
  if (phase.value !== 'idle' || !gameReady.value) return
  phase.value = 'thinking'
  thinkDeadline = performance.now() + AI_LEVELS[aiLevel.value].minThinkMs
  startComputerThinking()
}

function startComputerThinking(): void {
  const id = ++gameId.value
  const level = AI_LEVELS[aiLevel.value]
  const position: Position = JSON.parse(JSON.stringify(currentPosition.value)) as Position

  if (level.mode === 'random') {
    // 入门档：随机合法走法，立即应招
    pendingComputerMove.value = pickRandomLegal(position)
    onComputerResultReady()
    return
  }

  const w = getWorker()
  w.postMessage({
    gameId: id,
    position,
    maxDepth: level.maxDepth,
    timeBudgetMs: level.timeBudgetMs,
  })

  // 兜底：预算用完再加余量后仍无结果（Worker 挂起），用经过校验的合法走法
  later(() => {
    if (id !== gameId.value) return
    if (pendingComputerMove.value !== null) return
    if (phase.value !== 'thinking' && phase.value !== 'player-anim') return
    pendingComputerMove.value = pickRandomLegal(currentPosition.value)
    onComputerResultReady()
  }, level.timeBudgetMs + 1500)
}

function pickRandomLegal(position: Position): Move | null {
  const moves = generateLegalMoves(position)
  return moves.length ? moves[Math.floor(Math.random() * moves.length)] : null
}

/** 校验 Worker 返回的走法在当前局面合法，异常时用合法走法兜底 */
function validateWorkerMove(move: Move | null): Move | null {
  if (!move) return pickRandomLegal(currentPosition.value)
  const legal = generateLegalMoves(currentPosition.value)
  const ok = legal.some(
    (m) =>
      m.from.row === move.from.row &&
      m.from.col === move.from.col &&
      m.to.row === move.to.row &&
      m.to.col === move.to.col,
  )
  return ok ? move : pickRandomLegal(currentPosition.value)
}

function onComputerResultReady(): void {
  if (phase.value === 'player-anim') return // 等玩家动画结束
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
  if (status.value === 'playing' && sideToMove.value === computerColor.value) {
    beginComputerTurn() // 保险：正常流程不会走到
  }
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
    const f = viewSquare(from)
    const t = viewSquare(to)
    el.animate(
      [
        { left: px(ORIGIN + CELL * f.col), top: px(ORIGIN + CELL * f.row) },
        { left: px(ORIGIN + CELL * t.col), top: px(ORIGIN + CELL * t.row) },
      ],
      { duration: ANIM_MS, easing: 'ease', fill: 'forwards' },
    )
  }
}

// —— 联机对弈：创建/加入房间与服务端消息处理（服务端确认后才更新棋盘）——

function nextMoveId(): string {
  moveSeq += 1
  return `${Date.now().toString(36)}-${moveSeq}-${Math.random().toString(36).slice(2, 8)}`
}

function getOnline(): OnlineClient {
  if (!online) {
    online = new OnlineClient({
      onOpen: () => {
        connectionState.value = 'connected'
      },
      onClose: () => {
        connectionState.value = 'disconnected'
      },
      onCreated: (code, color, token) => {
        online?.setSession(code, token, color)
        seatColor.value = color
        playerColor.value = color
        host.value = true
        onlineBusy.value = false
        started.value = true
      },
      onJoined: (code, color, token) => {
        online?.setSession(code, token, color)
        seatColor.value = color
        playerColor.value = color
        host.value = false
        onlineBusy.value = false
        started.value = true
      },
      onState: onServerState,
      onMoved: onServerMoved,
      onRestarted: onServerRestarted,
      onPeers: (peers) => applyPeers(peers),
      onOpponentLeft: (color) => {
        if (color !== seatColor.value) {
          opponentJoined.value = false
          opponentConnected.value = false
        }
      },
      onError: (message) => {
        onlineError.value = message
        onlineBusy.value = false
        moveInFlight.value = false
        // 刷新后自动重连失败（房间已解散 / 凭证失效）：退回封面提示
        if (started.value && !roomCode.value) {
          online?.clearSession()
          started.value = false
          gameReady.value = false
        }
      },
    })
  }
  return online
}

function onCreateRoom(): void {
  if (onlineBusy.value) return
  onlineBusy.value = true
  onlineError.value = ''
  connectionState.value = 'connecting'
  rollAndReset() // 先摆好初始局面，座位与执色以服务端为准
  getOnline().create(sideChoice.value)
}

function onJoinRoom(): void {
  if (onlineBusy.value) return
  const code = joinCodeInput.value.trim().toUpperCase()
  if (code.length !== 6) {
    onlineError.value = '请输入 6 位房间码'
    return
  }
  onlineBusy.value = true
  onlineError.value = ''
  connectionState.value = 'connecting'
  rollAndReset()
  getOnline().join(code)
}

function onModeSwitch(next: 'ai' | 'online'): void {
  if (next === mode.value) return
  mode.value = next
  onlineError.value = ''
}

/** 服务端全量状态（入座 / 重连同步）：重建本地棋盘 */
function onServerState(state: ServerState): void {
  connectionState.value = 'connected'
  serverVersion.value = state.version
  roomCode.value = state.code
  seatColor.value = state.color
  playerColor.value = state.color
  host.value = state.host
  status.value = state.status
  board.value = state.position.board
  sideToMove.value = state.position.sideToMove
  selected.value = null
  lastMove.value = null
  phase.value = 'idle'
  moveInFlight.value = false
  pendingComputerMove.value = null
  pieceViews.value = buildPieceViews(state.position.board)
  boardGen.value++ // 重建棋子 DOM，清除残留动画
  applyPeers(state.peers)
}

/** 服务端确认后的走子广播：双方同源更新棋盘与动画 */
function onServerMoved(ev: ServerMoveEvent): void {
  serverVersion.value = ev.version
  if (ev.by === seatColor.value) moveInFlight.value = false
  selected.value = null
  phase.value = ev.by === seatColor.value ? 'player-anim' : 'computer-anim'
  animateMove(ev.move, () => {
    status.value = ev.status
    phase.value = 'idle'
  })
}

/** 房主重新开始（服务端广播）：双方重置为初始局面 */
function onServerRestarted(position: Position, version: number, st: GameStatus): void {
  serverVersion.value = version
  boardGen.value++
  clearTimers()
  pendingComputerMove.value = null
  board.value = position.board
  sideToMove.value = position.sideToMove
  status.value = st
  selected.value = null
  lastMove.value = null
  phase.value = 'idle'
  moveInFlight.value = false
  pieceViews.value = buildPieceViews(position.board)
}

function applyPeers(peers: PeersInfo): void {
  if (!seatColor.value) return
  const opp = opposite(seatColor.value)
  opponentJoined.value = opp === 'red' ? peers.red : peers.black
  opponentConnected.value = opp === 'red' ? peers.redConnected : peers.blackConnected
}

function onRestartClick(): void {
  if (mode.value === 'online') {
    if (!host.value) return // 仅房主可重新开始
    online?.sendRestart()
    return
  }
  restart()
}

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./ai/worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent) => {
      const { gameId: id, result, error } = event.data as {
        gameId: number
        result?: { move: Move | null }
        error?: string
      }
      if (id !== gameId.value) return // 忽略上一局尚未返回的结果
      if (error || !result) {
        console.error('[AI Worker] 搜索出错：', error ?? '无结果')
        pendingComputerMove.value = pickRandomLegal(currentPosition.value)
      } else {
        pendingComputerMove.value = validateWorkerMove(result.move)
      }
      onComputerResultReady()
    }
    worker.onerror = (e) => {
      console.error('[AI Worker] 加载或运行错误：', e.message)
    }
  }
  return worker
}

// 按选边抽签并重置为初始局面（重开沿用本局选边与难度；随机选边则重新抽签）
function rollAndReset(): void {
  if (sideChoice.value === 'random') {
    playerColor.value = Math.random() < 0.5 ? 'red' : 'black'
  } else {
    playerColor.value = sideChoice.value
  }

  gameId.value++ // 使尚未返回的计算结果失效
  boardGen.value++ // 重建棋子 DOM，清除残留的落子动画
  clearTimers() // 清理旧动画/计时的回调
  pendingComputerMove.value = null

  const p = initialPosition()
  board.value = p.board
  sideToMove.value = 'red' // 红方始终先走
  status.value = 'playing'
  selected.value = null
  lastMove.value = null
  phase.value = 'idle'
  pieceViews.value = buildPieceViews(p.board)
}

function restart(): void {
  rollAndReset()
  if (playerColor.value === 'black') beginComputerTurn() // 玩家执黑：电脑执红先走
}

function onSideChoiceChange(): void {
  restart() // 换边视为新局；随机选边重新抽签
}

function onStart(): void {
  if (started.value) return // 转场期间只接受一次开始操作
  rollAndReset()
  started.value = true
}

function exitToCover(): void {
  // 离开对局：清理旧局计时器和搜索任务（DOM 卸载时还会终止 Worker）
  gameId.value++
  clearTimers()
  pendingComputerMove.value = null
  selected.value = null
  gameReady.value = false
  started.value = false
  if (mode.value === 'online' && online) {
    // 离开房间：通知服务端释放座位、断开连接并清除本地会话
    online.leave()
    seatColor.value = null
    roomCode.value = ''
    opponentJoined.value = false
    opponentConnected.value = false
    moveInFlight.value = false
    onlineBusy.value = false
    onlineError.value = ''
    connectionState.value = 'disconnected'
  }
}

function onBoardEnter(): void {
  // 棋盘进入 DOM 时初始化缩放与尺寸观察器，确保淡入前棋子已对齐
  updateScale()
  if (!resizeObserver) resizeObserver = new ResizeObserver(updateScale)
  if (boardWrapEl.value) resizeObserver.observe(boardWrapEl.value)
}

function onBoardEntered(): void {
  gameReady.value = true
  // 玩家执黑：电脑自动执红走第一步（仅人机模式）
  if (mode.value !== 'online' && playerColor.value === 'black') beginComputerTurn()
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

// —— 坐标与样式：棋规与消息统一使用原始棋盘坐标，仅在界面层映射显示位置 ——

/** 原始棋盘坐标 → 界面显示坐标（执黑时 180° 翻转，己方在下、文字保持正向） */
function viewSquare(s: Square): Square {
  if (!flipped.value) return s
  return { row: 9 - s.row, col: 8 - s.col }
}

// 棋盘缩放：以容器宽度映射到 600 坐标系
function px(v: number): string {
  return `${(v * scale.value).toFixed(2)}px`
}

function centerStyle(row: number, col: number) {
  const v = viewSquare({ row, col })
  return {
    left: px(ORIGIN + CELL * v.col),
    top: px(ORIGIN + CELL * v.row),
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
  // 棋盘在容器（宽度上限 600、高度上限 660）内取最大的等比尺寸，
  // 保证任何窗口高度下对弈界面单页完整可见、无需滚动（Edge 等浏览器一致）
  const wrap = boardWrapEl.value
  const el = boardEl.value
  if (!wrap || !el) return
  const availW = wrap.clientWidth
  const availH = wrap.clientHeight
  if (availW <= 0 || availH <= 0) return
  const size = Math.min(availW, (availH * BOARD_W) / BOARD_H)
  el.style.width = `${size.toFixed(2)}px`
  el.style.height = `${((size * BOARD_H) / BOARD_W).toFixed(2)}px`
  scale.value = size / BOARD_W
}

// 刷新后自动重连：凭上次会话（房间码 + 座位凭证）恢复座位
const savedSession = OnlineClient.savedSession()
if (savedSession) {
  mode.value = 'online'
  seatColor.value = savedSession.color ?? null
  if (savedSession.color) playerColor.value = savedSession.color
  started.value = true
  connectionState.value = 'connecting'
  const client = getOnline()
  client.setSession(savedSession.code, savedSession.token, savedSession.color)
  client.join(savedSession.code, savedSession.token)
}

onUnmounted(() => {
  clearTimers()
  if (parallaxRaf) window.cancelAnimationFrame(parallaxRaf)
  resizeObserver?.disconnect()
  worker?.terminate()
  worker = null
  online?.close()
})
</script>

<template>
  <div class="app">
    <Transition name="cover">
      <div
        v-if="!started"
        ref="coverEl"
        class="cover"
        @mousemove="onCoverPointerMove"
        @mouseleave="onCoverPointerLeave"
      >
        <div class="cover__bg" aria-hidden="true">
          <img class="cover__art" src="/assets/xiangqi/cover.png" alt="" draggable="false" />
        </div>
        <div class="cover__wash" aria-hidden="true"></div>

        <div class="cover__clouds" aria-hidden="true">
          <svg viewBox="0 0 1200 700" preserveAspectRatio="xMidYMid slice">
            <defs>
              <path id="spiral" d="M0.0 -58.0 L6.2 -57.1 L12.2 -55.5 L17.9 -53.3 L23.3 -50.5 L28.4 -47.2 L32.9 -43.4 L37.0 -39.1 L40.6 -34.5 L43.6 -29.6 L46.0 -24.5 L47.8 -19.1 L49.1 -13.7 L49.7 -8.2 L49.7 -2.8 L49.1 2.6 L48.0 7.8 L46.3 12.7 L44.1 17.4 L41.4 21.8 L38.3 25.8 L34.9 29.5 L31.1 32.6 L27.0 35.3 L22.7 37.5 L18.3 39.2 L13.8 40.4 L9.2 41.1 L4.6 41.3 L0.1 40.9 L-4.2 40.1 L-8.4 38.8 L-12.4 37.2 L-16.1 35.1 L-19.4 32.6 L-22.5 29.9 L-25.2 26.8 L-27.5 23.6 L-29.4 20.1 L-30.9 16.6 L-31.9 12.9 L-32.6 9.2 L-32.8 5.5 L-32.6 1.9 L-32.1 -1.6 L-31.1 -4.9 L-29.8 -8.1 L-28.2 -11.1 L-26.3 -13.8 L-24.2 -16.2 L-21.9 -18.4 L-19.4 -20.2 L-16.7 -21.7 L-14.0 -22.9 L-11.2 -23.7 L-8.3 -24.2 L-5.5 -24.4 L-2.8 -24.3 L-0.2 -23.8 L2.4 -23.1 L4.7 -22.2 L6.9 -21.0 L8.9 -19.6 L10.6 -18.0 L12.2 -16.3 L13.5 -14.4 L14.5 -12.5 L15.3 -10.5 L15.8 -8.5 L16.1 -6.6 L16.1 -4.6 L16.0 -2.8 L15.6 -1.0 L15.0 0.7 L14.3 2.2 L13.4 3.6 L12.3 4.8 L11.2 5.8 L10.1 6.7 L8.8 7.3 L7.6 7.8 L6.3 8.1 L5.1 8.3 L3.9 8.2 L2.8 8.1 L1.8 7.7 L0.9 7.3 L0.1 6.8 L-0.6 6.1 L-1.1 5.5 L-1.5 4.8" />
              <g id="cloud" fill="none" stroke="#fffdf6" stroke-width="12" stroke-linecap="round">
                <use href="#spiral" />
                <use href="#spiral" transform="translate(46,-20) scale(0.5)" />
                <use href="#spiral" transform="translate(-44,14) scale(0.66)" />
              </g>
            </defs>
            <g class="cloud" style="--cx: -90px; --cy: -70px; animation-delay: 0s"><use href="#cloud" transform="translate(70,130) scale(2.3)" /></g>
            <g class="cloud" style="--cx: 70px; --cy: -60px; animation-delay: .06s"><use href="#cloud" transform="translate(470,50) scale(1.9)" /></g>
            <g class="cloud" style="--cx: 90px; --cy: 40px; animation-delay: .12s"><use href="#cloud" transform="translate(900,110) scale(2.1)" /></g>
            <g class="cloud" style="--cx: -60px; --cy: 50px; animation-delay: .18s"><use href="#cloud" transform="translate(140,420) scale(1.7)" /></g>
            <g class="cloud" style="--cx: -40px; --cy: -40px; animation-delay: .24s"><use href="#cloud" transform="translate(600,340) scale(2)" /></g>
            <g class="cloud" style="--cx: 70px; --cy: 50px; animation-delay: .3s"><use href="#cloud" transform="translate(1010,340) scale(1.8)" /></g>
            <g class="cloud" style="--cx: -80px; --cy: 60px; animation-delay: .14s"><use href="#cloud" transform="translate(40,640) scale(2)" /></g>
            <g class="cloud" style="--cx: 40px; --cy: 70px; animation-delay: .2s"><use href="#cloud" transform="translate(420,660) scale(1.6)" /></g>
            <g class="cloud" style="--cx: 90px; --cy: 80px; animation-delay: .26s"><use href="#cloud" transform="translate(740,640) scale(2.3)" /></g>
            <g class="cloud" style="--cx: 80px; --cy: 60px; animation-delay: .1s"><use href="#cloud" transform="translate(1100,600) scale(1.7)" /></g>
          </svg>
        </div>
        <div class="cover__veil" aria-hidden="true"></div>

        <div class="cover__content">
          <h1 class="cover__title">楚河棋局</h1>
          <p class="cover__subtitle">楚河汉界 · 以棋会友</p>

          <div class="cover__modes" role="tablist" aria-label="对弈模式">
            <button
              type="button"
              :class="{ active: mode === 'ai' }"
              @click="onModeSwitch('ai')"
            >人机对弈</button>
            <button
              type="button"
              :class="{ active: mode === 'online' }"
              @click="onModeSwitch('online')"
            >联机对弈</button>
          </div>

          <template v-if="mode === 'ai'">
            <section class="cover__settings" aria-label="对局设置">
              <div class="cover__setting">
                <span class="cover__setting-label">执色</span>
                <div class="cover__seg" role="group" aria-label="执色">
                  <button
                    v-for="o in SIDE_OPTIONS"
                    :key="o.value"
                    type="button"
                    :class="{ active: sideChoice === o.value }"
                    @click="sideChoice = o.value"
                  >{{ o.label }}</button>
                </div>
              </div>
              <div class="cover__setting">
                <span class="cover__setting-label">难度</span>
                <div class="cover__levels" role="radiogroup" aria-label="电脑难度">
                  <button
                    v-for="o in AI_LEVEL_OPTIONS"
                    :key="o.value"
                    type="button"
                    class="cover__level"
                    :class="{ active: aiLevel === o.value }"
                    :aria-checked="aiLevel === o.value"
                    role="radio"
                    @click="aiLevel = o.value"
                  >
                    <span class="cover__level-name">{{ o.label }}</span>
                    <span class="cover__level-desc">{{ o.desc }}</span>
                  </button>
                </div>
              </div>
            </section>
            <button class="cover__start" type="button" @click="onStart">开始对弈</button>
          </template>

          <div v-else class="cover__online">
            <div class="cover__panel">
              <h2 class="cover__panel-title">创建房间</h2>
              <label class="cover__field">
                执色
                <select v-model="sideChoice">
                  <option value="red">执红</option>
                  <option value="black">执黑</option>
                  <option value="random">随机</option>
                </select>
              </label>
              <button class="cover__start cover__start--sm" type="button" :disabled="onlineBusy" @click="onCreateRoom">
                {{ onlineBusy ? '创建中…' : '创建房间' }}
              </button>
            </div>
            <div class="cover__panel">
              <h2 class="cover__panel-title">加入房间</h2>
              <input
                v-model="joinCodeInput"
                class="cover__code"
                type="text"
                maxlength="6"
                placeholder="输入 6 位房间码"
                aria-label="房间码"
              />
              <button class="cover__start cover__start--sm" type="button" :disabled="onlineBusy" @click="onJoinRoom">
                {{ onlineBusy ? '加入中…' : '加入房间' }}
              </button>
            </div>
            <p v-if="onlineError" class="cover__error" role="alert">{{ onlineError }}</p>
            <p class="cover__hint">联机对弈需要先启动服务端（npm run server）；人机模式断网可用</p>
          </div>
        </div>
      </div>
    </Transition>

    <Transition name="board" @enter="onBoardEnter" @after-enter="onBoardEntered">
      <div v-if="started" class="game">
        <header class="header">
          <h1 class="title">楚河棋局</h1>
          <div class="status" :class="`status--${status}`">{{ turnText }}</div>

          <div v-if="mode === 'ai'" class="controls">
            <label class="field">
              执色
              <select v-model="sideChoice" @change="onSideChoiceChange">
                <option value="red">执红</option>
                <option value="black">执黑</option>
                <option value="random">随机</option>
              </select>
            </label>
            <label class="field">
              难度
              <select v-model="aiLevel" :disabled="!gameReady">
                <option value="beginner">入门</option>
                <option value="normal">普通</option>
                <option value="hard">困难</option>
                <option value="expert">专家</option>
              </select>
            </label>
            <button class="btn" @click="muted = !muted">{{ muted ? '开启声音' : '静音' }}</button>
            <button class="btn" @click="onRestartClick">重新开始</button>
            <button class="btn" @click="exitToCover">返回封面</button>
          </div>

          <div v-else class="controls">
            <span class="room-code" :title="`把房间码发给对手，对手输入后即可入座`">房间码 {{ roomCode }}</span>
            <button class="btn" @click="muted = !muted">{{ muted ? '开启声音' : '静音' }}</button>
            <button class="btn" :disabled="!host" :title="host ? '' : '仅房主可重新开始'" @click="onRestartClick">重新开始</button>
            <button class="btn" @click="exitToCover">离开房间</button>
          </div>
        </header>

        <main ref="boardWrapEl" class="board-wrap">
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
  padding: 12px 16px 16px;
  height: 100vh;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}

/* 封面 */
.cover {
  position: fixed;
  inset: 0;
  background: #f5cf94;
  overflow: hidden;
  display: flex;
  align-items: center;
  padding-left: clamp(40px, 12vw, 160px);
}

.cover__bg {
  position: absolute;
  inset: -24px;
  pointer-events: none;
  transform: translate(calc(var(--px, 0) * -12px), calc(var(--py, 0) * -8px));
  will-change: transform;
}

.cover__art {
  width: 100%;
  height: 100%;
  object-fit: cover;
  pointer-events: none;
  transition: opacity 450ms ease, filter 450ms ease;
  animation: cover-bg-in 1.3s cubic-bezier(0.25, 0.6, 0.3, 1) 0.15s both;
}

.cover__wash {
  position: absolute;
  inset: 0;
  background:
    linear-gradient(90deg, rgba(250, 236, 205, 0.9) 0%, rgba(250, 236, 205, 0.6) 34%, rgba(250, 236, 205, 0) 62%),
    radial-gradient(120% 90% at 85% 100%, rgba(120, 110, 95, 0.14), rgba(120, 110, 95, 0) 60%),
    linear-gradient(to top, rgba(255, 255, 255, 0.3), rgba(255, 255, 255, 0) 55%);
  pointer-events: none;
  transition: opacity 450ms ease;
}

/* 祥云层：开局笼罩全屏，1s 内散开淡出 */
.cover__clouds {
  position: absolute;
  inset: -30px;
  z-index: 1;
  pointer-events: none;
  transform: translate(calc(var(--px, 0) * -20px), calc(var(--py, 0) * -14px));
}

.cover__clouds svg {
  width: 100%;
  height: 100%;
  display: block;
}

.cover__clouds .cloud {
  opacity: 1;
  transform-box: fill-box;
  transform-origin: 50% 50%;
  animation: cloud-out 1.05s cubic-bezier(0.35, 0.45, 0.45, 1) both;
}

@keyframes cloud-out {
  0% {
    opacity: 1;
    transform: translate(0, 0) scale(1);
  }
  100% {
    opacity: 0;
    transform: translate(var(--cx, 60px), var(--cy, -40px)) scale(1.45);
  }
}

/* 白雾幕：与祥云一起退去，露出背景 */
.cover__veil {
  position: absolute;
  inset: 0;
  z-index: 2;
  background:
    radial-gradient(60% 55% at 32% 18%, rgba(255, 252, 244, 0.95), rgba(255, 252, 244, 0.62) 62%, rgba(255, 252, 244, 0.25) 100%),
    linear-gradient(180deg, #fffaf0, #f9eed7);
  pointer-events: none;
  animation: veil-out 1.05s ease-out 0.12s both;
}

@keyframes veil-out {
  from {
    opacity: 1;
  }
  to {
    opacity: 0;
  }
}

@keyframes cover-bg-in {
  from {
    opacity: 0;
    transform: scale(1.06);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

.cover__content {
  position: relative;
  z-index: 3;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 24px;
  transform: translate(calc(var(--px, 0) * 10px), calc(var(--py, 0) * 7px));
  will-change: transform;
}

/* UI 与文字在祥云散去后逐项浮现 */
.cover__content > * {
  opacity: 0;
  animation: cover-rise 0.65s cubic-bezier(0.21, 0.65, 0.32, 1) both;
}

.cover__content > :nth-child(1) { animation-delay: 0.55s; }
.cover__content > :nth-child(2) { animation-delay: 0.67s; }
.cover__content > :nth-child(3) { animation-delay: 0.79s; }
.cover__content > :nth-child(4) { animation-delay: 0.91s; }
.cover__content > :nth-child(5) { animation-delay: 1.03s; }

@keyframes cover-rise {
  from {
    opacity: 0;
    transform: translateY(24px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.cover__title {
  font-size: clamp(44px, 8vw, 76px);
  font-weight: 700;
  letter-spacing: 10px;
  line-height: 1.1;
  color: #2c2c2c;
}

.cover__subtitle {
  font-size: 15px;
  letter-spacing: 6px;
  color: #6b5a3e;
  margin: 0;
}

.cover__settings {
  display: flex;
  flex-direction: column;
  gap: 14px;
  align-items: stretch;
}

.cover__setting {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}

.cover__setting-label {
  font-size: 13px;
  letter-spacing: 4px;
  color: #6b5a3e;
}

.cover__seg {
  display: flex;
  gap: 8px;
}

.cover__seg button {
  font-size: 14px;
  letter-spacing: 2px;
  padding: 7px 20px;
  background: rgba(255, 255, 255, 0.5);
  border: 1px solid #b8a888;
  border-radius: 999px;
  color: #3d362c;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}

.cover__seg button:hover {
  background: rgba(255, 255, 255, 0.75);
}

.cover__seg button.active {
  background: #a93226;
  border-color: #8f2a1f;
  color: #fff;
}

.cover__seg button:focus-visible {
  outline: 2px solid #8f2a1f;
  outline-offset: 2px;
}

.cover__levels {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.cover__level {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  min-width: 108px;
  padding: 10px 16px;
  background: rgba(255, 255, 255, 0.5);
  border: 1px solid #b8a888;
  border-radius: 8px;
  color: #3d362c;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease, transform 120ms ease;
}

.cover__level:hover {
  background: rgba(255, 255, 255, 0.75);
  transform: translateY(-2px);
}

.cover__level.active {
  background: #a93226;
  border-color: #8f2a1f;
  color: #fff;
}

.cover__level:focus-visible {
  outline: 2px solid #8f2a1f;
  outline-offset: 2px;
}

.cover__level-name {
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 3px;
}

.cover__level-desc {
  font-size: 11px;
  letter-spacing: 1px;
  opacity: 0.78;
}

.cover__field {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  letter-spacing: 2px;
  color: #4a443c;
}

.cover__field select {
  font-size: 14px;
  letter-spacing: 1px;
  padding: 6px 10px;
  background: rgba(255, 255, 255, 0.55);
  border: 1px solid #b8a888;
  border-radius: 4px;
  color: #3d362c;
}

.cover__field select:focus-visible {
  outline: 2px solid #8f2a1f;
  outline-offset: 2px;
}

.cover__start {
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
  filter: brightness(0.88);
}

.cover__start:focus-visible {
  outline: 3px solid #8f2a1f;
  outline-offset: 3px;
}

.cover__start--sm {
  padding: 10px 28px;
  font-size: 15px;
  letter-spacing: 4px;
}

.cover__start:disabled {
  opacity: 0.55;
  cursor: default;
}

.cover__start:disabled:hover {
  background: #a93226;
}

.cover__modes {
  display: flex;
  gap: 10px;
}

.cover__modes button {
  font-size: 15px;
  letter-spacing: 3px;
  padding: 8px 22px;
  background: transparent;
  border: 1px solid #b8a888;
  border-radius: 999px;
  color: #4a443c;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}

.cover__modes button:hover {
  background: rgba(255, 255, 255, 0.55);
}

.cover__modes button.active {
  background: #a93226;
  border-color: #8f2a1f;
  color: #fff;
}

.cover__modes button:focus-visible {
  outline: 2px solid #8f2a1f;
  outline-offset: 2px;
}

.cover__online {
  display: flex;
  flex-direction: column;
  gap: 22px;
}

.cover__panel {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
}

.cover__panel-title {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 4px;
  color: #4a443c;
  margin: 0;
}

.cover__code {
  font-size: 16px;
  letter-spacing: 4px;
  padding: 8px 12px;
  width: 220px;
  text-transform: uppercase;
  background: rgba(255, 255, 255, 0.55);
  border: 1px solid #b8a888;
  border-radius: 4px;
  color: #3d362c;
}

.cover__code::placeholder {
  letter-spacing: 1px;
  font-size: 14px;
  color: #9a8f7d;
}

.cover__code:focus-visible {
  outline: 2px solid #8f2a1f;
  outline-offset: 2px;
}

.cover__error {
  font-size: 14px;
  letter-spacing: 1px;
  color: #8f2a1f;
  margin: 0;
}

.cover__hint {
  font-size: 12px;
  letter-spacing: 1px;
  color: #9a8f7d;
  margin: 0;
}

/* 封面 → 对局 转场 */
.cover-leave-active {
  transition: opacity 450ms ease;
}

.cover-leave-to {
  opacity: 0;
}

.cover-leave-active .cover__art {
  animation: none;
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

  .cover__setting,
  .cover__seg,
  .cover__levels {
    align-items: center;
    justify-content: center;
  }
}

@media (prefers-reduced-motion: reduce) {
  .cover__art,
  .cover__clouds .cloud,
  .cover__veil,
  .cover__content > * {
    animation: none;
  }

  .cover__clouds,
  .cover__veil {
    opacity: 0;
  }

  .cover__content > * {
    opacity: 1;
    transform: none;
  }

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
  flex: none;
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

.btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.btn:disabled:hover {
  background: #fbf2df;
}

.room-code {
  font-size: 14px;
  letter-spacing: 2px;
  padding: 6px 12px;
  border-radius: 999px;
  background: #e9dcc3;
  color: #4a443c;
  font-variant-numeric: tabular-nums;
}

.board-wrap {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  justify-content: center;
  align-items: center;
}

.board {
  position: relative;
  width: min(92vw, 600px);
  aspect-ratio: 600 / 660;
  user-select: none;
  flex: none;
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
