import { defineCloudflareConfig } from "@opennextjs/cloudflare/config";

const config = defineCloudflareConfig();

export default {
  ...config,
  cloudflare: {
    ...config.cloudflare,
    useWorkerdCondition: false,
  },
};
