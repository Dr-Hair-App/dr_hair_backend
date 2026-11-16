export const isSandboxCommerceDeployment = (env = process.env) =>
  env.DRHAIR_DEPLOYMENT_ENV?.trim().toLowerCase() === 'staging';
