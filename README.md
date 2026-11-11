# 起点 Seed · 微信小程序基础框架

微信原生 JavaScript + WXML + WXSS，无第三方运行依赖、无需构建。包含三个 Tab 页面、公共组件，以及可独立复用的请求、缓存和登录态模块。默认本地 Mock，可先体验页面，再接入业务后端。

## 快速开始

1. 打开微信开发者工具，选择「导入项目」，目录选择本仓库根目录，即 `project.config.json` 所在目录。
2. 配置中使用 `touristappid`。导入时可选择测试号；如需预览、真机调试或上传，请使用自己的小程序 AppID。
3. 点击「编译」。默认首页使用模拟数据，不需要配置服务器、不需要执行 npm 安装或「构建 npm」。
4. 在「组件」页体验输入、按钮、计数、开关和状态反馈；在「我的」页体验演示登录与退出。

使用自己的 AppID 时，将 `project.config.json` 中的 `appid` 替换为微信公众平台创建的小程序 AppID。开发者工具生成的个人配置 `project.private.config.json` 已加入忽略列表。

## 目录

```text
miniprogram/
  app.js / app.json / app.wxss  启动入口、路由、全局样式
  sitemap.json                 搜索收录配置
  assets/tabbar/               原生 Tab 图标
  config/index.js              开发 / 体验 / 正式环境配置
  pages/
    home/                      框架首页、加载与请求示例
    components/                可操作的 UI 组件示例
    profile/                   演示登录、会话信息与缓存管理
  components/
    section-heading/           带操作入口的章节标题
    empty-state/               可复用的空状态与操作事件
  services/
    request.js                 Promise 请求与统一错误
    api.js                     业务 API 与本地 Mock
  utils/
    storage.js                 带命名空间与 TTL 的本地缓存
    session.js                 持久化会话、过期清理
scripts/                       静态检查、测试与图标生成
tests/                         核心模块与页面交互测试
```

## 接入后端

在 `miniprogram/config/index.js` 中修改对应环境：

```js
develop: { baseURL: 'https://your-api.example.com/v1', mock: false }
```

环境由 `wx.getAccountInfoSync().miniProgram.envVersion` 自动识别：开发版 `develop`、体验版 `trial`、正式版 `release`。三种环境初始均为 Mock；发布业务版本时需要分别设置。

同时在微信公众平台「开发管理 → 开发设置 → 服务器域名」配置 request 合法域名。配置默认保留域名校验。

现有业务接口为：

| 方法与路径 | 数据 |
| --- | --- |
| `GET /overview` | 框架概览，含 `stats: [{ label, value }]` |
| `GET /features` | 功能数组 `[{ id, title, description, icon, status }]` |
| `GET /profile` | `{ loggedIn, user, environment, version }` |

请求封装默认支持以下成功响应，并返回 `data`：

```json
{ "code": 0, "data": { "id": "123" }, "message": "ok" }
```

也支持 `code: 200`、字符串 `"0"` / `"200"`、`{ success: true, data }` 和不带状态字段的原始 JSON。业务失败、非 2xx、网络错误和超时均抛出 `RequestError`，含 `message`、`code`、`statusCode`。按自己的后端协议调整 `services/request.js`，页面负责展示错误和重试。

```js
const { get, post } = require('../../services/request')

const list = await get('/items', { page: 1 })
const item = await post('/items', { title: '第一条记录' })
```

请求自动为配置后端的同源地址添加 `Authorization: Bearer <token>`；第三方 HTTPS 地址不会自动获得此凭证。后端 HTTP 401 或业务 `code: 401` 会清除本地会话。框架不自动重试写入请求。

## 登录与缓存

**演示登录仅用于验证页面与会话流程，不是微信身份认证。** 它保存一个明确标识为演示用途的本地 token，24 小时后过期。关闭 Mock 后，演示登录入口不可用。

真实登录需要接入 `wx.login`：将临时 code 发送给自己的后端，由后端与微信交换身份并签发业务 token，然后保存会话：

```js
const { setSession } = require('../../utils/session')

setSession({
  token: result.token,
  user: result.user,
  expiresAt: result.expiresAt // 后端提供的到期时间，毫秒时间戳
})
```

不要在小程序代码中保存 AppSecret。页面通过 `getSession()` 读取会话；每次读取会检查有效期，请求遇到 401 也会清除会话。

```js
const storage = require('../../utils/storage')

storage.set('filters', { status: 'all' }, 30 * 60 * 1000)
const filters = storage.get('filters', { status: 'all' })
storage.remove('filters')
```

TTL 单位为毫秒，默认 `0` 表示不过期；过期、损坏、读取失败时返回默认值。`set` / `remove` / `clear` 返回操作是否成功。`clear()` 只移除 `seed:` 命名空间下的数据，包括会话，因此「我的」页会先确认，再清空并退出。

## 添加业务页面与组件

- 新建页面的 `.js`、`.json`、`.wxml`、`.wxss` 文件，并在 `app.json` 的 `pages` 数组注册。普通页面使用 `wx.navigateTo`，Tab 页面使用 `wx.switchTab`。
- 公共组件在组件 JSON 设置 `"component": true`，在页面 JSON 的 `usingComponents` 注册。已有两个组件展示了属性传入与 `triggerEvent('action')` 事件。
- 页面内状态使用 `Page.data` 和 `setData`；跨页面会话统一从 `utils/session` 读取，页面在 `onShow` 时同步。
- 全局颜色、间距和基础按钮样式位于 `app.wxss`，页面与隔离组件的样式位于各自的 `.wxss`。
- 示例页面默认不参与微信搜索；发布业务页时按需修改 `sitemap.json`。

## 本地验证

安装 Node.js 20 或更新版本后，在根目录执行，无需安装依赖：

```sh
npm run verify
```

这会检查项目配置、页面与组件文件、JavaScript 语法、模块路径、Tab 图标、WXML 事件引用，并运行核心模块与页面交互的行为测试。微信 API 通过测试替身执行；这些检查不能代替微信开发者工具编译和真机验收。

重新生成 Tab 图标：`npm run icons`。
