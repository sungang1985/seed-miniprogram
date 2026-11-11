const storage = require('./storage');
const SESSION_KEY = 'session';

function getSession() {
  const session = storage.get(SESSION_KEY);
  if (!session) return null;
  if (typeof session.token !== 'string' || !session.token || !session.user ||
      !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) {
    clearSession();
    return null;
  }
  return session;
}

function setSession(session) {
  if (!session || typeof session.token !== 'string' || !session.token || !session.user ||
      !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) {
    throw new TypeError('登录态必须包含 token、user 和有效的 expiresAt');
  }
  if (!storage.set(SESSION_KEY, session, session.expiresAt - Date.now())) {
    throw new Error('无法保存登录状态，请检查存储空间');
  }
  return session;
}

function clearSession() {
  return storage.remove(SESSION_KEY);
}

function isLoggedIn() {
  return !!getSession();
}

module.exports = { getSession, setSession, clearSession, isLoggedIn };
