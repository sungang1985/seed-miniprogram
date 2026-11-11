const EARTH_RADIUS_METERS = 6371000;

const DEFAULT_OPTIONS = Object.freeze({
  maxAccuracyMeters: 50,
  minDistanceMeters: 3,
  maxSpeedMps: 25,
  maxGapMs: 30000,
  maxPoints: 5000
});

function validCoordinate(point) {
  return point && Number.isFinite(point.latitude) && Math.abs(point.latitude) <= 90 &&
    Number.isFinite(point.longitude) && Math.abs(point.longitude) <= 180;
}

function haversineDistance(from, to) {
  if (!validCoordinate(from) || !validCoordinate(to)) return NaN;
  const radians = Math.PI / 180;
  const latitudeDelta = (to.latitude - from.latitude) * radians;
  const longitudeDelta = (to.longitude - from.longitude) * radians;
  const a = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(from.latitude * radians) * Math.cos(to.latitude * radians) *
    Math.sin(longitudeDelta / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
}

function validTime(now) {
  if (!Number.isFinite(now) || now < 0) throw new TypeError('时间必须为非负毫秒时间戳');
  return now;
}

function copyPoint(point) {
  return point ? Object.assign({}, point) : null;
}

/**
 * Pure foreground exercise state: all timestamps are supplied by the caller.
 * Distances are estimates, with known poor accuracy, drift and jumps filtered.
 * A pause or >30-second reliable-fix gap starts a separate line segment.
 */
class MotionTrack {
  constructor(options = {}) {
    this.options = Object.assign({}, DEFAULT_OPTIONS, options);
    const values = this.options;
    if (!Number.isFinite(values.maxAccuracyMeters) || values.maxAccuracyMeters <= 0 ||
        !Number.isFinite(values.minDistanceMeters) || values.minDistanceMeters < 0 ||
        !Number.isFinite(values.maxSpeedMps) || values.maxSpeedMps <= 0 ||
        !Number.isFinite(values.maxGapMs) || values.maxGapMs <= 0 ||
        !Number.isInteger(values.maxPoints) || values.maxPoints < 1) {
      throw new TypeError('轨迹过滤参数无效');
    }
    this._reset();
  }

  _reset() {
    this._status = 'idle';
    this._segments = [];
    this._distanceMeters = 0;
    this._durationMs = 0;
    this._activeSince = null;
    this._clockAt = null;
    this._lastFixAt = null;
    this._lastAcceptedPoint = null;
    this._currentLocation = null;
    this._currentSpeedMps = 0;
    this._pointCount = 0;
    this._needsNewSegment = true;
    this._limitReached = false;
    this._lastRejection = null;
  }

  _transitionTime(now) {
    validTime(now);
    this._clockAt = this._clockAt === null ? now : Math.max(now, this._clockAt);
    return this._clockAt;
  }

  _commitDuration(now) {
    if (this._activeSince !== null) {
      this._durationMs += Math.max(0, now - this._activeSince);
      this._activeSince = null;
    }
  }

  start(now = Date.now()) {
    validTime(now);
    if (this._status === 'recording' || this._status === 'paused') return this.snapshot(now);
    this._reset();
    this._status = 'recording';
    this._activeSince = this._transitionTime(now);
    return this.snapshot(now);
  }

  pause(now = Date.now()) {
    const timestamp = this._transitionTime(now);
    if (this._status === 'recording') {
      this._commitDuration(timestamp);
      this._status = 'paused';
      this._currentSpeedMps = 0;
      this._needsNewSegment = true;
    }
    return this.snapshot(timestamp);
  }

  resume(now = Date.now()) {
    const timestamp = this._transitionTime(now);
    if (this._status === 'paused') {
      this._status = 'recording';
      this._activeSince = timestamp;
      this._needsNewSegment = true;
      this._currentSpeedMps = 0;
    }
    return this.snapshot(timestamp);
  }

  finish(now = Date.now()) {
    const timestamp = this._transitionTime(now);
    if (this._status === 'recording' || this._status === 'paused') {
      this._commitDuration(timestamp);
      this._status = 'finished';
      this._currentSpeedMps = 0;
      this._needsNewSegment = true;
    }
    return this.snapshot(timestamp);
  }

  _result(accepted, reason, now, rejected = false) {
    if (rejected) this._lastRejection = reason;
    return { accepted, reason, state: this.snapshot(now) };
  }

  addLocation(location, now = Date.now()) {
    validTime(now);
    if (this._status !== 'recording') return this._result(false, 'not-recording', now);
    if (!validCoordinate(location)) return this._result(false, 'invalid-coordinate', now, true);
    const accuracy = location.accuracy === undefined || location.accuracy === null ? null : location.accuracy;
    if (accuracy !== null && (!Number.isFinite(accuracy) || accuracy < 0)) {
      return this._result(false, 'invalid-accuracy', now, true);
    }
    if (accuracy !== null && accuracy > this.options.maxAccuracyMeters) {
      return this._result(false, 'poor-accuracy', now, true);
    }
    if (now < this._activeSince || (this._lastFixAt !== null && now <= this._lastFixAt)) {
      return this._result(false, 'out-of-order', now, true);
    }

    const point = { latitude: location.latitude, longitude: location.longitude, timestamp: now, accuracy };
    const gap = this._lastFixAt !== null && now - this._lastFixAt > this.options.maxGapMs;
    const newSegment = this._needsNewSegment || gap || !this._lastAcceptedPoint;
    const distance = newSegment ? 0 : haversineDistance(this._lastAcceptedPoint, point);
    const elapsedSeconds = newSegment ? 0 : (now - this._lastAcceptedPoint.timestamp) / 1000;
    const measuredSpeed = elapsedSeconds > 0 ? distance / elapsedSeconds : 0;
    if (!newSegment && measuredSpeed > this.options.maxSpeedMps) {
      return this._result(false, 'jump', now, true);
    }

    this._clockAt = this._clockAt === null ? now : Math.max(now, this._clockAt);
    this._lastFixAt = now;
    this._currentLocation = point;
    this._lastRejection = null;
    const gpsSpeed = Number.isFinite(location.speed) && location.speed >= 0 && location.speed <= this.options.maxSpeedMps ? location.speed : null;
    if (!newSegment && distance < this.options.minDistanceMeters) {
      // Keep the accepted anchor: repeated small moves eventually cross 3m.
      this._currentSpeedMps = gpsSpeed === null ? 0 : gpsSpeed;
      return this._result(false, 'jitter', now);
    }

    if (newSegment) this._segments.push({ points: [] });
    this._segments[this._segments.length - 1].points.push(point);
    this._distanceMeters += distance;
    this._pointCount += 1;
    this._lastAcceptedPoint = point;
    this._needsNewSegment = false;
    this._currentSpeedMps = gpsSpeed === null ? measuredSpeed : gpsSpeed;
    if (this._pointCount >= this.options.maxPoints) {
      this._limitReached = true;
      this.finish(now);
      return this._result(true, 'point-limit', now);
    }
    return this._result(true, 'accepted', now);
  }

  snapshot(now = Date.now()) {
    validTime(now);
    const timestamp = this._clockAt === null ? now : Math.max(now, this._clockAt);
    const durationMs = this._durationMs + (this._activeSince === null ? 0 : Math.max(0, timestamp - this._activeSince));
    return {
      status: this._status,
      segments: this._segments.map((segment) => ({ points: segment.points.map(copyPoint) })),
      distanceMeters: this._distanceMeters,
      durationMs,
      currentSpeedMps: this._currentSpeedMps,
      averageSpeedMps: durationMs > 0 ? this._distanceMeters / (durationMs / 1000) : 0,
      pointCount: this._pointCount,
      currentLocation: copyPoint(this._currentLocation),
      limitReached: this._limitReached,
      lastRejection: this._lastRejection
    };
  }
}

module.exports = { MotionTrack, haversineDistance, DEFAULT_OPTIONS };
