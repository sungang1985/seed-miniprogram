const api = require('../../services/api');
const config = require('../../config');
const { createTracker } = require('../../services/location-tracker');
const storage = require('../../utils/storage');

const LAST_TRACK_KEY = 'motion:last-session';

function durationText(milliseconds) {
  const seconds = Math.max(0, Math.floor((milliseconds || 0) / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((value) => String(value).padStart(2, '0')).join(':');
}

function isCoordinate(point) {
  return point && Number.isFinite(point.latitude) && Math.abs(point.latitude) <= 90 &&
    Number.isFinite(point.longitude) && Math.abs(point.longitude) <= 180;
}

function savedTrack(record) {
  const value = record && record.version === 1 && record.snapshot;
  if (!value || value.status !== 'finished' || !Array.isArray(value.segments) || value.segments.length > 5000) return null;
  if (!['distanceMeters', 'durationMs', 'currentSpeedMps', 'averageSpeedMps', 'pointCount']
    .every((key) => Number.isFinite(value[key]) && value[key] >= 0)) return null;
  let count = 0;
  for (const segment of value.segments) {
    if (!segment || !Array.isArray(segment.points)) return null;
    count += segment.points.length;
    if (count > 5000 || !segment.points.every(isCoordinate)) return null;
  }
  if (!count || count !== value.pointCount || !isCoordinate(value.currentLocation)) return null;
  return Object.assign({}, value, {
    status: 'finished', currentSpeedMps: 0, waitingForLocation: false,
    errorMessage: '', errorCode: '', nativeStopFailed: false
  });
}

const DEFAULT_FEATURES = [
  { id: 'request', title: '请求封装', description: '统一入口，轻松连接服务', symbol: '↗', tone: 'green' },
  { id: 'component', title: '公共组件', description: '复用细节，保持体验一致', symbol: '▦', tone: 'purple' },
  { id: 'storage', title: '本地缓存', description: '持久存储，让状态有记忆', symbol: '▤', tone: 'blue' },
  { id: 'session', title: '登录状态', description: '会话管理，做好每个起步', symbol: '⌘', tone: 'orange' }
];

Page({
  data: {
    version: config.version,
    environmentLabel: { develop: '开发环境', trial: '体验环境', release: '正式环境' }[config.env] || config.env,
    mock: config.mock,
    // Native maps use GCJ-02 coordinates. Replace this example with your own place.
    mapLocation: {
      latitude: 22.543096,
      longitude: 114.057865,
      scale: 15,
      title: '深圳市民中心',
      address: '广东省深圳市福田区福中三路'
    },
    track: {
      status: 'idle', statusLabel: '尚未开始', distanceText: '0.00', durationText: '00:00:00',
      speedText: '0.0', averageSpeedText: '0.0', pointCount: 0, accuracyText: '--',
      errorMessage: '', hint: '点击开始记录后，实时绘制自己的运动轨迹', hasLocation: false,
      saveMessage: '', canOpenSettings: false, nativeStopFailed: false
    },
    trackPolyline: [],
    trackLocation: null,
    trackActive: false,
    features: DEFAULT_FEATURES,
    loading: true,
    requesting: false,
    errorMessage: '',
    stats: [{ value: '03', label: '基础页面' }, { value: '03', label: '公共组件' }, { value: '0', label: '运行依赖' }],
    requestResult: ''
  },

  onLoad() {
    this.initMotionTracking();
    this.loadData();
  },

  initMotionTracking() {
    if (this._tracker) return;
    this._motionDisposed = false;
    this._lastTrackStatus = 'idle';
    this._tracker = createTracker({ onChange: (snapshot) => this.applyTrackSnapshot(snapshot) });
    const previous = savedTrack(storage.get(LAST_TRACK_KEY));
    if (previous) {
      this._restoringTrack = true;
      this.applyTrackSnapshot(previous);
      this._restoringTrack = false;
      this.setData({ 'track.hint': '显示上次完成的运动轨迹，点击开始新记录即可继续运动' });
    } else {
      this.applyTrackSnapshot(this._tracker.snapshot());
    }
  },

  applyTrackSnapshot(snapshot) {
    if (this._motionDisposed || !snapshot) return;
    const status = snapshot.status;
    const labels = { idle: '尚未开始', starting: '开启定位中', recording: '记录中', paused: '已暂停', finished: '已结束' };
    const position = isCoordinate(snapshot.currentLocation) ? snapshot.currentLocation : null;
    const previousStatus = this._lastTrackStatus;
    const hints = {
      idle: '点击开始记录后，实时绘制自己的运动轨迹',
      starting: '正在申请定位权限并开启位置更新',
      recording: snapshot.waitingForLocation ? '正在等待有效定位，请到开阔处稍候' : '正在实时记录，离开首页或切到后台将自动暂停',
      paused: '记录已暂停，点击继续后从新的位置接着记录',
      finished: snapshot.limitReached ? '本次已达到 5000 个轨迹点，记录已结束' : '本次运动已结束，轨迹仅保存在本机'
    };
    const track = {
      status,
      statusLabel: status === 'recording' && snapshot.waitingForLocation ? '等待定位' : labels[status] || '尚未开始',
      distanceText: ((snapshot.distanceMeters || 0) / 1000).toFixed(2),
      durationText: durationText(snapshot.durationMs),
      speedText: ((snapshot.currentSpeedMps || 0) * 3.6).toFixed(1),
      averageSpeedText: ((snapshot.averageSpeedMps || 0) * 3.6).toFixed(1),
      pointCount: snapshot.pointCount || 0,
      accuracyText: position && Number.isFinite(position.accuracy) ? `± ${Math.round(position.accuracy)} m` : '--',
      errorMessage: snapshot.errorMessage || '',
      hint: hints[status] || hints.idle,
      hasLocation: !!position,
      nativeStopFailed: !!snapshot.nativeStopFailed,
      canOpenSettings: /AUTH|PERMISSION/.test(snapshot.errorCode || ''),
      saveMessage: status === 'finished' && previousStatus === 'finished' ? this.data.track.saveMessage : ''
    };
    const trackActive = status === 'recording' ? !snapshot.waitingForLocation || !position : status === 'starting' && !position;
    const patch = { track };
    if (trackActive !== this.data.trackActive) patch.trackActive = trackActive;
    const segments = snapshot.segments || [];
    const firstPoint = segments.length && segments[0].points && segments[0].points[0];
    const routeStamp = `${track.pointCount}:${segments.length}:${firstPoint ? firstPoint.timestamp : ''}`;
    if (routeStamp !== this._lastRouteStamp) {
      patch.trackPolyline = segments.filter((segment) => segment.points && segment.points.length > 1).map((segment) => ({
        points: segment.points.map((point) => ({ latitude: point.latitude, longitude: point.longitude })),
        color: '#07a66a', width: 5, borderColor: '#ffffff', borderWidth: 1
      }));
      this._lastRouteStamp = routeStamp;
    }
    const locationStamp = position ? `${position.latitude}:${position.longitude}:${position.timestamp}:${position.accuracy}` : '';
    if (locationStamp !== this._lastLocationStamp) {
      patch.trackLocation = position;
      this._lastLocationStamp = locationStamp;
    }
    this._lastTrackStatus = status;
    this.setData(patch);
    if (status === 'finished' && previousStatus !== 'finished' && !this._restoringTrack) {
      if (!track.pointCount) {
        this.setData({ 'track.saveMessage': '本次没有可保存的定位点' });
      } else {
        const success = storage.set(LAST_TRACK_KEY, { version: 1, snapshot, savedAt: Date.now() });
        this.setData({ 'track.saveMessage': success ? '本次轨迹已保存到本机' : '轨迹未能保存，请暂时保留当前页面' });
        if (!success) wx.showToast({ title: '轨迹保存失败', icon: 'none' });
      }
    }
  },

  async runTrackAction(action) {
    this.initMotionTracking();
    try {
      const snapshot = await this._tracker[action]();
      if (!this._motionDisposed) this.applyTrackSnapshot(snapshot);
    } catch (error) {
      if (!this._motionDisposed) wx.showToast({ title: '操作未完成，请重试', icon: 'none' });
    }
  },

  onStartTrack() {
    this._lastRouteStamp = null;
    return this.runTrackAction('start');
  },

  onNewTrack() {
    return this.onStartTrack();
  },

  onPauseTrack() {
    return this.runTrackAction('pause');
  },

  onResumeTrack() {
    return this.runTrackAction('resume');
  },

  onFinishTrack() {
    return this.runTrackAction('finish');
  },

  onOpenLocationSettings() {
    wx.openSetting({ success: () => wx.showToast({ title: '设置完成后点击继续记录', icon: 'none' }) });
  },

  onHide() {
    if (!this._tracker) return;
    const state = this._tracker.snapshot();
    if (state.status === 'starting' || state.status === 'recording') {
      return this._tracker.pause('已离开首页，记录已暂停；回到首页后可继续');
    }
  },

  onUnload() {
    this._motionDisposed = true;
    if (this._tracker) return this._tracker.destroy();
  },

  onPullDownRefresh() {
    this.loadData().finally(() => wx.stopPullDownRefresh());
  },

  async loadData() {
    this.setData({ loading: true, errorMessage: '' });
    try {
      const results = await Promise.all([api.getOverview(), api.getFeatures()]);
      const features = Array.isArray(results[1]) ? results[1] : DEFAULT_FEATURES;
      this.setData({
        stats: results[0] && Array.isArray(results[0].stats) ? results[0].stats : this.data.stats,
        features: features.map((item, index) => Object.assign({}, DEFAULT_FEATURES[index % DEFAULT_FEATURES.length], item)),
        loading: false
      });
    } catch (error) {
      this.setData({ loading: false, errorMessage: error.message || '加载失败，请稍后重试' });
    }
  },

  onRetry() {
    this.loadData();
  },

  onOpenComponents() {
    wx.switchTab({ url: '/pages/components/index' });
  },

  onMapMarkerTap(event) {
    wx.showToast({ title: event.detail.title || this.data.mapLocation.title, icon: 'none' });
  },

  async onTestRequest() {
    if (this.data.requesting) return;
    this.setData({ requesting: true, requestResult: '' });
    const startedAt = Date.now();
    try {
      await api.getOverview();
      this.setData({ requestResult: `请求成功 · 耗时 ${Date.now() - startedAt} ms` });
      wx.showToast({ title: '请求成功', icon: 'success' });
    } catch (error) {
      this.setData({ requestResult: error.message || '请求失败，请稍后重试' });
      wx.showToast({ title: '请求失败，请重试', icon: 'none' });
    } finally {
      this.setData({ requesting: false });
    }
  },

  onCopyPath() {
    wx.setClipboardData({ data: 'miniprogram/pages/home/index' });
  }
});
