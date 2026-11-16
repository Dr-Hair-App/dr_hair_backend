import { BadRequestError, NotFoundError } from '../../../shared/errors/index.js';

export class RetryShiprocketPickupUseCase {
  constructor({ orderRepository, shiprocketService, auditEventRepository }) {
    this.orderRepository = orderRepository;
    this.shiprocketService = shiprocketService;
    this.auditEventRepository = auditEventRepository;
  }

  async execute({ orderId, actor = null }) {
    const order = await this.orderRepository.findById(String(orderId || '').trim());
    if (!order) throw new NotFoundError('Order not found');
    const fulfillment = order.fulfillment;
    if (!fulfillment.shiprocket_shipment_id || !fulfillment.awb_code) {
      throw new BadRequestError('A Shiprocket shipment with an AWB is required before requesting pickup.');
    }
    if (['Shipped', 'Delivered', 'Cancelled', 'Refunded'].includes(fulfillment.status)) {
      throw new BadRequestError(`Cannot request pickup for an order in '${fulfillment.status}' status.`);
    }
    const pickupState = `${fulfillment.shiprocket_pickup_status} ${fulfillment.shiprocket_status}`.toLowerCase();
    const latestEvent = fulfillment.shiprocket_events.at(-1);
    const failed = /fail|error|exception|pickup error/.test(pickupState)
      || Number(latestEvent?.status_code) === 13 || Number(latestEvent?.status_code) === 20;
    if (!failed) throw new BadRequestError('Pickup retry is available only after Shiprocket reports a pickup failure.');

    const result = await this.shiprocketService.requestPickup({ shipmentId: fulfillment.shiprocket_shipment_id, retry: true });
    const updated = await this.orderRepository.update(order.order_id, {
      fulfillment: {
        shiprocket_pickup_status: result.status || 'requested',
        shiprocket_pickup_scheduled_at: result.scheduledAt || fulfillment.shiprocket_pickup_scheduled_at,
        ...(result.manifestUrl ? { shiprocket_manifest_url: result.manifestUrl } : {}),
      },
    });
    updated.addTimelineEvent(`Shiprocket pickup retry requested${result.scheduledAt ? ` for ${result.scheduledAt}` : ''}`);
    await this.orderRepository.update(order.order_id, { timeline: updated.timeline });
    if (this.auditEventRepository) await this.auditEventRepository.record({
      actor: actor || { id: 'admin', type: 'admin' },
      action: 'commerce.shiprocket.pickup_retried',
      target: { id: order.order_id, type: 'order' },
      metadata: { shipmentId: fulfillment.shiprocket_shipment_id, pickupStatus: result.status },
    });
    return updated;
  }
}
