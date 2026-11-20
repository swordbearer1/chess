/**
 * 联机客户端封装（WebSocket）。
 * 服务端维护权威棋局：走子需服务端确认（moved 广播）后才更新棋盘。
 * 断线后按退避策略自动重连；刷新页面后凭 localStorage 中的 {code, token} 恢复座位。
 */
import type { Color, GameStatus, Move, Position } from './chess'

export const WS_URL: string =
  import.meta.env.VITE_WS_URL ?? `ws://${window.location.hostname}:8787`

export interface PeersInfo {
  red: boolean
  black: boolean
  redConnected: boolean
  blackConnected: boolean
}

export interface ServerMoveEvent {
  move: Move
  version: number
  status: GameStatus
  by: Color
  sideToMove: Color
}

export interface ServerState {
  code: string
  color: Color
  token: string
  host: boolean
  position: Position
  version: number
  status: GameStatus
  peers: PeersInfo
}

export interface OnlineEvents {
  onOpen?: () => void
  onClose?: () => void
  onCreated?: (code: string, color: Color, token: string) => void
  onJoined?: (code: string, color: Color, token: string, resumed: boolean) => void
  onState?: (state: ServerState) => void
  onMoved?: (event: ServerMoveEvent) => void
  onRestarted?: (position: Position, version: number, status: GameStatus) => void
  onPeers?: (peers: PeersInfo) => void
  onOpponentLeft?: (color: Color) => void
  onError?: (message: string) => void
}

interface CreatePending {
  type: 'create'
  color: 'red' | 'black' | 'random'
}

interface JoinPending {
  type: 'join'
  code: string
  token?: string
}

const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 8000
const SESSION_KEY = 'xiangqi-online-session'

export class OnlineClient {
  private ws: WebSocket | null = null
  private events: OnlineEvents
  private shouldReconnect = false // 进入房间后为 true，断线自动重连
  private attempt = 0
  private reconnectTimer: number | null = null
  private pending: CreatePending | JoinPending | null = null

  /** 本座位凭证（调用方也写入 localStorage，用于刷新后重连） */
  code = ''
  token = ''

  constructor(events: OnlineEvents) {
    this.events = events
  }

  /** 建立连接（未进入房间时断线不自动重连） */
  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return
    this.openSocket()
  }

  /** 进入房间后调用：断线时自动重连并凭 token 恢复座位 */
  setSession(code: string, token: string, color?: Color | null): void {
    this.code = code
    this.token = token
    this.shouldReconnect = true
    this.attempt = 0
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ code, token, color }))
    } catch {
      /* 存储不可用时仅内存重连 */
    }
  }

  /** 读取上次会话（刷新后自动重连用）；无会话返回 null */
  static savedSession(): { code: string; token: string; color: Color | null } | null {
    try {
      const raw = localStorage.getItem(SESSION_KEY)
      if (!raw) return null
      const parsed = JSON.parse(raw) as { code?: string; token?: string; color?: Color }
      if (typeof parsed.code === 'string' && typeof parsed.token === 'string' && parsed.code && parsed.token) {
        const color = parsed.color === 'red' || parsed.color === 'black' ? parsed.color : null
        return { code: parsed.code, token: parsed.token, color }
      }
    } catch {
      /* ignore */
    }
    return null
  }

  clearSession(): void {
    this.shouldReconnect = false
    this.code = ''
    this.token = ''
    this.attempt = 0
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    try {
      localStorage.removeItem(SESSION_KEY)
    } catch {
      /* ignore */
    }
  }

  create(color: 'red' | 'black' | 'random'): void {
    this.pending = { type: 'create', color }
    this.connect()
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.flushPending()
  }

  join(code: string, token?: string): void {
    this.pending = { type: 'join', code, token }
    this.connect()
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.flushPending()
  }

  sendMove(move: Move, moveId: string): void {
    this.send({ type: 'move', move, moveId })
  }

  sendRestart(): void {
    this.send({ type: 'restart' })
  }

  /** 离开房间：通知服务端并断开，清除本地会话 */
  leave(): void {
    this.send({ type: 'leave' })
    this.clearSession()
    this.ws?.close()
    this.ws = null
  }

  close(): void {
    this.clearSession()
    this.ws?.close()
    this.ws = null
  }

  private openSocket(): void {
    const ws = new WebSocket(WS_URL)
    this.ws = ws

    ws.onopen = () => {
      this.attempt = 0
      this.flushPending()
      this.events.onOpen?.()
    }

    ws.onmessage = (ev: MessageEvent) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(String(ev.data)) as Record<string, unknown>
      } catch {
        return
      }
      this.dispatch(msg)
    }

    ws.onclose = () => {
      this.ws = null
      this.events.onClose?.()
      if (this.shouldReconnect && this.code && this.token) this.scheduleReconnect()
    }

    ws.onerror = () => {
      /* 错误后由 onclose 统一处理 */
    }
  }

  private flushPending(): void {
    const p = this.pending
    this.pending = null
    if (!p || !this.ws || this.ws.readyState !== WebSocket.OPEN) return
    if (p.type === 'create') {
      this.ws.send(JSON.stringify({ type: 'create', color: p.color }))
    } else {
      this.ws.send(JSON.stringify({ type: 'join', code: p.code, token: p.token }))
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.attempt, RECONNECT_MAX_MS)
    this.attempt += 1
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      if (!this.shouldReconnect) return
      // 凭座位凭证恢复座位（open 后由 flushPending 发出 join）
      this.pending = { type: 'join', code: this.code, token: this.token }
      this.openSocket()
    }, delay)
  }

  private send(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify(payload))
  }

  private dispatch(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'created':
        this.events.onCreated?.(String(msg.code), msg.color as Color, String(msg.token))
        break
      case 'joined':
        this.events.onJoined?.(String(msg.code), msg.color as Color, String(msg.token), Boolean(msg.resumed))
        break
      case 'state':
        this.events.onState?.(msg as unknown as ServerState)
        break
      case 'moved':
        this.events.onMoved?.(msg as unknown as ServerMoveEvent)
        break
      case 'restarted':
        this.events.onRestarted?.(msg.position as Position, Number(msg.version), msg.status as GameStatus)
        break
      case 'peers':
        this.events.onPeers?.(msg.peers as PeersInfo)
        break
      case 'opponent-left':
        this.events.onOpponentLeft?.(msg.color as Color)
        break
      case 'error':
        this.events.onError?.(String(msg.message))
        break
      default:
        break
    }
  }
}
