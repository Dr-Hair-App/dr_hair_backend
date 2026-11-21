import { logger } from '../../../shared/utils/logger.js';
import { config } from '../../../config/env.js';
import { BadGatewayError, ServiceUnavailableError } from '../../../shared/errors/index.js';

const maskDestination = (destination) => {
  const value = String(destination || '');
  if (value.includes('@')) {
    const [name, domain] = value.split('@');
    return `${name.slice(0, 1)}***@${domain}`;
  }
  return `${'*'.repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`;
};

export class SmsService {
  constructor(options = {}) {
    this.twoFactorConfig = options.twoFactorConfig || config.twoFactor;
    this.provider = '2factor';
    this.logger = options.logger || logger;
  }

  /**
   * Sends OTP through 2Factor.in gateway.
   */
  async sendOtp(destination, otpCode) {
    const raw = String(destination || '').trim();

    // OTP is SMS-only in every environment.
    if (raw.includes('@')) {
      throw new ServiceUnavailableError('Email OTP delivery is not configured. SMS OTP requires a phone number.');
    }

    // Extract 10-digit Indian phone number
    const digits = raw.replace(/\D/g, '');
    const phone10 = digits.length >= 10 ? digits.slice(-10) : '';

    if (!phone10 || phone10.length !== 10) {
      this.logger.warn(`[SmsService] Unable to extract valid 10-digit mobile number from ${maskDestination(raw)}`);
      throw new BadGatewayError('SMS delivery failed: invalid phone number.');
    }

    return this._send2Factor(phone10, otpCode);
  }

  async _send2Factor(phone10, otpCode) {
    const apiKey = this.twoFactorConfig?.apiKey;
    if (!apiKey) {
      throw new ServiceUnavailableError(
        'OTP delivery unavailable. Configure TWOFACTOR_API_KEY for this environment.',
      );
    }

    const internationalPhone = `+91${phone10}`;
    const template = this.twoFactorConfig.templateName ? `/${encodeURIComponent(this.twoFactorConfig.templateName)}` : '';
    const url = `https://2factor.in/API/V1/${encodeURIComponent(apiKey)}/SMS/${encodeURIComponent(internationalPhone)}/${encodeURIComponent(otpCode)}${template}`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });

      const data = await response.json().catch(() => null);

      if (data && String(data.Status || '').toLowerCase() === 'success') {
        this.logger.info(
          `[2Factor] Successfully dispatched OTP to ${maskDestination(phone10)}`
        );
        return true;
      }

      this.logger.error(`[2Factor] Gateway rejected SMS request for ${maskDestination(phone10)}.`);
      throw new BadGatewayError('SMS delivery failed. Please try again.');
    } catch (err) {
      if (err instanceof BadGatewayError || err instanceof ServiceUnavailableError) throw err;
      this.logger.error(`[2Factor] Network error dispatching SMS (${err?.constructor?.name || 'Error'}).`);
      throw new BadGatewayError('Failed to connect to SMS delivery gateway. Please try again.');
    }
  }
}
