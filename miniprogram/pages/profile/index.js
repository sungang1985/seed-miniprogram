const api = require('../../services/api');
const config = require('../../config');
const storage = require('../../utils/storage');
const session = require('../../utils/session');

Page({
  data: {
    loggedIn: false,
    user: null,
    loading: false,
    loggingIn: false,
    profileError: '',
    environmentLabel: { develop: '开发环境', trial: '体验环境', release: '正式环境' }[config.env] || config.env,
    mock: config.mock,
    version: config.version
  },

  onShow() {
    if (this.data.loggingIn) return;
    this.applySession(session.getSession());
    this.loadProfile();
  },

  applySession(currentSession) {
    this.setData({ loggedIn: !!currentSession, user: currentSession ? currentSession.user : null });
  },

  async loadProfile() {
    const requestId = (this._profileRequestId || 0) + 1;
    this._profileRequestId = requestId;
    this.setData({ loading: true, profileError: '' });
    try {
      const profile = await api.getProfile();
      if (requestId !== this._profileRequestId) return;
      this.setData({ loggedIn: !!profile.loggedIn, user: profile.user || null });
    } catch (error) {
      if (requestId === this._profileRequestId) this.setData({ profileError: error.message || '资料加载失败，请重试' });
    } finally {
      if (requestId === this._profileRequestId) this.setData({ loading: false });
    }
  },

  async onDemoLogin() {
    if (this.data.loggingIn || !config.mock) return;
    this._profileRequestId = (this._profileRequestId || 0) + 1;
    this.setData({ loggingIn: true, loading: false, profileError: '' });
    try {
      const currentSession = await api.loginDemo();
      this._profileRequestId = (this._profileRequestId || 0) + 1;
      this.applySession(currentSession);
      wx.showToast({ title: '已进入体验账号', icon: 'success' });
    } catch (error) {
      wx.showToast({ title: error.message || '体验登录失败', icon: 'none' });
    } finally {
      this.setData({ loggingIn: false });
    }
  },

  onLogout() {
    if (this.data.loggingIn) return;
    if (api.logout() === false) {
      wx.showToast({ title: '退出失败，请重试', icon: 'none' });
      return;
    }
    this._profileRequestId = (this._profileRequestId || 0) + 1;
    this.applySession(null);
    this.setData({ loading: false, profileError: '' });
    wx.showToast({ title: config.mock ? '已退出体验账号' : '已退出登录', icon: 'none' });
  },

  onClearCache() {
    if (this.data.loggingIn) return;
    wx.showModal({
      title: '清空缓存并退出？',
      content: '将删除本小程序保存的本地缓存、最近一次运动轨迹和体验登录状态。此操作不会影响微信中的其他数据。',
      confirmText: '确认清空',
      confirmColor: '#07a66a',
      success: (result) => {
        if (!result.confirm || this.data.loggingIn) return;
        try {
          if (storage.clear() === false) throw new Error('缓存清理失败');
          this._profileRequestId = (this._profileRequestId || 0) + 1;
          this.applySession(null);
          this.setData({ loading: false, profileError: '' });
          wx.showToast({ title: '缓存已清空', icon: 'success' });
        } catch (error) {
          wx.showToast({ title: '清空失败，请重试', icon: 'none' });
        }
      }
    });
  },

  onShowGuide() {
    wx.showModal({
      title: '从起点开始',
      content: '1. 在开发者工具中打开本项目。\n2. 从 pages 目录添加业务页面。\n3. 在 config 中配置 API 并关闭 mock。\n\n更多说明请查看项目 README.md。',
      showCancel: false,
      confirmText: '我知道了',
      confirmColor: '#07a66a'
    });
  },

  onShowAbout() {
    wx.showModal({
      title: `起点 Seed · v${config.version}`,
      content: '一个轻量的微信小程序原生基础框架。\n\n体验账号仅在本地模拟，不代表微信身份认证。接入真实业务时，请通过 wx.login 和服务端换取登录态。',
      showCancel: false,
      confirmColor: '#07a66a'
    });
  }
});
