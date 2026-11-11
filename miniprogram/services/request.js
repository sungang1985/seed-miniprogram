const config = require('../config/index');
const session = require('../utils/session');

class RequestError extends Error {
  constructor(message, code, statusCode = 0) {
    super(message);
    this.name = 'RequestError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function isUnauthorized(code) {
  return code === 401 || code === '401';
}

function originOf(url) {
  const match = /^https:\/\/([^/?#]+)/i.exec(url || '');
  return match ? match[1].toLowerCase().replace(/:443$/, '') : '';
}

function buildURL(path) {
  if (typeof path !== 'string' || !path) throw new RequestError('请求地址不能为空', 'INVALID_URL');
  if (/^https:\/\//i.test(path)) return path;
  if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.indexOf('//') === 0) {
    throw new RequestError('请求地址必须使用 HTTPS', 'INVALID_URL');
  }
  if (!config.baseURL) throw new RequestError('请先在 config/index.js 配置 API 地址', 'API_NOT_CONFIGURED');
  if (!/^https:\/\//i.test(config.baseURL)) throw new RequestError('API 地址必须使用 HTTPS', 'INVALID_URL');
  return config.baseURL.replace(/\/$/, '') + '/' + path.replace(/^\//, '');
}

/**
 * 后端约定：{ code: 0 | 200, data: 任意值, message?: string }。
 * 也支持 { success: true, data }；success: false 为业务失败。
 * 也接受不带 code 的原始 JSON；业务错误、HTTP 错误与网络错误统一抛出 RequestError。
 * 框架不自动弹 Toast，由页面决定如何呈现错误。
 */
function request(options) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = buildURL(options && options.url);
    } catch (error) {
      reject(error);
      return;
    }
    const currentSession = session.getSession();
    const header = Object.assign({ 'content-type': 'application/json' }, options.header);
    const hasAuthorization = Object.keys(header).some((key) => key.toLowerCase() === 'authorization');
    // 外部 HTTPS 接口不自动携带本项目凭证，避免将 token 发到第三方。
    const sameBackend = originOf(config.baseURL) && originOf(url) === originOf(config.baseURL);
    if (currentSession && sameBackend && !hasAuthorization) header.Authorization = 'Bearer ' + currentSession.token;

    try {
      wx.request({
        url,
        method: options.method || 'GET',
        data: options.data,
        header,
        timeout: options.timeout === undefined ? config.timeout : options.timeout,
        success(response) {
          const status = response.statusCode;
          const body = response.data;
          const code = body && typeof body === 'object' ? body.code : undefined;
          if (sameBackend && (status === 401 || isUnauthorized(code))) session.clearSession();
          if (status < 200 || status >= 300) {
            reject(new RequestError((body && body.message) || '服务请求失败，请稍后重试', 'HTTP_ERROR', status));
            return;
          }
          const successfulCode = code === 0 || code === '0' || code === 200 || code === '200';
          if ((body && body.success === false) || (code !== undefined && !successfulCode)) {
            reject(new RequestError(body.message || '业务处理失败', code === undefined ? 'BUSINESS_ERROR' : code, status));
            return;
          }
          resolve(code !== undefined || (body && body.success === true) ? body.data : body);
        },
        fail(error) {
          const timeout = error && /timeout/i.test(error.errMsg || '');
          reject(new RequestError(timeout ? '请求超时，请稍后重试' : '网络连接失败，请检查网络', timeout ? 'TIMEOUT' : 'NETWORK_ERROR'));
        }
      });
    } catch (error) {
      reject(new RequestError('网络请求启动失败，请稍后重试', 'REQUEST_FAILED'));
    }
  });
}

function get(url, data, options = {}) {
  return request(Object.assign({}, options, { url, data, method: 'GET' }));
}

function post(url, data, options = {}) {
  return request(Object.assign({}, options, { url, data, method: 'POST' }));
}

module.exports = { request, get, post, RequestError };
