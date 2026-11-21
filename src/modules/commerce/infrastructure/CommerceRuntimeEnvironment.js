const SANDBOX_ENVIRONMENTS = new Set(['staging', 'testing']);

export const isSandboxCommerceDeployment = (env = process.env) =>
  SANDBOX_ENVIRONMENTS.has(env.DRHAIR_DEPLOYMENT_ENV?.trim().toLowerCase());
