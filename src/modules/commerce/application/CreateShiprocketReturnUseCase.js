import { BadRequestError, ConflictError, NotFoundError } from '../../../shared/errors/index.js';

export class CreateShiprocketReturnUseCase {
  constructor({ orderRepository, shiprocketService, auditEventRepository }) {
    this.orderRepository = orderRepository;
    this.shiprocketService = shiprocketService;
    this.auditEventRepository = auditEventRepository;
  }

  async execute({ orderId, actor = null }) {
    const id = String(orderId || '').trim();
    const order = await this.orderRepository.findById(id);
    if (!order) throw new NotFoundError('Order not found');
    if (order.fulfillment.status !== 'Return requested') {
      throw new BadRequestError('Operations must review and approve a return request before creating a reverse pickup.');
    }
    if (order.fulfillment.shiprocket_return_awb || order.fulfillment.shiprocket_return_shipment_id) {
      throw new ConflictError('A reverse shipment is already associated with this order.', null, 'SHIPROCKET_RETURN_EXISTS');
    }
    if (order.fulfillment.shiprocket_status === 'return_processing' || order.fulfillment.shiprocket_status === 'return_needs_review') {
      throw new ConflictError('A reverse shipment request is already processing or needs reconciliation. Check Shiprocket before retrying.', null, 'SHIPROCKET_RETURN_EXISTS');
    }
    if (typeof this.orderRepository.claimShiprocketReturn === 'function') {
      const claimed = await this.orderRepository.claimShiprocketReturn(id);
      if (!claimed) throw new ConflictError('A reverse shipment request is already in progress. Refresh this order before retrying.', null, 'SHIPROCKET_RETURN_EXISTS');
    } else {
      await this.orderRepository.update(id, { fulfillment: { shiprocket_status: 'return_processing' } });
    }
    let shipment;
    try {
      shipment = await this.shiprocketService.createReturnShipment(order);
    } catch (error) {
      const safeToRetry = error.retrySafe === true || (Number(error.statusCode) > 0 && Number(error.statusCode) < 500);
      await this.orderRepository.update(id, { fulfillment: { shiprocket_status: safeToRetry ? 'return_failed' : 'return_needs_review' } });
      throw error;
    }
    const updated = await this.orderRepository.update(id, {
      fulfillment: {
        shiprocket_status: 'return_created',
        shiprocket_return_shipment_id: shipment.shipmentId,
        shiprocket_return_awb: shipment.awbCode,
      },
    });
    updated.addTimelineEvent(`Reverse pickup created${shipment.courierName ? ` with ${shipment.courierName}` : ''} (AWB: ${shipment.awbCode})`);
    await this.orderRepository.update(id, { timeline: updated.timeline });
    if (this.auditEventRepository) await this.auditEventRepository.record({
      actor: actor || { id: 'admin', type: 'admin' },
      action: 'commerce.shiprocket.return_created',
      target: { id, type: 'order' },
      metadata: { shipmentId: shipment.shipmentId, awbCode: shipment.awbCode, courier: shipment.courierName },
    });
    return updated;
  }
}
