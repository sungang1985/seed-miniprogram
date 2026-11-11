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

Component({
  properties: {
    latitude: { type: Number, value: DEFAULT_LATITUDE },
    longitude: { type: Number, value: DEFAULT_LONGITUDE },
    scale: { type: Number, value: 15 },
    title: { type: String, value: '深圳市民中心' },
    address: { type: String, value: '深圳市福田区福中三路' },
    height: { type: Number, value: 440 }
  },

  data: {
    centerLatitude: DEFAULT_LATITUDE,
    centerLongitude: DEFAULT_LONGITUDE,
    currentScale: 15,
    mapHeight: 440,
    markers: [],
    loading: true,
    errorMessage: '',
    mapVisible: true
  },

  observers: {
    'latitude, longitude, scale, title, address, height'() {
      if (this._attached) this._configure(false);
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
        markers: [{
          id: 1,
          latitude,
          longitude,
          title,
          iconPath: '/assets/tabbar/home-active.png',
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
        }],
        loading: true,
        errorMessage: '',
        mapVisible: true
      };
      const applyState = () => {
        if (!this._attached) return;
        this.setData(state, () => {
          if (!this._attached) return;
          if (this._ready && !this._ensureMapContext()) return;
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
    },

    onRegionChange(event) {
      if (!this._attached || !this.data.mapVisible || this.data.loading) return;
      const detail = event.detail || {};
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
      if (!this._attached || !this.data.mapVisible || Number(markerId) !== 1) return;
      this.triggerEvent('markertap', {
        markerId: 1,
        latitude: this.properties.latitude,
        longitude: this.properties.longitude,
        title: this.properties.title,
        address: this.properties.address
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
