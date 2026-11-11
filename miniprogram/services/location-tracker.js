const { MotionTrack } = require('../utils/motion');

// WeChat's native location stream is shared by every Page in the mini program.
// A disposed Page must finish its pending native startup/cleanup before a new
// controller can own that stream.
let nativeOwner = null;

function serviceError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Foreground recording only. Constructing this service never starts location APIs. */
function createTracker(options = {}) {
  const platform = options.wx || wx;
  const now = options.now || Date.now;
  const clock = Object.assign({ setTimeout, clearTimeout, setInterval, clearInterval }, options.timers);
  const onChange = options.onChange || (() => {});
  const firstFixTimeoutMs = options.firstFixTimeoutMs || 20000;
  const staleFixTimeoutMs = options.staleFixTimeoutMs || 30000;
  let engine = new MotionTrack(options.motionOptions);
  let status = 'idle';
  let errorMessage = '';
  let errorCode = '';
  let waitingForLocation = false;
  let nativeStopFailed = false;
  let generation = 0;
  let destroyed = false;
  let nativeActive = false;
  let sessionStarted = false;
  let locationHandler = null;
  let locationErrorHandler = null;
  let pendingFix = null;
  let tickTimer = null;
  let fixTimer = null;
  let queue = Promise.resolve();
  let pendingStart = null;
  let destroyPromise = null;
  const owner = { isDestroyed: () => destroyed, cleanup: () => enqueue(stopNative) };

  function snapshot() {
    return Object.assign(engine.snapshot(now()), {
      status, errorMessage, errorCode, waitingForLocation, nativeStopFailed
    });
  }

  function emit() {
    if (!destroyed) onChange(snapshot());
  }

  function enqueue(operation) {
    const next = queue.then(operation, operation);
    queue = next.catch(() => {});
    return next;
  }

  function call(method, args = {}) {
    return new Promise((resolve, reject) => {
      try {
        platform[method](Object.assign({}, args, { success: resolve, fail: reject }));
      } catch (error) {
        reject(error);
      }
    });
  }

  function valid(token) {
    return !destroyed && token === generation;
  }

  function clearTimers() {
    if (tickTimer !== null) clock.clearInterval(tickTimer);
    if (fixTimer !== null) clock.clearTimeout(fixTimer);
    tickTimer = null;
    fixTimer = null;
  }

  function detachListeners() {
    if (locationHandler) {
      try { platform.offLocationChange(locationHandler); } catch (error) { /* Token checks still discard callbacks. */ }
    }
    if (locationErrorHandler && typeof platform.offLocationChangeError === 'function') {
      try { platform.offLocationChangeError(locationErrorHandler); } catch (error) { /* Ignore stale events. */ }
    }
    locationHandler = null;
    locationErrorHandler = null;
    pendingFix = null;
  }

  async function stopNative() {
    if (!nativeActive) {
      const previous = nativeOwner;
      if (previous && previous !== owner && previous.isDestroyed()) {
        const stopped = await previous.cleanup();
        nativeStopFailed = !stopped;
        if (!stopped) {
          errorMessage = '上次定位未成功关闭，请稍后重试结束记录或重新打开小程序';
          errorCode = 'LOCATION_STOP_FAILED';
          emit();
        }
        return stopped;
      }
      return true;
    }
    try {
      await call('stopLocationUpdate');
      nativeActive = false;
      if (nativeOwner === owner) nativeOwner = null;
      nativeStopFailed = false;
      return true;
    } catch (error) {
      nativeStopFailed = true;
      errorMessage = '已停止记录并移除监听，但系统定位未成功关闭，请重试结束记录';
      errorCode = 'LOCATION_STOP_FAILED';
      emit();
      return false;
    }
  }

  async function releasePreviousOwner(token) {
    const previous = nativeOwner;
    if (!previous || previous === owner) return valid(token);
    if (!previous.isDestroyed()) {
      throw serviceError('另一个运动记录仍在进行，请结束后重试', 'LOCATION_IN_USE');
    }
    if (!(await previous.cleanup())) {
      nativeStopFailed = true;
      throw serviceError('上次定位尚未成功关闭，请稍后继续重试或重新打开小程序', 'LOCATION_CLEANUP_FAILED');
    }
    nativeStopFailed = false;
    return valid(token);
  }

  function armFixTimer(token) {
    if (fixTimer !== null) clock.clearTimeout(fixTimer);
    fixTimer = clock.setTimeout(() => {
      if (!valid(token) || status !== 'recording') return;
      const message = waitingForLocation ? '暂未获取到有效位置，已暂停；请到开阔处后继续' : '定位信号中断，已暂停记录，请检查定位后继续';
      pauseInternal(message, 'LOCATION_TIMEOUT');
    }, waitingForLocation ? firstFixTimeoutMs : staleFixTimeoutMs);
  }

  function consumeLocation(fix, token) {
    if (!valid(token) || status !== 'recording') return;
    const result = engine.addLocation(fix, now());
    if (result.reason === 'accepted' || result.reason === 'jitter') {
      waitingForLocation = false;
      armFixTimer(token);
    }
    if (result.state.limitReached) {
      generation += 1;
      status = 'finished';
      errorMessage = '本次记录已达到轨迹点上限，已自动结束';
      errorCode = 'TRACK_POINT_LIMIT';
      waitingForLocation = false;
      clearTimers();
      detachListeners();
      enqueue(stopNative);
    }
    emit();
  }

  function pauseInternal(reason = '', code = '') {
    if (destroyed) return Promise.resolve(snapshot());
    generation += 1;
    clearTimers();
    detachListeners();
    if (status === 'recording') engine.pause(now());
    if (status !== 'finished' && status !== 'idle') status = 'paused';
    waitingForLocation = false;
    errorMessage = reason;
    errorCode = code;
    emit();
    return enqueue(async () => {
      await stopNative();
      emit();
      return snapshot();
    });
  }

  async function authorize(token) {
    if (typeof platform.requirePrivacyAuthorize === 'function') {
      try { await call('requirePrivacyAuthorize'); } catch (error) {
        throw serviceError('未同意隐私保护指引，无法开始运动记录', 'PRIVACY_DENIED');
      }
    }
    if (!valid(token)) return;
    try { await call('authorize', { scope: 'scope.userLocation' }); } catch (error) {
      throw serviceError('未获得定位权限，请在设置中允许定位后继续', 'LOCATION_PERMISSION_DENIED');
    }
  }

  function begin(newSession) {
    if (destroyed) return Promise.resolve(snapshot());
    if (status === 'starting') return pendingStart || Promise.resolve(snapshot());
    if (status === 'recording') return Promise.resolve(snapshot());
    const token = ++generation;
    if (newSession) {
      engine = new MotionTrack(options.motionOptions);
      sessionStarted = false;
    }
    status = 'starting';
    errorMessage = '';
    errorCode = '';
    waitingForLocation = false;
    emit();
    pendingStart = enqueue(async () => {
      if (!valid(token)) return snapshot();
      try {
        const required = ['authorize', 'startLocationUpdate', 'stopLocationUpdate', 'onLocationChange', 'offLocationChange'];
        if (required.some((name) => typeof platform[name] !== 'function')) {
          throw serviceError('当前微信版本不支持持续定位，请升级后重试', 'LOCATION_UNSUPPORTED');
        }
        if (!(await releasePreviousOwner(token))) return snapshot();
        if (nativeActive && !(await stopNative())) {
          if (valid(token)) status = 'paused';
          emit();
          return snapshot();
        }
        await authorize(token);
        if (!valid(token)) return snapshot();
        if (!(await releasePreviousOwner(token))) return snapshot();
        // Awaited cleanup can let another fresh controller acquire the stream.
        // The final ownership check and assignment must remain synchronous.
        if (nativeOwner && nativeOwner !== owner) {
          throw serviceError('另一个运动记录仍在进行，请结束后重试', 'LOCATION_IN_USE');
        }
        nativeOwner = owner;
        locationHandler = (fix) => {
          if (!valid(token)) return;
          if (status === 'starting') pendingFix = fix;
          else consumeLocation(fix, token);
        };
        platform.onLocationChange(locationHandler);
        if (typeof platform.onLocationChangeError === 'function' && typeof platform.offLocationChangeError === 'function') {
          locationErrorHandler = () => {
            if (valid(token)) pauseInternal('定位发生异常，已暂停，请检查定位权限或信号后继续', 'LOCATION_STREAM_ERROR');
          };
          platform.onLocationChangeError(locationErrorHandler);
        }
        await call('startLocationUpdate', { type: 'gcj02' });
        nativeActive = true;
        if (!valid(token)) {
          await stopNative();
          return snapshot();
        }
        if (sessionStarted) engine.resume(now());
        else {
          engine.start(now());
          sessionStarted = true;
        }
        status = 'recording';
        errorMessage = '';
        errorCode = '';
        waitingForLocation = true;
        armFixTimer(token);
        tickTimer = clock.setInterval(() => {
          if (valid(token) && status === 'recording') emit();
        }, 1000);
        const first = pendingFix;
        pendingFix = null;
        if (first) consumeLocation(first, token);
        else emit();
      } catch (error) {
        if (!nativeActive && nativeOwner === owner) nativeOwner = null;
        if (valid(token)) {
          generation += 1;
          clearTimers();
          detachListeners();
          status = 'paused';
          errorMessage = error.code ? error.message : '无法开启定位，请检查微信权限及定位接口配置后重试';
          errorCode = error.code || 'LOCATION_START_FAILED';
          waitingForLocation = false;
          emit();
        }
      }
      return snapshot();
    });
    return pendingStart;
  }

  function finish() {
    if (destroyed) return Promise.resolve(snapshot());
    generation += 1;
    clearTimers();
    detachListeners();
    engine.finish(now());
    status = 'finished';
    waitingForLocation = false;
    errorMessage = '';
    errorCode = '';
    emit();
    return enqueue(async () => {
      await stopNative();
      emit();
      return snapshot();
    });
  }

  function destroy() {
    if (destroyPromise) return destroyPromise;
    generation += 1;
    clearTimers();
    detachListeners();
    if (status === 'recording') engine.pause(now());
    if (status === 'recording' || status === 'starting') status = 'paused';
    waitingForLocation = false;
    destroyed = true;
    destroyPromise = enqueue(async () => {
      await stopNative();
      return snapshot();
    });
    return destroyPromise;
  }

  return {
    snapshot,
    start: () => begin(true),
    resume: () => begin(false),
    pause: (reason) => pauseInternal(reason),
    finish,
    destroy
  };
}

module.exports = { createTracker };
