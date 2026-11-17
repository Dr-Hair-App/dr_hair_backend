// Generated or manual Cloudflare Worker environment bindings
interface Env {
  DB: D1Database;
  MEDIA_BUCKET: R2Bucket;
  PUBLIC_CONFIG_KV: KVNamespace;
  DAILY_USAGE_QUOTA: DurableObjectNamespace<import("./cloudflare/DailyUsageQuota.js").DailyUsageQuota>;
  SHIPPING_QUOTE_RATE_LIMIT: {
    limit(options: { key: string }): Promise<{ success: boolean }>;
  };
  NODE_ENV: string;
  DRHAIR_DEPLOYMENT_ENV?: string;
  BASE_URL?: string;
  CORS_ORIGINS?: string;
  JWT_SECRET?: string;
  SUPER_ADMIN_ID?: string;
  SUPER_ADMIN_PASSWORD_HASH?: string;
  SUPER_ADMIN_NAME?: string;
  CRON_SECRET?: string;
}
