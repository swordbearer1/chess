/**
 * 《楚河棋局》联机服务端（Node.js + WebSocket）。
 * 服务端分配座位并维护权威棋局：校验房间身份、执色、回合、走法合法性与终局，
 * 确认后广播给双方。棋局状态带递增版本号，支持重复消息去重与刷新后重连。
 * 房间保存在内存中，服务重启即清空。
 *
 * 本地启动：npm run server（默认端口 8787，可用环境变量 PORT 覆盖）
 */
import { WebSocket, WebSocketServer } from 'ws'
import { RoomManager, roomSnapshot } from './game'
import type { Room } from './game'

const PORT = Number(process.env.PORT ?? 8787)
const HEARTBEAT_MS = 30_000
const DISCONNECTED_TTL_MS = 10 * 60_000

const manager = new RoomManager()

interface ClientMessage {
  type: 'create' | 'join' | 'move' | 'restart' | 'leave'
  color?: 'red' | 'black' | 'random'
  code?: string
  token?: string
  move?: { from: { row: number; col: number }; to: { row: number; col: number } }
  moveId?: string
}

const wss = new WebSocketServer({ port: PORT })
console.log(`[xiangqi-server] 监听 ws://localhost:${PORT}`)

/** 每个连接当前绑定的房间与座位 token */
interface Binding {
  room: Room
  token: string
}

const bindingOf = new WeakMap<WebSocket, Binding>()
const socketsByRoom = new Map<string, Map<string, WebSocket>>()

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload))
}

/** 向房间内双方广播（可以按座位排除某连接） */
function broadcast(room: Room, payload: unknown, except?: WebSocket): void {
  const sockets = socketsByRoom.get(room.code)
  if (!sockets) return
  for (const ws of sockets.values()) {
    if (ws !== except) send(ws, payload)
  }
}

function notifyPeerPresence(room: Room): void {
  const payload = {
    type: 'peers',
    peers: {
      red: room.seats.red !== undefined,
      black: room.seats.black !== undefined,
      redConnected: room.seats.red?.connected ?? false,
      blackConnected: room.seats.black?.connected ?? false,
    },
  }
  broadcast(room, payload)
}

function bind(ws: WebSocket, room: Room, token: string): void {
  unbind(ws)
  bindingOf.set(ws, { room, token })
  let sockets = socketsByRoom.get(room.code)
  if (!sockets) {
    sockets = new Map()
    socketsByRoom.set(room.code, sockets)
  }
  // 同座位重复登录（如刷新重连）：关闭旧连接，只保留新连接
  const prev = sockets.get(token)
  if (prev && prev !== ws) {
    bindingOf.delete(prev)
    prev.close()
  }
  sockets.set(token, ws)
  manager.setConnected(room, token, true)
  notifyPeerPresence(room)
}

function unbind(ws: WebSocket): void {
  const binding = bindingOf.get(ws)
  if (!binding) return
  const { room, token } = binding
  bindingOf.delete(ws)
  const sockets = socketsByRoom.get(room.code)
  // 仅当该座位当前连接就是本连接时，才标记断线（重连后旧连接的迟到 close 不影响新连接）
  if (sockets && sockets.get(token) === ws) {
    sockets.delete(token)
    if (sockets.size === 0) socketsByRoom.delete(room.code)
    manager.setConnected(room, token, false)
    notifyPeerPresence(room)
  }
}

function handleCreate(ws: WebSocket, msg: ClientMessage): void {
  const color = msg.color === 'black' || msg.color === 'random' ? msg.color : 'red'
  const { room, color: seatColor, token } = manager.createRoom(color)
  bind(ws, room, token)
  send(ws, { type: 'created', code: room.code, color: seatColor, token })
  send(ws, { type: 'state', ...roomSnapshot(room, seatColor) })
}

function handleJoin(ws: WebSocket, msg: ClientMessage): void {
  if (typeof msg.code !== 'string' || msg.code.trim() === '') {
    send(ws, { type: 'error', message: '请输入房间码' })
    return
  }
  const result = manager.joinRoom(msg.code.trim().toUpperCase(), msg.token)
  if ('error' in result) {
    send(ws, { type: 'error', message: result.error })
    return
  }
  const { room, color, token } = result
  bind(ws, room, token)
  send(ws, { type: 'joined', code: room.code, color, token, resumed: result.resumed })
  send(ws, { type: 'state', ...roomSnapshot(room, color) })
  notifyPeerPresence(room)
}

function handleMove(ws: WebSocket, msg: ClientMessage): void {
  const binding = bindingOf.get(ws)
  if (!binding || !msg.move || typeof msg.moveId !== 'string') {
    send(ws, { type: 'error', message: '尚未加入房间' })
    return
  }
  const { room, token } = binding
  const result = manager.applyClientMove(room, token, msg.move, msg.moveId)
  if ('error' in result) {
    send(ws, { type: 'error', message: result.error })
    return
  }
  broadcast(room, {
    type: 'moved',
    move: result.move,
    version: result.version,
    status: result.status,
    by: result.by,
    sideToMove: room.position.sideToMove,
  })
}

function handleRestart(ws: WebSocket): void {
  const binding = bindingOf.get(ws)
  if (!binding) return
  const { room, token } = binding
  const result = manager.restart(room, token)
  if ('error' in result) {
    send(ws, { type: 'error', message: result.error })
    return
  }
  broadcast(room, {
    type: 'restarted',
    position: { board: result.position.board, sideToMove: result.position.sideToMove },
    version: result.version,
    status: result.status,
  })
}

function handleLeave(ws: WebSocket): void {
  const binding = bindingOf.get(ws)
  if (!binding) return
  const { room, token } = binding
  unbind(ws)
  const leftColor = manager.leave(room, token)
  if (leftColor) {
    broadcast(room, { type: 'opponent-left', color: leftColor })
    notifyPeerPresence(room)
  }
}

const aliveSockets = new WeakSet<WebSocket>()

wss.on('connection', (ws) => {
  aliveSockets.add(ws)
  ws.on('pong', () => {
    aliveSockets.add(ws)
  })

  ws.on('message', (data) => {
    let msg: ClientMessage
    try {
      msg = JSON.parse(String(data))
    } catch {
      send(ws, { type: 'error', message: '消息格式错误' })
      return
    }
    switch (msg.type) {
      case 'create':
        handleCreate(ws, msg)
        break
      case 'join':
        handleJoin(ws, msg)
        break
      case 'move':
        handleMove(ws, msg)
        break
      case 'restart':
        handleRestart(ws)
        break
      case 'leave':
        handleLeave(ws)
        break
      default:
        send(ws, { type: 'error', message: '未知消息类型' })
    }
  })

  ws.on('close', () => {
    unbind(ws)
  })

  ws.on('error', () => {
    /* 连接错误由 close 处理 */
  })
})

// 心跳：清理死连接
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!aliveSockets.has(ws)) {
      ws.terminate()
      continue
    }
    aliveSockets.delete(ws)
    ws.ping()
  }
}, HEARTBEAT_MS)

// 定期清理空房间与双方长时间掉线的房间
const cleanup = setInterval(() => {
  const removed = manager.cleanup(DISCONNECTED_TTL_MS)
  if (removed > 0) console.log(`[xiangqi-server] 清理 ${removed} 个房间`)
}, 60_000)

wss.on('close', () => {
  clearInterval(heartbeat)
  clearInterval(cleanup)
})
