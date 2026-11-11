const defaultConfig = require('../config');

const initializedClouds = new WeakMap();
const TOKEN = /^[a-f0-9]{32}$/;
const TERMINAL = ['ROOM_EXPIRED', 'ROOM_CLOSED', 'NOT_MEMBER', 'ROOM_NOT_FOUND'];

function sharingError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function copy(value) {
  return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/**
 * Room transport only: location permission and native GPS belong to the caller.
 * This service never persists coordinates, invitation tokens or publish leases.
 */
function createLocationSharing(options = {}) {
  const platform = options.wx || wx;
  const config = options.config || defaultConfig;
  const now = options.now || Date.now;
  const clock = Object.assign({ setTimeout, clearTimeout, setInterval, clearInterval }, options.timers);
  const onChange = options.onChange || (() => {});
  const environment = typeof config.cloudEnv === 'string' ? config.cloudEnv.trim() : '';
  const functionName = config.sharingFunctionName || 'location-share';
  const pollInterval = 3000;
  const publishInterval = 3000;
  const requestTimeout = options.requestTimeoutMs || 15000;
  const configured = !!(environment && platform.cloud && typeof platform.cloud.init === 'function' && typeof platform.cloud.callFunction === 'function');
  let room = null;
  let invitation = '';
  let lease = '';
  let phase = 'idle';
  let busyAction = '';
  let sharing = false;
  let pendingStop = false;
  let errorMessage = '';
  let errorCode = '';
  let errorSource = '';
  let foreground = true;
  let destroyed = false;
  let generation = 0;
  let serverOffset = 0;
  let heartbeat = null;
  let expiryTimer = null;
  let publishTimer = null;
  let publishing = false;
  let polling = false;
  let candidate = null;
  let lastSubmittedTimestamp = -Infinity;
  let lastPublishAt = -Infinity;
  let sequence = 0;
  let queue = Promise.resolve();
  let destroyPromise = null;
  const pending = new Map();

  function serverNow() { return now() + serverOffset; }

  function publicRoom() {
    if (!room) return null;
    const value = copy(room);
    const time = serverNow();
    value.serverTime = time;
    const active = value.status === 'active' && value.expiresAt > time;
    value.members = (value.members || []).map((member) => {
      const location = member.location;
      const live = active && member.sharing && member.live !== false && location &&
        Number.isFinite(location.updatedAt) && time - location.updatedAt <= 30000 &&
        Number.isFinite(location.sampledAt) && time - location.sampledAt <= 30000 && location.sampledAt <= time + 5000;
      return Object.assign({}, member, { live: !!live, location: live ? location : null });
    });
    return value;
  }

  function snapshot() {
    return { configured, phase, room: publicRoom(), sharing, pendingStop, errorMessage, errorCode, busyAction };
  }

  function emit() { if (!destroyed) onChange(snapshot()); }

  function clearPublisher() {
    if (publishTimer !== null) clock.clearTimeout(publishTimer);
    publishTimer = null;
    candidate = null;
  }

  function clearHeartbeat() {
    if (heartbeat !== null) clock.clearInterval(heartbeat);
    heartbeat = null;
  }

  function clearExpiry() {
    if (expiryTimer !== null) clock.clearTimeout(expiryTimer);
    expiryTimer = null;
  }

  function fail(error, source) {
    errorMessage = error.message || '位置共享暂时不可用，请稍后重试';
    errorCode = error.code || 'SHARING_NETWORK_ERROR';
    errorSource = source;
  }

  function clearError() { errorMessage = ''; errorCode = ''; errorSource = ''; }

  function terminal(code, message) {
    generation += 1;
    sharing = false;
    pendingStop = false;
    lease = '';
    invitation = '';
    busyAction = '';
    clearPublisher();
    clearHeartbeat();
    clearExpiry();
    phase = code === 'ROOM_EXPIRED' ? 'expired' : code === 'ROOM_CLOSED' ? 'closed' : 'error';
    if (room) room = Object.assign({}, room, { status: phase === 'expired' ? 'expired' : 'closed', members: [] });
    fail(sharingError(message || (phase === 'expired' ? '本次共享已到期' : '本次位置共享已结束'), code), 'terminal');
    emit();
  }

  function ensureCloud() {
    if (!environment) throw sharingError('好友共享服务尚未开通，请稍后再试', 'CLOUD_NOT_CONFIGURED');
    if (!configured) throw sharingError('当前微信版本不支持位置共享，请升级后重试', 'CLOUD_UNSUPPORTED');
    if (initializedClouds.get(platform.cloud) !== environment) {
      try {
        platform.cloud.init({ env: environment, traceUser: false });
        initializedClouds.set(platform.cloud, environment);
      } catch (error) {
        throw sharingError('共享服务初始化失败，请稍后重试', 'CLOUD_INIT_FAILED');
      }
    }
  }

  function call(action, data = {}) {
    try { ensureCloud(); } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const requestedAt = now();
      let settled = false;
      const timeout = clock.setTimeout(() => finish(sharingError('共享请求超时，请检查网络后重试', 'SHARING_TIMEOUT')), requestTimeout);
      function finish(error, value) {
        if (settled) return;
        settled = true;
        clock.clearTimeout(timeout);
        if (error) reject(error);
        else resolve(value);
      }
      try {
        platform.cloud.callFunction({
          name: functionName,
          data: Object.assign({}, data, { action }),
          success(response) {
            const result = response && response.result;
            if (!result || result.code !== 0 || !result.data) {
              finish(sharingError((result && result.message) || '共享服务返回异常，请重试', (result && result.code) || 'SHARING_BAD_RESPONSE'));
            } else finish(null, Object.assign({}, result.data, { requestStartedAt: requestedAt }));
          },
          fail() { finish(sharingError('位置共享网络连接失败，请重试', 'SHARING_NETWORK_ERROR')); }
        });
      } catch (error) {
        finish(sharingError('位置共享请求启动失败，请重试', 'SHARING_NETWORK_ERROR'));
      }
    });
  }

  function activeRoom() { return room && room.status === 'active' && room.expiresAt > serverNow(); }

  function applyRoom(data) {
    if (!data || !TOKEN.test(data.roomId || '') || !Number.isFinite(data.expiresAt) || !Number.isFinite(data.serverTime) ||
        ['active', 'closed'].indexOf(data.status) < 0 || typeof data.selfId !== 'string' || typeof data.ownerId !== 'string' ||
        !Array.isArray(data.members) || data.members.length > 8 || !data.members.every((member) => member && typeof member.id === 'string' && typeof member.sharing === 'boolean')) {
      throw sharingError('共享服务返回异常，请重试', 'SHARING_BAD_RESPONSE');
    }
    if (room && room.roomId === data.roomId && room.serverTime > data.serverTime) return;
    // Conservative clock bound: network latency can make a fix expire early,
    // but must not make an old server fix appear live for extra seconds.
    serverOffset = data.serverTime - (Number.isFinite(data.requestStartedAt) ? data.requestStartedAt : now());
    room = {
      roomId: data.roomId, expiresAt: data.expiresAt, serverTime: data.serverTime,
      status: data.status, selfId: data.selfId, ownerId: data.ownerId, members: copy(data.members)
    };
    clearExpiry();
    if (data.status !== 'active') {
      terminal('ROOM_CLOSED');
      return;
    }
    if (data.expiresAt <= serverNow()) {
      terminal('ROOM_EXPIRED');
      return;
    }
    expiryTimer = clock.setTimeout(() => terminal('ROOM_EXPIRED'), Math.max(0, data.expiresAt - serverNow()));
  }

  function checkError(error, source) {
    if (TERMINAL.indexOf(error.code) >= 0) terminal(error.code, error.message);
    else {
      fail(error, source);
      if (!room) phase = 'error';
    }
  }

  async function poll() {
    if (destroyed || !foreground || !activeRoom() || polling || busyAction) return;
    polling = true;
    const token = generation;
    const roomId = room.roomId;
    try {
      const data = await call('poll', { roomId });
      if (destroyed || !foreground || token !== generation || !room || room.roomId !== roomId) return;
      applyRoom(data);
      if (errorSource === 'poll') clearError();
      const own = room && room.members.find((member) => member.id === room.selfId);
      if (sharing && own && !own.sharing) {
        sharing = false;
        lease = '';
        clearPublisher();
      }
    } catch (error) {
      if (!destroyed && token === generation) checkError(error, 'poll');
    } finally {
      polling = false;
      emit();
    }
  }

  function startHeartbeat() {
    if (heartbeat !== null || destroyed || !foreground || !activeRoom()) return;
    heartbeat = clock.setInterval(() => { emit(); poll(); }, pollInterval);
  }

  function mutate(action, operation) {
    if (destroyed) return Promise.resolve(snapshot());
    if (pending.has(action)) return pending.get(action);
    const token = ++generation;
    busyAction = action;
    phase = 'busy';
    clearError();
    emit();
    const promise = queue.then(async () => {
      try {
        await operation(token);
        if (token === generation) {
          busyAction = '';
          if (phase !== 'closed' && phase !== 'expired') phase = activeRoom() ? 'active' : room ? phase : 'idle';
        }
      } catch (error) {
        if (token === generation) {
          if (action === 'start' && activeRoom() && ['SHARING_TIMEOUT', 'SHARING_NETWORK_ERROR', 'SHARING_BAD_RESPONSE'].indexOf(error.code) >= 0) {
            sharing = false;
            pendingStop = true;
          }
          busyAction = '';
          phase = activeRoom() ? 'active' : 'error';
          checkError(error, 'mutation');
        }
      }
      startHeartbeat();
      emit();
      return snapshot();
    }, () => snapshot());
    queue = promise.catch(() => {});
    pending.set(action, promise);
    promise.then(() => { if (pending.get(action) === promise) pending.delete(action); });
    return promise;
  }

  function create() {
    return mutate('create', async () => {
      if (activeRoom()) return;
      const data = await call('create');
      invitation = TOKEN.test(data.inviteToken || '') ? data.inviteToken : '';
      applyRoom(data);
    });
  }

  function join(invite = {}) {
    return mutate('join', async () => {
      if (!TOKEN.test(invite.roomId || '') || !TOKEN.test(invite.inviteToken || '')) throw sharingError('邀请链接无效，请让好友重新邀请', 'INVITE_INVALID');
      if (activeRoom() && room.roomId !== invite.roomId) throw sharingError('请先离开当前共享，再加入新的邀请', 'ROOM_ALREADY_ACTIVE');
      const data = await call('join', { roomId: invite.roomId, inviteToken: invite.inviteToken });
      invitation = invite.inviteToken;
      applyRoom(data);
    });
  }

  function startPublishing() {
    return mutate('start', async (token) => {
      if (!foreground) throw sharingError('请回到共享页面后再开启位置共享', 'SHARING_NOT_FOREGROUND');
      if (!activeRoom()) throw sharingError('请先创建或加入位置共享', 'NOT_IN_ROOM');
      if (pendingStop) throw sharingError('请先重试停止共享，再重新开启', 'SHARING_STOP_PENDING');
      const data = await call('start', { roomId: room.roomId });
      applyRoom(data);
      if (!activeRoom()) return;
      if (!TOKEN.test(data.lease || '')) throw sharingError('共享服务返回异常，请重试', 'SHARING_BAD_RESPONSE');
      lease = data.lease;
      sequence = 0;
      lastSubmittedTimestamp = -Infinity;
      lastPublishAt = -Infinity;
      if (token === generation && !destroyed && foreground) sharing = true;
    });
  }

  function freshLocation(fix) {
    return fix && Number.isFinite(fix.latitude) && Math.abs(fix.latitude) <= 90 &&
      Number.isFinite(fix.longitude) && Math.abs(fix.longitude) <= 180 &&
      Number.isFinite(fix.accuracy) && fix.accuracy >= 0 && fix.accuracy <= 50 &&
      Number.isFinite(fix.timestamp) && fix.timestamp >= 0 && fix.timestamp > lastSubmittedTimestamp &&
      fix.timestamp >= now() - 30000 && fix.timestamp <= now() + 5000;
  }

  function schedulePublish() {
    if (destroyed || !foreground || !sharing || pendingStop || publishing || publishTimer !== null || !candidate || !activeRoom()) return;
    publishTimer = clock.setTimeout(() => {
      publishTimer = null;
      flushPublish();
    }, Math.max(0, lastPublishAt + publishInterval - now()));
  }

  async function flushPublish() {
    if (destroyed || !foreground || !sharing || !lease || pendingStop || !candidate || !activeRoom()) return;
    const fix = candidate;
    candidate = null;
    if (!freshLocation(fix)) return;
    publishing = true;
    lastPublishAt = now();
    lastSubmittedTimestamp = fix.timestamp;
    const token = generation;
    const roomId = room.roomId;
    try {
      const data = await call('publish', { roomId, lease, sequence: ++sequence, location: fix });
      if (destroyed || token !== generation || !sharing) return;
      applyRoom(data);
      if (errorSource === 'publish') clearError();
    } catch (error) {
      if (!destroyed && token === generation) {
        if (error.code === 'STALE_LEASE') {
          sharing = false;
          lease = '';
          clearPublisher();
        }
        checkError(error, 'publish');
      }
    } finally {
      publishing = false;
      emit();
      schedulePublish();
    }
  }

  function updateLocation(fix) {
    if (destroyed || !foreground || !sharing || pendingStop || !freshLocation(fix)) return false;
    if (candidate && fix.timestamp <= candidate.timestamp) return false;
    candidate = { latitude: fix.latitude, longitude: fix.longitude, accuracy: fix.accuracy, timestamp: fix.timestamp };
    schedulePublish();
    return true;
  }

  function stop(action) {
    if (destroyed) return Promise.resolve(snapshot());
    sharing = false;
    clearPublisher();
    pendingStop = !!room || pending.has('start') || pending.has('create') || pending.has('join');
    return mutate(action, async () => {
      if (!room || room.status !== 'active') { pendingStop = false; return; }
      const currentLease = lease;
      let data;
      try {
        data = await call(action, Object.assign({ roomId: room.roomId }, action === 'pause' && currentLease ? { lease: currentLease } : {}));
      } catch (error) {
        if (action === 'pause' && currentLease && error.code === 'STALE_LEASE') {
          // Another page has rotated this lease; this page can no longer send.
          lease = '';
          pendingStop = false;
          return;
        }
        throw error;
      }
      lease = '';
      pendingStop = false;
      if (action === 'leave') {
        room = null;
        invitation = '';
        clearHeartbeat();
        clearExpiry();
        phase = 'idle';
      } else if (action === 'close') {
        applyRoom(data);
        phase = 'closed';
      } else applyRoom(data);
    });
  }

  function suspend() {
    foreground = false;
    clearHeartbeat();
    return stop('pause');
  }

  function resumePolling() {
    if (destroyed) return snapshot();
    foreground = true;
    startHeartbeat();
    poll();
    return snapshot();
  }

  function destroy() {
    if (destroyPromise) return destroyPromise;
    foreground = false;
    clearHeartbeat();
    clearExpiry();
    const paused = stop('pause');
    destroyed = true;
    destroyPromise = paused.then(() => { clearExpiry(); return snapshot(); });
    return destroyPromise;
  }

  function invitePath() {
    if (destroyed || !activeRoom() || !TOKEN.test(invitation)) return '';
    return `/pages/location-share/index?roomId=${room.roomId}&inviteToken=${invitation}`;
  }

  return { create, join, startPublishing, updateLocation, pausePublishing: () => stop('pause'),
    leave: () => stop('leave'), close: () => stop('close'), suspend, resumePolling, destroy, snapshot, invitePath };
}

module.exports = { createLocationSharing };
