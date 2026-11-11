const DEFAULT_LATITUDE = 22.543096;
const DEFAULT_LONGITUDE = 114.057865;
const MIN_SCALE = 3;
const MAX_SCALE = 20;
const READY_TIMEOUT = 12000;

function validCoordinate(latitude, longitude) {
  return Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 &&
    Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
}

function clampScale(value) {
  return Number.isFinite(value) ? Math.max(MIN_SCALE, Math.min(MAX_SCALE, value)) : 15;
}

function validLocation(location) {
  return location && validCoordinate(location.latitude, location.longitude);
}

function placeMarker(id, latitude, longitude, title, live) {
  return {
    id,
    latitude,
    longitude,
    title,
    iconPath: live ? '/assets/tabbar/profile-active.png' : '/assets/tabbar/home-active.png',
    width: 28,
    height: 28,
    anchor: { x: 0.5, y: 0.5 },
    callout: {
      content: title || '示例地点',
      display: 'ALWAYS',
      color: '#24533e',
      bgColor: '#ffffff',
      fontSize: 13,
      borderRadius: 8,
      padding: 9
    }
  };
}

Component({
  properties: {
    latitude: { type: Number, value: DEFAULT_LATITUDE },
    longitude: { type: Number, value: DEFAULT_LONGITUDE },
    scale: { type: Number, value: 15 },
    title: { type: String, value: '深圳市民中心' },
    address: { type: String, value: '深圳市福田区福中三路' },
    height: { type: Number, value: 440 },
    polyline: { type: Array, value: [] },
    liveLocation: { type: Object, value: null },
    tracking: { type: Boolean, value: false },
    extraMarkers: { type: Array, value: [] }
  },

  data: {
    centerLatitude: DEFAULT_LATITUDE,
    centerLongitude: DEFAULT_LONGITUDE,
    currentScale: 15,
    mapHeight: 440,
    markers: [],
    mapPolyline: [],
    hasLiveLocation: false,
    following: true,
    displayTitle: '深圳市民中心',
    displayAddress: '深圳市福田区福中三路',
    placeTag: '示例地点',
    recenterLabel: '回到起点',
    followMessage: '',
    loading: true,
    errorMessage: '',
    mapVisible: true
  },

  observers: {
    'latitude, longitude, scale, title, address, height'() {
      if (this._attached) this._configure(false);
    },
    'polyline, liveLocation, tracking, extraMarkers'() {
      if (this._attached) this._applyTrackData();
    }
  },

  lifetimes: {
    attached() {
      this._attached = true;
      this._configure(false);
    },
    ready() {
      this._ready = true;
      if (this.data.mapVisible) this._ensureMapContext();
    },
    detached() {
      this._attached = false;
      this._ready = false;
      this._stopReadyTimer();
      this._mapContext = null;
      this._followRequest = (this._followRequest || 0) + 1;
    }
  },

  methods: {
    _stopReadyTimer() {
      if (this._readyTimer) clearTimeout(this._readyTimer);
      this._readyTimer = null;
    },

    _armReadyTimer() {
      this._stopReadyTimer();
      if (!this._attached || this._renderReady) return;
      this._readyTimer = setTimeout(() => {
        this._readyTimer = null;
        if (this._attached && !this._renderReady) {
          this._reportError('地图加载超时，请检查网络后重试', 'MAP_TIMEOUT');
        }
      }, READY_TIMEOUT);
    },

    _reportError(message, code) {
      if (!this._attached) return;
      this._stopReadyTimer();
      this._mapContext = null;
      this.setData({ loading: false, errorMessage: message, mapVisible: false });
      this.triggerEvent('error', { message, code });
    },

    _ensureMapContext() {
      if (this._mapContext) return this._mapContext;
      try {
        this._mapContext = wx.createMapContext('location-map', this);
        if (!this._mapContext || typeof this._mapContext.moveToLocation !== 'function') {
          throw new Error('Map context unavailable');
        }
        return this._mapContext;
      } catch (error) {
        this._mapContext = null;
        this._reportError('地图暂时不可用，请稍后重试', 'MAP_UNAVAILABLE');
        return null;
      }
    },

    _configure(remount) {
      const { latitude, longitude, title, height } = this.properties;
      const currentScale = clampScale(this.properties.scale);
      const mapHeight = Number.isFinite(height) && height > 0 ? Math.max(160, Math.min(1000, height)) : 440;
      const previous = this._configuredNative;
      // Address and height do not require a new native render-ready cycle.
      if (!remount && this.data.mapVisible && previous &&
          previous.latitude === latitude && previous.longitude === longitude &&
          previous.scale === currentScale && previous.title === title) {
        if (this.data.mapHeight !== mapHeight) this.setData({ mapHeight });
        this._applyTrackData();
        return;
      }
      this._renderVersion = (this._renderVersion || 0) + 1;
      this._stopReadyTimer();
      this._renderReady = false;
      if (!validCoordinate(latitude, longitude)) {
        this._reportError('地图坐标无效，请检查经纬度配置', 'INVALID_COORDINATES');
        return;
      }
      this._configuredNative = { latitude, longitude, scale: currentScale, title };
      const state = {
        centerLatitude: latitude,
        centerLongitude: longitude,
        currentScale,
        mapHeight,
        markers: [placeMarker(1, latitude, longitude, title, false)],
        loading: true,
        errorMessage: '',
        mapVisible: true
      };
      const applyState = () => {
        if (!this._attached) return;
        this.setData(state, () => {
          if (!this._attached) return;
          if (this._ready && !this._ensureMapContext()) return;
          this._lastFollowedKey = null;
          this._applyTrackData();
          this._armReadyTimer();
        });
      };
      if (remount) {
        this._mapContext = null;
        this.setData({ mapVisible: false }, applyState);
      } else {
        applyState();
      }
    },

    _applyTrackData() {
      if (!this._attached) return;
      const { liveLocation, tracking, title, address, latitude, longitude } = this.properties;
      const hasLiveLocation = !!validLocation(liveLocation);
      const hadLiveLocation = this.data.hasLiveLocation;
      const following = !hasLiveLocation || (tracking && !this._wasTracking) ? true : this.data.following;
      this._wasTracking = tracking;
      const mapPolyline = (Array.isArray(this.properties.polyline) ? this.properties.polyline : [])
        .filter((line) => line && Array.isArray(line.points) && line.points.length >= 2 &&
          line.points.every((point) => validLocation(point)))
        .map((line) => Object.assign({ color: '#07a66a', width: 6, arrowLine: true }, line, {
          points: line.points.map((point) => ({ latitude: point.latitude, longitude: point.longitude }))
        }));
      const liveTitle = tracking ? '我的位置' : '最后记录位置';
      const peers = (Array.isArray(this.properties.extraMarkers) ? this.properties.extraMarkers : [])
        .filter((marker) => marker && Number.isInteger(marker.id) && marker.id >= 100 && validLocation(marker));
      const ownMarkers = hasLiveLocation ? [placeMarker(2, liveLocation.latitude, liveLocation.longitude, liveTitle, true)] :
        (tracking ? [] : [placeMarker(1, latitude, longitude, title, false)]);
      const patch = {
        mapPolyline,
        hasLiveLocation,
        following,
        markers: ownMarkers.concat(peers),
        displayTitle: hasLiveLocation ? liveTitle : (tracking ? '等待你的位置' : (title || '示例地点')),
        displayAddress: hasLiveLocation ?
          (tracking ? '轨迹随你移动，实时绘制' : '本次运动的最后记录位置') :
          (tracking ? '收到定位后开始绘制真实运动轨迹' : address),
        placeTag: hasLiveLocation ? (tracking ? '运动轨迹' : '已记录') : (tracking ? '等待定位' : '示例地点'),
        recenterLabel: hasLiveLocation ? (following ? (tracking ? '跟随我' : '查看最后位置') : '恢复跟随') : '回到起点'
      };
      if (!hasLiveLocation) {
        this._followRequest = (this._followRequest || 0) + 1;
        this._lastFollowedKey = null;
        patch.followMessage = '';
      } else if (!this._renderReady && following) {
        patch.centerLatitude = liveLocation.latitude;
        patch.centerLongitude = liveLocation.longitude;
      }
      this.setData(patch, () => {
        if (hadLiveLocation && !hasLiveLocation && !tracking) this.onRecenter();
        else this._followLive(false);
      });
    },

    _followLive(force) {
      const point = this.properties.liveLocation;
      if (!this._attached || !this.data.mapVisible || this.data.loading || !this.data.following || !validLocation(point)) return;
      const key = point.latitude + ',' + point.longitude;
      if (!force && this._lastFollowedKey === key) return;
      const context = this._ensureMapContext();
      if (!context) return;
      this._lastFollowedKey = key;
      const version = this._renderVersion;
      const request = (this._followRequest || 0) + 1;
      this._followRequest = request;
      const fail = () => {
        if (!this._attached || version !== this._renderVersion || request !== this._followRequest) return;
        this._lastFollowedKey = null;
        this.setData({ following: false, recenterLabel: '恢复跟随', followMessage: '暂时无法跟随，请点击恢复跟随' });
        this.triggerEvent('error', { code: 'MAP_FOLLOW_FAILED', message: '暂时无法跟随当前位置' });
      };
      try {
        context.moveToLocation({ latitude: point.latitude, longitude: point.longitude, fail });
      } catch (error) {
        fail();
      }
    },

    onMapUpdated() {
      if (!this._attached || !this.data.mapVisible || this._renderReady) return;
      this._renderReady = true;
      this._stopReadyTimer();
      this.setData({ loading: false, errorMessage: '' });
      this.triggerEvent('ready', {
        latitude: this.data.centerLatitude,
        longitude: this.data.centerLongitude,
        scale: this.data.currentScale
      });
      this._followLive(false);
    },

    onRegionChange(event) {
      if (!this._attached || !this.data.mapVisible || this.data.loading) return;
      const detail = event.detail || {};
      const causedBy = detail.causedBy || event.causedBy;
      if (this.data.hasLiveLocation && (causedBy === 'gesture' || causedBy === 'drag')) {
        this._followRequest = (this._followRequest || 0) + 1;
        this.setData({ following: false, recenterLabel: '恢复跟随', followMessage: '' });
      }
      if ((detail.type || event.type) !== 'end') return;
      const version = this._renderVersion;
      const applyScale = (scale) => {
        if (!this._attached || !this.data.mapVisible || version !== this._renderVersion || !Number.isFinite(scale)) return;
        const currentScale = clampScale(scale);
        if (currentScale !== this.data.currentScale) this.setData({ currentScale });
      };
      if (Number.isFinite(detail.scale)) {
        applyScale(detail.scale);
        return;
      }
      // Older base libraries omit scale from regionchange details.
      const context = this._mapContext;
      if (context && typeof context.getScale === 'function') {
        try {
          context.getScale({ success: (result) => applyScale(result.scale) });
        } catch (error) {
          // A failed scale read does not make an otherwise usable map fail.
        }
      }
    },

    onMarkerTap(event) {
      const markerId = event.detail && event.detail.markerId;
      if (!this._attached || !this.data.mapVisible) return;
      const peer = this.data.markers.find((marker) => marker.id >= 100 && marker.id === Number(markerId));
      if (peer) {
        this.triggerEvent('markertap', { markerId: peer.id, latitude: peer.latitude, longitude: peer.longitude, title: peer.title, address: '好友共享位置' });
        return;
      }
      const live = this.properties.liveLocation;
      const isLiveMarker = this.data.hasLiveLocation && Number(markerId) === 2;
      if (!this._attached || !this.data.mapVisible || (!isLiveMarker && Number(markerId) !== 1)) return;
      if (Number(markerId) === 1 && (this.data.hasLiveLocation || this.properties.tracking)) return;
      this.triggerEvent('markertap', {
        markerId: isLiveMarker ? 2 : 1,
        latitude: isLiveMarker ? live.latitude : this.properties.latitude,
        longitude: isLiveMarker ? live.longitude : this.properties.longitude,
        title: isLiveMarker ? this.data.displayTitle : this.properties.title,
        address: isLiveMarker ? this.data.displayAddress : this.properties.address
      });
    },

    onZoomIn() {
      if (!this._attached || !this.data.mapVisible || this.data.loading) return;
      this.setData({ currentScale: clampScale(this.data.currentScale + 1) });
    },

    onZoomOut() {
      if (!this._attached || !this.data.mapVisible || this.data.loading) return;
      this.setData({ currentScale: clampScale(this.data.currentScale - 1) });
    },

    onRecenter() {
      if (!this._attached || !this.data.mapVisible || this.data.loading) return;
      if (validLocation(this.properties.liveLocation)) {
        this.setData({ following: true, recenterLabel: this.properties.tracking ? '跟随我' : '查看最后位置', followMessage: '' }, () => this._followLive(true));
        return;
      }
      const context = this._ensureMapContext();
      if (!context) return;
      const version = this._renderVersion;
      try {
        // Always supply both coordinates: this never asks for the user's position.
        context.moveToLocation({
          latitude: this.properties.latitude,
          longitude: this.properties.longitude,
          fail: () => {
            if (version === this._renderVersion) this._reportError('暂时无法回到示例地点，请重试', 'MAP_RECENTER_FAILED');
          }
        });
      } catch (error) {
        this._reportError('暂时无法回到示例地点，请重试', 'MAP_RECENTER_FAILED');
      }
    },

    onRetry() {
      if (!this._attached) return;
      this._configure(true);
    }
  }
});
