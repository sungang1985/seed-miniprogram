const crypto = require('node:crypto');

const ROOM_LIFETIME_MS = 30 * 60 * 1000;
const LOCATION_LIFETIME_MS = 30 * 1000;
const FUTURE_TOLERANCE_MS = 5000;
const MAX_MEMBERS = 8;
const MAX_ACCURACY_METERS = 50;

class ShareError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ShareError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ShareError(code, message);
}

function hexToken(value, code = 'INVALID_REQUEST') {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/i.test(value)) {
    fail(code, code === 'STALE_LEASE' ? '位置共享授权已失效，请重新开始共享' : '邀请信息无效，请重新打开好友邀请');
  }
  return value.toLowerCase();
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function matchesToken(value, hash) {
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) return false;
  return crypto.timingSafeEqual(Buffer.from(digest(value), 'hex'), Buffer.from(hash, 'hex'));
}

function memberId(roomId, openId) {
  return digest(roomId + ':' + openId).slice(0, 24);
}

function requireRoom(room, at) {
  if (!room) fail('ROOM_NOT_FOUND', '共享已不存在，请重新获取邀请');
  if (!Number.isFinite(room.expiresAt) || room.expiresAt <= at) {
    fail('ROOM_EXPIRED', '本次位置共享已到期');
  }
}

function requireActive(room, at) {
  requireRoom(room, at);
  if (room.status !== 'active') fail('ROOM_CLOSED', '本次位置共享已结束');
}

function requireMember(room, openId) {
  const id = memberId(room.roomId, openId);
  const member = room.members && room.members[id];
  if (!member || member.openId !== openId) fail('NOT_MEMBER', '请通过好友邀请加入本次共享');
  return member;
}

function validateLocation(value, at) {
  if (!value || !Number.isFinite(value.latitude) || Math.abs(value.latitude) > 90 ||
      !Number.isFinite(value.longitude) || Math.abs(value.longitude) > 180 ||
      !Number.isFinite(value.accuracy) || value.accuracy < 0 || value.accuracy > MAX_ACCURACY_METERS ||
      !Number.isFinite(value.timestamp) || value.timestamp < 0) {
    fail('INVALID_LOCATION', '当前位置无效或精度不足，请等待有效定位');
  }
  if (at - value.timestamp > LOCATION_LIFETIME_MS || value.timestamp - at > FUTURE_TOLERANCE_MS) {
    fail('STALE_LOCATION', '定位数据已过期，请等待新的定位');
  }
  return {
    latitude: value.latitude,
    longitude: value.longitude,
    accuracy: value.accuracy,
    sampledAt: value.timestamp,
    updatedAt: at
  };
}

function publicRoom(room, openId, at, allowMembers = true) {
  const selfId = memberId(room.roomId, openId);
  const members = allowMembers ? Object.values(room.members || {}).map((member) => {
    const point = member.location;
    const live = room.status === 'active' && member.sharing && !!point &&
      at - point.sampledAt <= LOCATION_LIFETIME_MS && point.sampledAt - at <= FUTURE_TOLERANCE_MS &&
      at - point.updatedAt <= LOCATION_LIFETIME_MS;
    return {
      id: member.id,
      label: member.label,
      role: member.role,
      sharing: room.status === 'active' && !!member.sharing,
      location: live ? Object.assign({}, point) : null,
      live
    };
  }) : [];
  return {
    roomId: room.roomId,
    expiresAt: room.expiresAt,
    serverTime: at,
    status: room.status,
    selfId,
    ownerId: room.ownerId,
    members
  };
}

function clearMember(member) {
  member.sharing = false;
  member.leaseHash = null;
  member.sequence = 0;
  member.lastSampleAt = null;
  member.location = null;
}

function closeRoom(room, at) {
  room.status = 'closed';
  room.closedAt = at;
  room.inviteHash = null;
  for (const member of Object.values(room.members)) clearMember(member);
}

/**
 * Repository.mutate serializes a read/modify/write through a database transaction.
 * Expiry is checked on every request; physical cleanup is an operator retention task.
 */
function createLocationShareService({ repository, now = Date.now, randomBytes = crypto.randomBytes }) {
  function token() {
    return randomBytes(16).toString('hex');
  }

  async function create(openId) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const roomId = token();
      const inviteToken = token();
      const value = await repository.mutate(roomId, (existing) => {
        if (existing) return { value: null };
        const at = now();
        const id = memberId(roomId, openId);
        const room = {
          roomId,
          ownerOpenId: openId,
          ownerId: id,
          inviteHash: digest(inviteToken),
          createdAt: at,
          expiresAt: at + ROOM_LIFETIME_MS,
          status: 'active',
          nextMemberNumber: 1,
          members: {}
        };
        room.members[id] = {
          id, openId, label: '发起人', role: 'owner', joinedAt: at,
          sharing: false, leaseHash: null, sequence: 0, lastSampleAt: null, location: null
        };
        return { room, value: Object.assign(publicRoom(room, openId, at), { inviteToken }) };
      });
      if (value) return value;
    }
    fail('INTERNAL_ERROR', '暂时无法创建共享，请稍后重试');
  }

  async function execute(event, openId) {
    if (typeof openId !== 'string' || !openId || openId.length > 128) {
      fail('UNAUTHENTICATED', '无法确认微信身份，请重新打开小程序');
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) fail('INVALID_REQUEST', '共享请求无效');
    const action = event.action;
    if (action === 'create') return create(openId);
    const actions = ['join', 'poll', 'start', 'publish', 'pause', 'leave', 'close'];
    if (!actions.includes(action)) fail('INVALID_REQUEST', '不支持的共享操作');
    const roomId = hexToken(event.roomId);
    const invite = action === 'join' ? hexToken(event.inviteToken, 'INVITE_INVALID') : null;
    const lease = action === 'publish' ? hexToken(event.lease, 'STALE_LEASE') : null;
    // Generate secrets outside the transaction callback: database retries keep one lease.
    const nextLease = action === 'start' ? token() : null;
    return repository.mutate(roomId, (room) => {
      const at = now();
      requireRoom(room, at);
      if (action === 'join') {
        requireActive(room, at);
        if (!matchesToken(invite, room.inviteHash)) fail('INVITE_INVALID', '邀请已失效，请重新获取好友邀请');
        const id = memberId(roomId, openId);
        if (!room.members[id]) {
          if (Object.keys(room.members).length >= MAX_MEMBERS) fail('ROOM_FULL', '本次位置共享人数已满');
          const label = '好友 ' + room.nextMemberNumber;
          room.nextMemberNumber += 1;
          room.members[id] = {
            id, openId, label, role: 'member', joinedAt: at,
            sharing: false, leaseHash: null, sequence: 0, lastSampleAt: null, location: null
          };
        }
        return { room, value: publicRoom(room, openId, at) };
      }
      const member = requireMember(room, openId);
      if (action === 'poll') return { value: publicRoom(room, openId, at) };
      if (action === 'pause') {
        // A hidden old Page may finish cleanup after a replacement Page starts.
        // Its lease may only revoke its own sharing generation.
        if (member.sharing && !matchesToken(hexToken(event.lease, 'STALE_LEASE'), member.leaseHash)) {
          fail('STALE_LEASE', '位置共享授权已失效，请重新开始共享');
        }
        clearMember(member);
        return { room, value: publicRoom(room, openId, at) };
      }
      if (action === 'leave') {
        if (member.role === 'owner') closeRoom(room, at);
        delete room.members[member.id];
        return { room, value: publicRoom(room, openId, at, false) };
      }
      if (action === 'close') {
        if (room.ownerOpenId !== openId) fail('FORBIDDEN', '只有发起人可以结束本次共享');
        closeRoom(room, at);
        return { room, value: publicRoom(room, openId, at) };
      }
      requireActive(room, at);
      if (action === 'start') {
        member.sharing = true;
        member.leaseHash = digest(nextLease);
        member.sequence = 0;
        member.lastSampleAt = null;
        member.location = null;
        return { room, value: Object.assign(publicRoom(room, openId, at), { lease: nextLease }) };
      }
      if (!member.sharing || !matchesToken(lease, member.leaseHash)) {
        fail('STALE_LEASE', '位置共享授权已失效，请重新开始共享');
      }
      if (!Number.isSafeInteger(event.sequence) || event.sequence <= member.sequence || event.sequence <= 0) {
        fail('STALE_SEQUENCE', '已忽略重复或过期的位置更新');
      }
      const location = validateLocation(event.location, at);
      if (member.lastSampleAt !== null && location.sampledAt <= member.lastSampleAt) {
        fail('STALE_LOCATION', '已忽略旧的定位数据，请等待新的定位');
      }
      member.location = location;
      member.lastSampleAt = location.sampledAt;
      member.sequence = event.sequence;
      return { room, value: publicRoom(room, openId, at) };
    });
  }

  async function handle(event, openId) {
    try {
      return { code: 0, data: await execute(event, openId) };
    } catch (error) {
      return {
        code: error instanceof ShareError ? error.code : 'INTERNAL_ERROR',
        message: error instanceof ShareError ? error.message : '共享服务暂时不可用，请稍后重试',
        data: null
      };
    }
  }

  return { execute, handle };
}

module.exports = {
  createLocationShareService,
  ShareError,
  ROOM_LIFETIME_MS,
  LOCATION_LIFETIME_MS,
  MAX_MEMBERS
};
