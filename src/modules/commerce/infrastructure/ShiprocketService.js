import { BadRequestError, ConflictError, ServiceUnavailableError, BadGatewayError } from '../../../shared/errors/index.js';

const API_BASES = Object.freeze({
  production: 'https://apiv2.shiprocket.in/v1/external',
  sandbox: 'https://api-sandbox.shiprocket.in/v1/external',
});
const TOKEN_REFRESH_MARGIN_MS = 30 * 60 * 1000;
const cachedTokens = new Map();
const trackingCache = new Map();
const pickupLocationCache = new Map();

function positiveNumber(name) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

export class ShiprocketService {
  getConfiguration() {
    const isVercelPreview = process.env.VERCEL_ENV?.trim().toLowerCase() === 'preview';
    const defaultEnvironment = process.env.NODE_ENV === 'production' ? 'production' : 'sandbox';
    // Preview deployments are isolated test environments. Never let a copied
    // production variable accidentally route Preview traffic to live shipping.
    const environment = isVercelPreview
      ? 'sandbox'
      : process.env.SHIPROCKET_API_ENV?.trim().toLowerCase() || defaultEnvironment;
    const apiBase = API_BASES[environment] || '';
    const email = environment === 'sandbox'
      ? process.env.SHIPROCKET_SANDBOX_API_EMAIL?.trim() || ''
      : environment === 'production'
        ? process.env.SHIPROCKET_API_EMAIL?.trim() || ''
        : '';
    const password = environment === 'sandbox'
      ? process.env.SHIPROCKET_SANDBOX_API_PASSWORD || ''
      : environment === 'production'
        ? process.env.SHIPROCKET_API_PASSWORD || ''
        : '';
    const pickupLocation = process.env.SHIPROCKET_PICKUP_LOCATION?.trim() || '';
    const length = positiveNumber('SHIPROCKET_PACKAGE_LENGTH_CM');
    const breadth = positiveNumber('SHIPROCKET_PACKAGE_BREADTH_CM');
    const height = positiveNumber('SHIPROCKET_PACKAGE_HEIGHT_CM');
    const weight = positiveNumber('SHIPROCKET_PACKAGE_WEIGHT_KG');

    return {
      environment,
      apiBase,
      email,
      password,
      pickupLocation,
      package: { length, breadth, height, weight },
      configured: Boolean(apiBase && email && password && pickupLocation),
    };
  }

  assertConfigured() {
    if (!this.getConfiguration().configured) {
      throw new ServiceUnavailableError(
        'Shiprocket setup is incomplete. Finish Shiprocket KYC, create an API user, and configure a pickup location.',
        null,
        'SHIPROCKET_NOT_CONFIGURED',
      );
    }
  }

  validateOrder(order) {
    this.assertConfigured();
    this.buildForwardShipmentPayload(order, this.getConfiguration());
  }

  async getPickupLocation(config = this.getConfiguration()) {
    const cacheKey = `${config.environment}:${config.email}:${config.pickupLocation}`;
    const cached = pickupLocationCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.location;
    const token = await this.getToken(config);
    const response = await this.request(config.apiBase, '/settings/company/pickup', token, { method: 'GET' });
    const candidates = [response?.data, response?.pickup_locations, response?.shipping_address, response?.data?.shipping_address]
      .flatMap((value) => Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : []);
    const location = candidates.find((item) => {
      if (!item || typeof item !== 'object') return false;
      const name = String(item.pickup_location || item.pickup_location_name || item.name || '').trim();
      return name.toLowerCase() === config.pickupLocation.toLowerCase();
    });
    const postcode = String(location?.pin_code || location?.pincode || location?.postcode || '').trim();
    if (!/^\d{6}$/.test(postcode)) {
      throw new ServiceUnavailableError(
        'The configured Shiprocket pickup location was not found or has no valid PIN code.',
        null,
        'SHIPROCKET_PICKUP_LOCATION_INVALID',
      );
    }
    const normalized = { ...location, pin_code: postcode };
    pickupLocationCache.set(cacheKey, { location: normalized, expiresAt: Date.now() + 5 * 60_000 });
    return normalized;
  }

  async getPickupPostcode(config = this.getConfiguration()) {
    const location = await this.getPickupLocation(config);
    return String(location.pin_code);
  }

  async getCourierQuotes({ deliveryPincode, paymentMethod, weight, length, breadth, height, declaredValue }) {
    this.assertConfigured();
    const config = this.getConfiguration();
    const pin = String(deliveryPincode || '').trim();
    if (!/^\d{6}$/.test(pin)) throw new BadRequestError('Enter a valid 6-digit delivery PIN code.');
    const packageValues = [weight, length, breadth, height].map(Number);
    if (packageValues.some((value) => !Number.isFinite(value) || value <= 0)) {
      throw new BadRequestError('Shipping package weight and dimensions are missing or invalid.');
    }
    const pickupPincode = await this.getPickupPostcode(config);
    const token = await this.getToken(config);
    const query = new URLSearchParams({
      pickup_postcode: pickupPincode,
      delivery_postcode: pin,
      cod: paymentMethod === 'cod' ? '1' : '0',
      weight: String(weight),
      length: String(length),
      breadth: String(breadth),
      height: String(height),
      declared_value: String(Math.max(1, Math.round(Number(declaredValue) || 1))),
      is_return: '0',
    });
    const response = await this.request(config.apiBase, `/courier/serviceability/?${query.toString()}`, token, { method: 'GET' });
    const data = response?.data || response;
    const providers = data?.available_courier_companies || data?.couriers || [];
    const quotes = Array.isArray(providers)
      ? providers.map((courier) => ({
          courier_id: String(courier.courier_company_id || courier.id || ''),
          courier: String(courier.courier_name || courier.name || ''),
          rate: Number(courier.rate ?? courier.freight_charge ?? courier.cost),
          etd: String(courier.etd || courier.estimated_delivery_days || ''),
          cod_available: Boolean(Number(courier.cod) || courier.cod === true),
          rating: Number(courier.rating) || null,
          charge_weight: Number(courier.charge_weight) || Number(weight),
        }))
      : [];
    return quotes
      .filter((quote) => quote.courier_id && Number.isFinite(quote.rate) && quote.rate >= 0 && quote.courier)
      .sort((a, b) => a.rate - b.rate || (b.rating || 0) - (a.rating || 0));
  }

  async createForwardShipment(order) {
    this.assertConfigured();
    const config = this.getConfiguration();
    const payload = this.buildForwardShipmentPayload(order, config);
    const token = await this.getToken(config);
    const response = await this.request(config.apiBase, '/shipments/create/forward-shipment', token, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const result = response?.payload || response?.data || response;
    const shipmentId = result?.shipment_id || result?.shipmentId;
    const awbCode = result?.awb_code || result?.awb || result?.awbCode;

    if (!shipmentId || !awbCode) {
      throw new BadGatewayError(
        'Shiprocket did not return both a shipment ID and AWB. Check the Shiprocket panel before retrying this order.',
        null,
        'SHIPROCKET_INCOMPLETE_RESPONSE',
      );
    }

    return {
      shiprocketOrderId: String(result.order_id || result.orderId || ''),
      shipmentId: String(shipmentId),
      awbCode: String(awbCode),
      courierName: String(result.courier_name || result.courier || ''),
      courierId: result.courier_company_id ? String(result.courier_company_id) : '',
      pickupScheduledAt: result.pickup_scheduled_date || null,
      pickupStatus: String(result.pickup_status || result.status || ''),
      labelUrl: result.label_url || null,
      manifestUrl: result.manifest_url || null,
    };
  }

  async requestPickup({ shipmentId, retry = false }) {
    this.assertConfigured();
    const id = String(shipmentId || '').trim();
    if (!/^\d+$/.test(id)) throw new BadRequestError('A valid Shiprocket shipment ID is required.');
    const config = this.getConfiguration();
    const token = await this.getToken(config);
    const response = await this.request(config.apiBase, '/courier/generate/pickup', token, {
      method: 'POST',
      body: JSON.stringify({ shipment_id: [Number(id)], ...(retry ? { status: 'retry' } : {}) }),
    });
    const data = response?.response || response?.data || response;
    const pickupStatus = String(data?.pickup_status || data?.status || response?.pickup_status || '');
    let manifestUrl = '';
    if (pickupStatus && !/fail|error|exception/i.test(pickupStatus)) {
      try {
        const manifest = await this.request(config.apiBase, '/manifests/generate', token, {
          method: 'POST',
          body: JSON.stringify({ shipment_id: [Number(id)] }),
        });
        manifestUrl = String(manifest?.manifest_url || manifest?.data?.manifest_url || manifest?.url || '');
      } catch {
        // Pickup is already scheduled; the admin can see the saved pickup state
        // and generate the manifest from Shiprocket if its API is unavailable.
      }
    }
    return {
      status: pickupStatus,
      scheduledAt: data?.pickup_scheduled_date || data?.pickup_date || null,
      manifestUrl,
      raw: response,
    };
  }

  async cancelShipment({ awbCode }) {
    this.assertConfigured();
    const awb = String(awbCode || '').trim();
    if (!awb) throw new BadRequestError('A Shiprocket AWB is required to cancel the shipment.');
    const tracking = await this.trackShipment({ awbCode: awb });
    const statusCode = Number(tracking.current_status_id);
    if ([6, 7, 17, 18, 19, 42].includes(statusCode) || /picked up|out for pickup|in transit|shipped|delivered/i.test(tracking.current_status)) {
      throw new ConflictError('Shiprocket no longer allows cancellation after courier pickup has started.', null, 'SHIPROCKET_CANCELLATION_CLOSED');
    }
    const config = this.getConfiguration();
    const token = await this.getToken(config);
    const response = await this.request(config.apiBase, '/orders/cancel/shipment/awbs', token, {
      method: 'POST',
      body: JSON.stringify({ awbs: [awb] }),
    });
    return { awbCode: awb, response };
  }

  async createReturnShipment(order) {
    this.assertConfigured();
    const config = this.getConfiguration();
    const pickup = order.shipping_address || {};
    const customerName = String(order.customer?.name || pickup.name || '').trim();
    const phone = String(order.customer?.phone || pickup.phone || '').replace(/\D/g, '');
    const email = String(order.customer?.email || '').trim();
    const buyerAddress = [pickup.house_number, pickup.street].filter(Boolean).join(', ').trim();
    const packageSize = order.fulfillment?.shiprocket_package;
    if (!customerName || phone.length < 10 || !email || !buyerAddress || !pickup.city || !pickup.state || !/^\d{6}$/.test(String(pickup.pincode || ''))) {
      throw new BadRequestError('Customer return pickup needs a valid name, email, phone, address, city, state, and PIN code.');
    }
    if (!packageSize || ['weight_kg', 'length_cm', 'breadth_cm', 'height_cm'].some((key) => !Number.isFinite(Number(packageSize[key])) || Number(packageSize[key]) <= 0)) {
      throw new BadRequestError('The original parcel profile is missing; update the product package details before arranging a return pickup.');
    }
    const seller = await this.getPickupLocation(config);
    const sellerAddress = String(seller.address || seller.address_1 || seller.address_line || '').trim();
    const sellerCity = String(seller.city || '').trim();
    const sellerState = String(seller.state || '').trim();
    const sellerPhone = String(seller.phone || seller.phone_number || '').replace(/\D/g, '');
    if (!sellerAddress || !sellerCity || !sellerState || sellerPhone.length < 10) {
      throw new ServiceUnavailableError('The configured pickup location is missing seller address or phone details for return delivery.');
    }
    const returnOrderId = `${String(order.order_id).slice(0, 46)}-R`;
    const payload = {
      order_id: returnOrderId,
      order_date: new Date().toISOString().slice(0, 10),
      pickup_customer_name: customerName,
      pickup_address: buyerAddress.slice(0, 190),
      pickup_city: String(pickup.city),
      pickup_state: String(pickup.state),
      pickup_country: 'India',
      pickup_pincode: Number(pickup.pincode),
      pickup_email: email,
      pickup_phone: phone,
      shipping_customer_name: String(seller.contact_name || seller.name || config.pickupLocation),
      shipping_address: sellerAddress.slice(0, 190),
      shipping_city: sellerCity,
      shipping_state: sellerState,
      shipping_country: 'India',
      shipping_pincode: Number(seller.pin_code),
      shipping_phone: sellerPhone,
      order_items: (order.items || []).map((item) => ({
        name: String(item.title || item.name || 'Product').slice(0, 100),
        sku: String(item.product_id || item.sku || order.order_id).slice(0, 50),
        units: Math.max(1, Number(item.quantity) || 1),
        selling_price: Number(item.price) || 0,
      })),
      payment_method: 'Prepaid',
      sub_total: Math.max(1, Number(order.pricing?.total || 1)),
      length: packageSize.length_cm,
      breadth: packageSize.breadth_cm,
      height: packageSize.height_cm,
      weight: packageSize.weight_kg,
      is_return: 1,
    };
    const token = await this.getToken(config);
    const response = await this.request(config.apiBase, '/shipments/create/return-shipment', token, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const data = response?.payload || response?.data || response;
    const shipmentId = data?.shipment_id || data?.shipmentId;
    const awbCode = data?.awb_code || data?.awb || data?.awbCode;
    if (!shipmentId || !awbCode) throw new BadGatewayError('Shiprocket did not confirm the reverse shipment ID and AWB. Check the Shiprocket panel before retrying.', null, 'SHIPROCKET_RETURN_INCOMPLETE');
    return {
      shipmentId: String(shipmentId),
      awbCode: String(awbCode),
      courierName: String(data?.courier_name || data?.courier || ''),
    };
  }

  async trackShipment({ awbCode, shipmentId }) {
    const config = this.getConfiguration();
    if (!config.apiBase || !config.email || !config.password) {
      throw new ServiceUnavailableError(
        'Shiprocket tracking credentials are not configured for the selected environment.',
        null,
        'SHIPROCKET_NOT_CONFIGURED',
      );
    }

    const awb = String(awbCode || '').trim();
    const shipment = String(shipmentId || '').trim();
    if (!awb && !shipment) throw new BadRequestError('A Shiprocket AWB or shipment ID is required.');

    const identifier = awb || shipment;
    const cacheKey = `${config.environment}:${awb ? 'awb' : 'shipment'}:${identifier}`;
    const cached = trackingCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const token = await this.getToken(config);
    const path = awb
      ? `/courier/track/awb/${encodeURIComponent(awb)}`
      : `/courier/track/shipment/${encodeURIComponent(shipment)}`;
    const response = await this.request(config.apiBase, path, token, { method: 'GET' });
    const tracking = this.normalizeTracking(response, identifier);
    trackingCache.set(cacheKey, { value: tracking, expiresAt: Date.now() + 30_000 });
    return tracking;
  }

  normalizeTracking(response, identifier) {
    let data = response?.tracking_data || response?.data?.tracking_data || response?.data || response;
    if (data && !data.shipment_track && !data.shipment_track_activities) {
      const nested = Object.values(data).find((value) => value?.tracking_data);
      if (nested) data = nested.tracking_data;
    }

    const shipment = Array.isArray(data?.shipment_track) ? data.shipment_track[0] : data?.shipment_track || {};
    const activities = Array.isArray(data?.shipment_track_activities)
      ? data.shipment_track_activities
      : [];

    return {
      awb_code: String(shipment.awb_code || identifier),
      courier: String(shipment.courier_name || ''),
      current_status: String(shipment.current_status || data?.current_status || ''),
      current_status_id: shipment.current_status_id ?? data?.shipment_status ?? null,
      estimated_delivery: String(shipment.edd || shipment.etd || data?.edd || ''),
      origin: String(shipment.origin || ''),
      destination: String(shipment.destination || shipment.delivered_to || ''),
      track_url: String(data?.track_url || shipment.track_url || ''),
      updated_at: String(shipment.updated_time_stamp || activities[0]?.date || ''),
      events: activities.map((event) => ({
        date: String(event.date || ''),
        status: String(event['sr-status-label'] || event.status || ''),
        activity: String(event.activity || event.status || ''),
        location: String(event.location || ''),
      })),
    };
  }

  buildForwardShipmentPayload(order, config) {
    const orderId = String(order.order_id || '').trim();
    const address = order.shipping_address || {};
    const customerName = String(order.customer?.name || address.name || '').trim();
    const phone = String(order.customer?.phone || address.phone || '').replace(/[^0-9]/g, '');
    const email = String(order.customer?.email || '').trim();
    const addressLine = [address.house_number, address.street].filter(Boolean).join(', ').trim();
    const paymentMethod = order.payment?.gateway === 'cod' ? 'COD' : 'Prepaid';
    const packageSize = order.fulfillment?.shiprocket_package;

    if (!orderId || orderId.length > 20) {
      throw new BadRequestError('Order ID is not valid for Shiprocket (maximum 20 characters).');
    }
    if (!customerName || !phone || !email || !addressLine || !address.city || !address.state || !address.pincode) {
      throw new BadRequestError('This order is missing customer or delivery address details required by Shiprocket.');
    }

    const subtotal = Math.max(0, Number(order.pricing?.subtotal || 0) - Number(order.pricing?.discount || 0));
    if (subtotal <= 0) throw new BadRequestError('Shiprocket requires a positive order value.');
    if (!packageSize || ['weight_kg', 'length_cm', 'breadth_cm', 'height_cm'].some((key) => !Number.isFinite(Number(packageSize[key])) || Number(packageSize[key]) <= 0)) {
      throw new BadRequestError('This order is missing a valid parcel shipping profile for its selected products.');
    }

    return {
      order_id: orderId,
      order_date: new Date(order.created_at || Date.now()).toISOString().slice(0, 10),
      pickup_location: config.pickupLocation,
      billing_customer_name: customerName,
      billing_last_name: '',
      billing_address: addressLine.slice(0, 190),
      billing_address_2: '',
      billing_city: String(address.city).trim(),
      billing_pincode: String(address.pincode).trim(),
      billing_state: String(address.state).trim(),
      billing_country: 'India',
      billing_email: email,
      billing_phone: phone,
      shipping_is_billing: true,
      order_items: (order.items || []).map((item) => ({
        name: String(item.title || item.name || 'Product').slice(0, 100),
        sku: String(item.product_id || item.sku || orderId).slice(0, 50),
        units: Math.max(1, Number(item.quantity) || 1),
        selling_price: Number(item.price) || 0,
      })),
      payment_method: paymentMethod,
      sub_total: subtotal,
      length: packageSize.length_cm,
      breadth: packageSize.breadth_cm,
      height: packageSize.height_cm,
      weight: packageSize.weight_kg,
      declared_value: Math.max(1, Math.round(Number(order.pricing?.total || subtotal))),
      is_return: 0,
      request_pickup: true,
      print_label: true,
      generate_manifest: true,
      ...(order.fulfillment?.shiprocket_courier_id
        ? { courier_id: Number(order.fulfillment.shiprocket_courier_id) }
        : {}),
    };
  }

  async getToken(config) {
    const cacheKey = `${config.environment}:${config.email}`;
    const cachedToken = cachedTokens.get(cacheKey);
    if (cachedToken && cachedToken.expiresAt > Date.now() + TOKEN_REFRESH_MARGIN_MS) {
      return cachedToken.value;
    }

    const response = await this.request(config.apiBase, '/auth/login', null, {
      method: 'POST',
      body: JSON.stringify({ email: config.email, password: config.password }),
    });
    const token = response?.token;
    if (!token || typeof token !== 'string') {
      throw new BadGatewayError('Shiprocket authentication failed. Check the API user credentials.');
    }

    cachedTokens.set(cacheKey, { value: token, expiresAt: Date.now() + (9 * 24 * 60 * 60 * 1000) });
    return token;
  }

  async request(apiBase, path, token, options) {
    let response;
    try {
      response = await fetch(`${apiBase}${path}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(options.headers || {}),
        },
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      const error = new BadGatewayError('Could not reach Shiprocket. Check the connection and Shiprocket service status.');
      error.retrySafe = false;
      throw error;
    }

    const responseBody = await response.json().catch(() => null);
    if (!response.ok) {
      const message = String(responseBody?.message || responseBody?.errors?.message || '').trim();
      const error = new BadGatewayError(
        message ? `Shiprocket rejected the request: ${message}` : `Shiprocket request failed with status ${response.status}.`,
        null,
        'SHIPROCKET_REQUEST_FAILED',
      );
      error.retrySafe = response.status >= 400 && response.status < 500;
      throw error;
    }
    return responseBody;
  }
}
