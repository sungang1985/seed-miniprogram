const config = require('../config/index');
const http = require('./request');
const session = require('../utils/session');

function mock(value) {
  return new Promise((resolve) => setTimeout(() => resolve(value), 200));
}

function getOverview() {
  if (!config.mock) return http.get('/overview');
  return mock({
    name: '起点',
    greeting: '让想法，从这里开始',
    subtitle: '从一个好起点，构建你的小程序。',
    environment: config.env,
    version: config.version,
    description: '从一个好起点，构建你的小程序。',
    status: 'ready',
    stats: [
      { label: '基础页面', value: '03' },
      { label: '公共组件', value: '02' },
      { label: '运行依赖', value: '0' }
    ]
  });
}

function getFeatures() {
  if (!config.mock) return http.get('/features');
  return mock([
    { status: 'ready', id: 'request', title: '网络请求', description: '统一请求、错误处理与登录凭证', icon: '↗' },
    { status: 'ready', id: 'storage', title: '本地缓存', description: '命名空间隔离，支持过期时间', icon: '▤' },
    { status: 'ready', id: 'session', title: '登录状态', description: '持久化会话与失效清理', icon: '◎' },
    { status: 'ready', id: 'config', title: '环境配置', description: '开发、体验、正式环境自动识别', icon: '⌘' },
    { status: 'ready', id: 'navigation', title: '页面导航', description: '原生 Tab 导航与页面路由', icon: '→' },
    { status: 'ready', id: 'components', title: '公共组件', description: '复用按钮、卡片和状态展示', icon: '▦' }
  ]);
}

function getProfile() {
  if (!config.mock) return http.get('/profile');
  const current = session.getSession();
  return mock({
    loggedIn: !!current,
    user: current ? current.user : null,
    environment: config.env,
    version: config.version
  });
}

/** 仅用于演示 UI，不能作为生产登录方案。真实登录须由后端交换 wx.login code。 */
function loginDemo() {
  if (!config.mock) return Promise.reject(new Error('当前环境未开启演示登录，请接入微信登录接口'));
  const value = {
    token: 'demo-session-not-for-production',
    user: { id: 'demo-user', nickname: '体验用户', avatarText: '起' },
    expiresAt: Date.now() + 24 * 60 * 60 * 1000
  };
  return mock(null).then(() => session.setSession(value));
}

function logout() {
  return session.clearSession();
}

module.exports = { getOverview, getFeatures, getProfile, loginDemo, logout };
