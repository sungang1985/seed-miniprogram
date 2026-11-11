const api = require('../../services/api');
const config = require('../../config');

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
    features: DEFAULT_FEATURES,
    loading: true,
    requesting: false,
    errorMessage: '',
    stats: [{ value: '03', label: '基础页面' }, { value: '03', label: '公共组件' }, { value: '0', label: '运行依赖' }],
    requestResult: ''
  },

  onLoad() {
    this.loadData();
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
