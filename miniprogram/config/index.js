/**
 * 微信版本自动映射：开发版 develop、体验版 trial、正式版 release。
 * 演示默认使用本地 Mock。接入后端时填写 HTTPS 地址并将 mock 改为 false；
 * 正式发布前还需在微信公众平台配置 request 合法域名。
 */
const environments = {
  develop: { baseURL: '', mock: true, cloudEnv: '' },
  trial: { baseURL: '', mock: true, cloudEnv: '' },
  release: { baseURL: '', mock: true, cloudEnv: '' }
};

function detectEnvironment() {
  try {
    const info = wx.getAccountInfoSync();
    const version = info.miniProgram.envVersion;
    return Object.prototype.hasOwnProperty.call(environments, version) ? version : 'develop';
  } catch (error) {
    return 'develop';
  }
}

const env = detectEnvironment();

module.exports = Object.assign({
  env,
  timeout: 10000,
  storagePrefix: 'seed:',
  sharingFunctionName: 'location-share',
  version: '1.0.0'
}, environments[env]);
