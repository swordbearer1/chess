import { describe, expect, it } from 'vitest'
import { generateLegalMoves, initialPosition } from '../src/chess'
import { RoomManager, roomSnapshot } from './game'

describe('RoomManager 房间与座位', () => {
  it('创建房间：执红/执黑/随机均分配正确座位', () => {
    const m = new RoomManager()
    const red = m.createRoom('red')
    expect(red.color).toBe('red')
    expect(red.room.seats.red?.token).toBe(red.token)
    expect(red.room.seats.black).toBeUndefined()
    expect(red.room.version).toBe(0)

    const black = m.createRoom('black')
    expect(black.color).toBe('black')

    for (let i = 0; i < 20; i++) {
      const r = m.createRoom('random')
      expect(['red', 'black']).toContain(r.color)
      expect(r.room.seats[r.color]?.token).toBe(r.token)
    }
  })

  it('加入房间：分配空位、拒绝满房、token 恢复座位', () => {
    const m = new RoomManager()
    const { room, token } = m.createRoom('red')
    const joined = m.joinRoom(room.code)
    expect('error' in joined).toBe(false)
    if ('error' in joined) return
    expect(joined.color).toBe('black')
    expect(joined.resumed).toBe(false)

    const full = m.joinRoom(room.code)
    expect(full).toEqual({ error: '房间已满' })

    const resumed = m.joinRoom(room.code, token)
    expect('error' in resumed).toBe(false)
    if ('error' in resumed) return
    expect(resumed.color).toBe('red')
    expect(resumed.resumed).toBe(true)

    const bad = m.joinRoom(room.code, 'invalid-token')
    expect('error' in bad).toBe(true)
    expect(m.joinRoom('NOPE00')).toEqual({ error: '房间不存在或已解散' })
  })

  it('离开后座位释放，可重新加入', () => {
    const m = new RoomManager()
    const { room, token } = m.createRoom('red')
    const j = m.joinRoom(room.code)
    if ('error' in j) throw new Error('join failed')
    expect(m.leave(room, j.token)).toBe('black')
    const again = m.joinRoom(room.code)
    expect('error' in again).toBe(false)
    expect(token).toBeTruthy()
  })
})

describe('RoomManager 权威棋局校验', () => {
  it('非轮次方走子被拒绝；合法走子后版本递增且轮到对方', () => {
    const m = new RoomManager()
    const { room, token } = m.createRoom('red')
    const j = m.joinRoom(room.code)
    if ('error' in j) throw new Error('join failed')

    const redMove = generateLegalMoves(room.position)[0]
    // 黑方先走 → 拒绝
    expect(m.applyClientMove(room, j.token, redMove, 'id-1')).toEqual({ error: '未轮到你走子' })
    // 红方合法走子 → 接受
    const r = m.applyClientMove(room, token, redMove, 'id-1')
    expect('error' in r).toBe(false)
    if ('error' in r) return
    expect(r.version).toBe(1)
    expect(r.by).toBe('red')
    expect(room.position.sideToMove).toBe('black')
    expect(room.status).toBe('playing')
  })

  it('非法走法被拒绝（不改变局面与版本）', () => {
    const m = new RoomManager()
    const { room, token } = m.createRoom('red')
    const before = room.version
    const r = m.applyClientMove(room, token, { from: { row: 9, col: 0 }, to: { row: 0, col: 0 } }, 'id-x')
    expect(r).toEqual({ error: '非法走法' })
    expect(room.version).toBe(before)
    expect(room.position).toEqual(initialPosition())
  })

  it('重复 moveId 不重复执行（幂等）', () => {
    const m = new RoomManager()
    const { room, token } = m.createRoom('red')
    const move = generateLegalMoves(room.position)[0]
    const first = m.applyClientMove(room, token, move, 'dup')
    expect('error' in first).toBe(false)
    const second = m.applyClientMove(room, token, move, 'dup')
    expect('error' in second).toBe(false)
    if ('error' in second || 'error' in first) return
    expect(second.version).toBe(first.version)
    // 同一座位新 moveId 且轮到黑方时红方仍不能走
    const j = m.joinRoom(room.code)
    if ('error' in j) throw new Error('join failed')
    const blackMove = generateLegalMoves(room.position)[0]
    const b = m.applyClientMove(room, j.token, blackMove, 'id-b')
    expect('error' in b).toBe(false)
  })

  it('终局状态正确传递（将死局面）', () => {
    const m = new RoomManager()
    const { room, token } = m.createRoom('red')
    // 构造红方一步杀：黑将(0,4)、黑卒(4,4)、红帅(9,4)、红车(0,0)(0,8)(1,1)(5,4)、红马(0,3)(0,5)
    room.position = {
      board: [
        [{ type: 'chariot', color: 'red' }, null, null, { type: 'horse', color: 'red' }, { type: 'general', color: 'black' }, { type: 'horse', color: 'red' }, null, null, { type: 'chariot', color: 'red' }],
        [null, { type: 'chariot', color: 'red' }, null, null, null, null, null, null, null],
        Array(9).fill(null),
        Array(9).fill(null),
        [null, null, null, null, { type: 'soldier', color: 'black' }, null, null, null, null],
        [null, null, null, null, { type: 'chariot', color: 'red' }, null, null, null, null],
        Array(9).fill(null),
        Array(9).fill(null),
        Array(9).fill(null),
        [null, null, null, null, { type: 'general', color: 'red' }, null, null, null, null],
      ],
      sideToMove: 'red',
    }
    const result = m.applyClientMove(room, token, { from: { row: 5, col: 4 }, to: { row: 4, col: 4 } }, 'mate')
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.status).toBe('redWon')
    // 终局后走子被拒绝
    const j = m.joinRoom(room.code)
    if ('error' in j) throw new Error('join failed')
    expect(m.applyClientMove(room, j.token, { from: { row: 0, col: 4 }, to: { row: 1, col: 4 } }, 'after')).toEqual({ error: '对局已结束' })
  })

  it('仅房主可重开；重开后回到初始局面且版本递增', () => {
    const m = new RoomManager()
    const { room, token } = m.createRoom('red')
    const j = m.joinRoom(room.code)
    if ('error' in j) throw new Error('join failed')
    expect(m.restart(room, j.token)).toEqual({ error: '仅房主可重新开始' })

    const r = m.restart(room, token)
    expect('error' in r).toBe(false)
    if ('error' in r) return
    expect(r.version).toBe(1)
    expect(r.position).toEqual(initialPosition())
  })

  it('清理：双方离开后房间被清除；活跃房间保留', () => {
    const m = new RoomManager()
    const { room } = m.createRoom('red')
    m.joinRoom(room.code)
    // 活跃房间：长 TTL 不清理
    expect(m.cleanup(1_000_000)).toBe(0)
    expect(m.getRoom(room.code)).toBeDefined()
    // 双方离开后被清除
    m.leave(room, room.seats.red!.token)
    if (room.seats.black) m.leave(room, room.seats.black.token)
    expect(m.cleanup(1_000_000)).toBe(1)
    expect(m.getRoom(room.code)).toBeUndefined()
  })
})

describe('序列化', () => {
  it('roomSnapshot 包含重建棋局所需全部信息', () => {
    const m = new RoomManager()
    const { room, color, token } = m.createRoom('black')
    const snap = roomSnapshot(room, color)
    expect(snap.code).toBe(room.code)
    expect(snap.color).toBe('black')
    expect(snap.token).toBe(token)
    expect(snap.host).toBe(true)
    expect(snap.position).toEqual(initialPosition())
    expect(snap.version).toBe(0)
    expect(snap.status).toBe('playing')
    expect(snap.peers.red).toBe(false)
    expect(snap.peers.black).toBe(true)
  })
})
