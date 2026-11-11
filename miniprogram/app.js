const config = require('./config')
const { getSession } = require('./utils/session')

App({
  globalData: {
    version: config.version,
    environment: config.env,
  },

  onLaunch() {
    // Reading the session also discards an expired local demo session.
    getSession()
  },

  onError(error) {
    // Replace with your monitoring SDK when integrating a backend.
    console.error('[app]', error)
  },
})
