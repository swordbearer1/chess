/**
 * 联机房间与权威棋局逻辑（纯函数模块，不依赖 WebSocket，便于单元测试）。
 * 房间保存在内存中：服务重启即清空（见 README）。
 */
import {
  applyMove,
  generateLegalMoves,
  getGameStatus,
  initialPosition,
} from '../src/chess'
import type { Color, GameStatus, Move, Position } from '../src/chess'

/** 座位颜色：红 / 黑 / 随机（由服务端抽签） */
export type SeatChoice = Color | 'random'

export interface Seat {
  color: Color
  token: string
  connected: boolean
}

export interface Room {
  code: string
  seats: Partial<Record<Color, Seat>>
  position: Position
  version: number
  status: GameStatus
  creatorToken: string
  /** 每个座位最后处理的 moveId，用于去重 */
  lastMoveId: Partial<Record<Color, string>>
  createdAt: number
  /** 双方均掉线的时间戳（用于清理） */
  lastAliveAt: number
}

export interface JoinResult {
  room: Room
  color: Color
  token: string
  resumed: boolean
}

const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const ROOM_CODE_LENGTH = 6
const TOKEN_CHARS = '0123456789abcdef'

function randomFrom(alphabet: string, length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return out
}

export function generateRoomCode(): string {
  return randomFrom(ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH)
}

export function generateSeatToken(): string {
  return randomFrom(TOKEN_CHARS, 32)
}

export function serializePosition(position: Position): { board: Position['board']; sideToMove: Color } {
  return { board: position.board, sideToMove: position.sideToMove }
}

/** 无副作用的房间快照（供网络下发） */
export function roomSnapshot(room: Room, forColor: Color) {
  return {
    code: room.code,
    color: forColor,
    token: room.seats[forColor]!.token,
    host: room.creatorToken === room.seats[forColor]!.token,
    position: serializePosition(room.position),
    version: room.version,
    status: room.status,
    peers: {
      red: room.seats.red !== undefined,
      black: room.seats.black !== undefined,
      redConnected: room.seats.red?.connected ?? false,
      blackConnected: room.seats.black?.connected ?? false,
    },
  }
}

export class RoomManager {
  private rooms = new Map<string, Room>()

  /** 创建房间：房主选择执色，random 由服务端抽签 */
  createRoom(choice: SeatChoice): { room: Room; color: Color; token: string } {
    const code = this.uniqueCode()
    const color: Color = choice === 'random' ? (Math.random() < 0.5 ? 'red' : 'black') : choice
    const token = generateSeatToken()
    const room: Room = {
      code,
      seats: { [color]: { color, token, connected: false } },
      position: initialPosition(),
      version: 0,
      status: 'playing',
      creatorToken: token,
      lastMoveId: {},
      createdAt: Date.now(),
      lastAliveAt: Date.now(),
    }
    this.rooms.set(code, room)
    return { room, color, token }
  }

  getRoom(code: string): Room | undefined {
    const room = this.rooms.get(code)
    if (!room) return undefined
    room.lastAliveAt = Date.now()
    return room
  }

  /**
   * 加入房间：
   * - 携带 token：重连恢复原座位；
   * - 无 token 或 token 失效：分配空余座位；房间已满则失败。
   */
  joinRoom(code: string, token?: string): JoinResult | { error: string } {
    const room = this.rooms.get(code)
    if (!room) return { error: '房间不存在或已解散' }

    if (token) {
      const seat = this.seatByToken(room, token)
      if (seat) return { room, color: seat.color, token, resumed: true }
      return { error: '座位凭证失效，请重新加入' }
    }

    const free: Color | undefined = !room.seats.red ? 'red' : !room.seats.black ? 'black' : undefined
    if (!free) return { error: '房间已满' }

    const newToken = generateSeatToken()
    room.seats[free] = { color: free, token: newToken, connected: false }
    return { room, color: free, token: newToken, resumed: false }
  }

  seatByToken(room: Room, token: string): Seat | undefined {
    for (const color of ['red', 'black'] as Color[]) {
      const seat = room.seats[color]
      if (seat && seat.token === token) return seat
    }
    return undefined
  }

  setConnected(room: Room, token: string, connected: boolean): void {
    const seat = this.seatByToken(room, token)
    if (seat) seat.connected = connected
  }

  /** 主动离开：座位释放，房间可能保留给对手 */
  leave(room: Room, token: string): Color | undefined {
    const seat = this.seatByToken(room, token)
    if (!seat) return undefined
    delete room.seats[seat.color]
    return seat.color
  }

  /** 走子：校验执色、回合与合法性，服务端确认后更新权威棋局并递增版本号 */
  applyClientMove(
    room: Room,
    token: string,
    move: Move,
    moveId: string,
  ): { version: number; move: Move; status: GameStatus; by: Color } | { error: string } {
    const seat = this.seatByToken(room, token)
    if (!seat) return { error: '座位凭证失效' }
    if (room.status !== 'playing') return { error: '对局已结束' }

    // 重复消息去重：同一座位相同 moveId 只处理一次（先于回合校验，保证重发可幂等应答）
    if (room.lastMoveId[seat.color] === moveId) {
      return { version: room.version, move, status: room.status, by: seat.color }
    }

    if (seat.color !== room.position.sideToMove) return { error: '未轮到你走子' }

    const legal = generateLegalMoves(room.position).some(
      (m) => m.from.row === move.from.row && m.from.col === move.from.col && m.to.row === move.to.row && m.to.col === move.to.col,
    )
    if (!legal) return { error: '非法走法' }

    room.lastMoveId[seat.color] = moveId
    room.position = applyMove(room.position, move)
    room.version += 1
    room.status = getGameStatus(room.position)
    return { version: room.version, move, status: room.status, by: seat.color }
  }

  /** 房主重开：双方保留座位，棋局回到初始局面 */
  restart(room: Room, token: string): { version: number; position: Position; status: GameStatus } | { error: string } {
    if (room.creatorToken !== token) return { error: '仅房主可重新开始' }
    room.position = initialPosition()
    room.version += 1
    room.status = 'playing'
    room.lastMoveId = {}
    return { version: room.version, position: room.position, status: room.status }
  }

  /** 清理：双方都已离开或长时间掉线的房间 */
  cleanup(disconnectedTtlMs: number): number {
    const now = Date.now()
    let removed = 0
    for (const [code, room] of this.rooms) {
      const anySeat = room.seats.red !== undefined || room.seats.black !== undefined
      if (!anySeat || now - room.lastAliveAt > disconnectedTtlMs) {
        this.rooms.delete(code)
        removed++
      }
    }
    return removed
  }

  private uniqueCode(): string {
    for (;;) {
      const code = generateRoomCode()
      if (!this.rooms.has(code)) return code
    }
  }
}
