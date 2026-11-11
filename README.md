# 起点 Seed · 微信小程序基础框架

微信原生 JavaScript + WXML + WXSS，无第三方运行依赖、无需构建。包含三个 Tab 页面、公共组件，以及可独立复用的请求、缓存和登录态模块。默认本地 Mock，可先体验页面，再接入业务后端。

## 快速开始

1. 打开微信开发者工具，选择「导入项目」，目录选择本仓库根目录，即 `project.config.json` 所在目录。
2. 配置中使用 `touristappid`。导入时可选择测试号；如需预览、真机调试或上传，请使用自己的小程序 AppID。
3. 点击「编译」。首页自动展示原生地图及示例地点，概览接口使用模拟数据，不需要配置服务器、不需要执行 npm 安装或「构建 npm」。地图底图需要联网。
4. 首页点击「开始记录」体验实时运动轨迹；在「组件」页体验基础交互，在「我的」页体验演示登录与退出。真实定位需使用具备定位接口权限的小程序 AppID。

使用自己的 AppID 时，将 `project.config.json` 中的 `appid` 替换为微信公众平台创建的小程序 AppID。开发者工具生成的个人配置 `project.private.config.json` 已加入忽略列表。

## 目录

```text
miniprogram/
  app.js / app.json / app.wxss  启动入口、路由、全局样式
  sitemap.json                 搜索收录配置
  assets/tabbar/               原生 Tab 图标
  config/index.js              开发 / 体验 / 正式环境配置
  pages/
    home/                      原生地图、框架概览与请求示例
    components/                可操作的 UI 组件示例
    profile/                   演示登录、会话信息与缓存管理
  components/
    section-heading/           带操作入口的章节标题
    empty-state/               可复用的空状态与操作事件
    location-map/              可复用的原生地图、标记与缩放控件
  services/
    request.js                 Promise 请求与统一错误
    api.js                     业务 API 与本地 Mock
    location-tracker.js         前台持续定位、授权与生命周期管理
  utils/
    storage.js                 带命名空间与 TTL 的本地缓存
    session.js                 持久化会话、过期清理
    motion.js                  分段轨迹、距离、时长与速度计算
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

TTL 单位为毫秒，默认 `0` 表示不过期；过期、损坏、读取失败时返回默认值。`set` / `remove` / `clear` 返回操作是否成功。`clear()` 只移除 `seed:` 命名空间下的数据，包括会话和最近一次运动轨迹，因此「我的」页会先确认，再清空并退出。

## 添加业务页面与组件

- 新建页面的 `.js`、`.json`、`.wxml`、`.wxss` 文件，并在 `app.json` 的 `pages` 数组注册。普通页面使用 `wx.navigateTo`，Tab 页面使用 `wx.switchTab`。
- 公共组件在组件 JSON 设置 `"component": true`，在页面 JSON 的 `usingComponents` 注册。已有标题、空状态和地图三个组件，展示属性传入与自定义事件。
- 页面内状态使用 `Page.data` 和 `setData`；跨页面会话统一从 `utils/session` 读取，页面在 `onShow` 时同步。
- 全局颜色、间距和基础按钮样式位于 `app.wxss`，页面与隔离组件的样式位于各自的 `.wxss`。
- 示例页面默认不参与微信搜索；发布业务页时按需修改 `sitemap.json`。

## 首页地图与组件复用

首页打开后直接挂载微信原生 `map`，默认展示深圳市民中心，并提供地点标记、拖动、缩放和「回到起点」。地图独立于概览接口加载，概览请求失败时仍可查看地图。

修改首页 `pages/home/index.js` 中的 `mapLocation` 即可配置默认示例地点。地图及轨迹使用 GCJ-02 坐标。页面打开时不获取用户位置，只有点击「开始记录」或「继续记录」才申请授权并启动持续定位。

在其他页面的 JSON 注册：

```json
{ "usingComponents": { "location-map": "/components/location-map/index" } }
```

在 WXML 中传入地点属性：

```xml
<location-map
  latitude="{{22.543096}}"
  longitude="{{114.057865}}"
  scale="{{15}}"
  title="深圳市民中心"
  address="广东省深圳市福田区福中三路"
  height="{{440}}"
/>
```

`height` 的单位为 rpx；`scale` 范围为 3–20。组件提供 `ready`（地图渲染完成）、`markertap`（点击地点）和 `error`（组件初始化、操作或加载超时失败）事件，可使用 `bind:markertap="onMarkerTap"` 绑定。标记事件包含 `markerId`、`latitude`、`longitude`、`title` 和 `address`。无效坐标或加载失败时组件提供重试入口。

实时轨迹通过 `polyline`（原生地图折线数组）、`live-location`（最新有效定位点）和 `tracking`（是否实时跟随）传入。地图自身不调用定位 API；位置更新由定位服务驱动。手动拖动地图后可点击「恢复跟随」，缩放级别不会因定位更新而重置。

地图实际渲染和手势交互需在微信开发者工具与真机中验证；Node 测试使用微信 API 替身，不能验证在线底图。

## 实时运动轨迹

首页提供开始、暂停、继续、结束操作，显示累计距离、记录时长、当前速度、平均速度、定位精度和轨迹点数。真实定位与 Mock 概览接口相互独立，登录体验账号不是记录运动的前提。

记录采用前台模式：切换 Tab、离开首页、切到后台或锁屏导致页面隐藏时，会暂停记录并关闭位置监听；返回后手动点击「继续记录」。当前版本不提供后台或锁屏持续记录。

定位服务使用 `wx.startLocationUpdate({ type: 'gcj02' })` 和 `wx.onLocationChange`，点击开始后先请求隐私授权和 `scope.userLocation`。暂停、结束和页面销毁时调用 `wx.offLocationChange` 移除本服务的回调，并调用 `wx.stopLocationUpdate`。权限被拒绝时提供「打开定位设置」，设置完成后由用户再次点击继续；无有效定位或信号中断时自动暂停并提示。

`app.json` 已声明实际使用的 `requiredPrivateInfos`：`startLocationUpdate`、`onLocationChange`，以及位置用途。真机验收前，需要换成具备相关定位接口权限的 AppID，在微信公众平台配置隐私保护指引及位置用途，并允许微信和系统定位。接口说明参见腾讯位置服务官方文档：[持续定位](https://github.com/TencentLBS/tencentmap-miniprogram-skill/blob/main/references/wx_location_api/wx.startLocationUpdate.md)、[定位数据](https://github.com/TencentLBS/tencentmap-miniprogram-skill/blob/main/references/wx_location_api/wx.getLocation.md)。

轨迹计算规则位于 `utils/motion.js`：

- 使用 Haversine 计算连续有效定位点间的距离；暂停或超过 30 秒的定位空档会新建线段，中断期间不连线、不补算距离。
- 过滤无效坐标、已知精度超过 50 米的定位、3 米以内的抖动和超过 25 m/s 的异常跳点。小幅移动相对上一个保留点累计，达到阈值后仍可形成轨迹。
- 暂停期间不计入记录时长；速度和距离均为 GPS 估算，受环境与定位精度影响。
- 单次最多保存 5000 个轨迹点，达到上限明确结束记录，避免轨迹无限增长。

结束后把最近一次完成的轨迹保存到本机 `seed:motion:last-session`，重新打开首页可查看该记录，不会自动重启定位。当前位置、轨迹及运动统计不会上传到后端；当前只保存最近一次完成的记录，新完成记录会覆盖上一条，尚未结束的记录在进程退出后不恢复。清空缓存会删除已保存的轨迹。保存失败和系统定位停止失败均会显示提示。

真机验收建议：开始后实际步行观察折线；暂停后移动再继续，确认分段且不补算空档；切换 Tab 或切到后台确认暂停；拒绝定位后通过设置再继续；结束并重开首页确认只展示历史轨迹且不启动定位。

## 本地验证

安装 Node.js 20 或更新版本后，在根目录执行，无需安装依赖：

```sh
npm run verify
```

这会检查项目配置、页面与组件文件、JavaScript 语法、模块路径、Tab 图标、WXML 事件引用，并运行核心模块与页面交互的行为测试。微信 API 通过测试替身执行；这些检查不能代替微信开发者工具编译和真机验收。

重新生成 Tab 图标：`npm run icons`。
