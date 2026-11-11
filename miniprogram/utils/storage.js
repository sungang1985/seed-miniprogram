const config = require('../config/index');
const FORMAT_VERSION = 1;

function keyFor(key) {
  return config.storagePrefix + key;
}

/** 空值、过期、损坏以及读取失败均返回 fallback，避免阻断页面启动。 */
function get(key, fallback = null) {
  try {
    const item = wx.getStorageSync(keyFor(key));
    if (item === '' || item === undefined || item === null) return fallback;
    if (typeof item !== 'object' || item.version !== FORMAT_VERSION || !Object.prototype.hasOwnProperty.call(item, 'value')) {
      remove(key);
      return fallback;
    }
    if (!Number.isFinite(item.expiresAt) || item.expiresAt < 0 || (item.expiresAt > 0 && item.expiresAt <= Date.now())) {
      remove(key);
      return fallback;
    }
    return item.value;
  } catch (error) {
    return fallback;
  }
}

/** ttlMs 为 0 时不自动过期；返回是否成功写入。 */
function set(key, value, ttlMs = 0) {
  if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new TypeError('缓存有效期必须为非负毫秒数');
  try {
    wx.setStorageSync(keyFor(key), {
      version: FORMAT_VERSION,
      value,
      expiresAt: ttlMs ? Date.now() + ttlMs : 0
    });
    return true;
  } catch (error) {
    return false;
  }
}

function remove(key) {
  try {
    wx.removeStorageSync(keyFor(key));
    return true;
  } catch (error) {
    return false;
  }
}

/** 只清除本项目的缓存，不影响同一客户端中的其他业务数据。 */
function clear() {
  try {
    const keys = wx.getStorageInfoSync().keys;
    keys.filter((key) => key.indexOf(config.storagePrefix) === 0)
      .forEach((key) => wx.removeStorageSync(key));
    return true;
  } catch (error) {
    return false;
  }
}

module.exports = { get, set, remove, clear };
