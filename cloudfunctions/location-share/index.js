const cloud = require('wx-server-sdk');
const { createCloudRepository } = require('./repository');
const { createLocationShareService } = require('./service');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const service = createLocationShareService({ repository: createCloudRepository(cloud.database()) });

exports.main = async (event) => {
  // Identity comes from WeChat's signed invocation context, never event.openId.
  const context = cloud.getWXContext();
  return service.handle(event, context && context.OPENID);
};
