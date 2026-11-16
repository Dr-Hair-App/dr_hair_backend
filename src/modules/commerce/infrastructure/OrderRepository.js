import { IOrderRepository } from '../domain/IOrderRepository.js';
import { Order } from '../domain/Order.js';
import { isMongoConnected } from '../../../shared/database/mongodb.js';
import { OrderModel } from '../../../shared/database/models.js';
import { store } from '../../../shared/database/store.js';
import { NotFoundError } from '../../../shared/errors/index.js';

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class OrderRepository extends IOrderRepository {
  async getSalesReport(period = 'month', now = new Date()) {
    const selectedPeriod = ['week', 'month', 'year'].includes(period) ? period : 'month';
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    let start;
    let end;
    let cursor;
    let dateFormat = '%Y-%m-%d';
    let buckets = [];
    if (selectedPeriod === 'week') {
      start = new Date(today);
      start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
      end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 7);
      cursor = new Date(start);
      while (cursor < end) {
        buckets.push({ key: cursor.toISOString().slice(0, 10), label: cursor.toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'UTC' }) });
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    } else if (selectedPeriod === 'year') {
      start = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
      end = new Date(Date.UTC(today.getUTCFullYear() + 1, 0, 1));
      dateFormat = '%Y-%m';
      for (let month = 0; month < 12; month += 1) {
        const date = new Date(Date.UTC(today.getUTCFullYear(), month, 1));
        buckets.push({ key: date.toISOString().slice(0, 7), label: date.toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' }) });
      }
    } else {
      start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
      end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
      cursor = new Date(start);
      while (cursor < end) {
        const day = cursor.getUTCDate();
        buckets.push({ key: cursor.toISOString().slice(0, 10), label: day === 1 || day % 5 === 0 ? String(day) : '' });
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    }

    let grouped;
    if (isMongoConnected()) {
      grouped = await OrderModel.aggregate([
        { $match: { created_at: { $gte: start, $lt: end }, 'payment.payment_status': { $in: ['Paid', 'Partially refunded', 'Refunded'] } } },
        { $group: {
          _id: { $dateToString: { format: dateFormat, date: { $convert: { input: '$created_at', to: 'date', onError: null, onNull: null } }, timezone: 'UTC' } },
          order_count: { $sum: 1 },
          gross_sales: { $sum: '$pricing.total' },
          refunds: { $sum: { $ifNull: ['$payment.refund_amount', 0] } },
        } },
      ]);
    } else {
      const totals = new Map();
      for (const order of (store.orders || [])) {
        const created = new Date(order.created_at);
        const status = order.payment?.payment_status || order.payment_status;
        if (!Number.isFinite(created.getTime()) || created < start || created >= end || !['Paid', 'Partially refunded', 'Refunded'].includes(status)) continue;
        const key = selectedPeriod === 'year' ? created.toISOString().slice(0, 7) : created.toISOString().slice(0, 10);
        const entry = totals.get(key) || { _id: key, order_count: 0, gross_sales: 0, refunds: 0 };
        entry.order_count += 1;
        entry.gross_sales += Number(order.pricing?.total) || 0;
        entry.refunds += Number(order.payment?.refund_amount) || 0;
        totals.set(key, entry);
      }
      grouped = [...totals.values()];
    }

    const byKey = new Map(grouped.map((row) => [row._id, row]));
    const series = buckets.map((bucket) => {
      const row = byKey.get(bucket.key) || {};
      const gross = Number(row.gross_sales) || 0;
      const refunds = Number(row.refunds) || 0;
      return { ...bucket, order_count: Number(row.order_count) || 0, gross_sales: gross, refunds, net_sales: Math.max(0, gross - refunds) };
    });
    const totals = series.reduce((sum, row) => ({
      order_count: sum.order_count + row.order_count,
      gross_sales: sum.gross_sales + row.gross_sales,
      refunds: sum.refunds + row.refunds,
      net_sales: sum.net_sales + row.net_sales,
    }), { order_count: 0, gross_sales: 0, refunds: 0, net_sales: 0 });
    return { period: selectedPeriod, currency: 'INR', start_at: start.toISOString(), end_at: end.toISOString(), totals, buckets: series };
  }

  async create(order) {
    const data = order instanceof Order ? order.toJSON() : order;

    if (isMongoConnected()) {
      await OrderModel.create(data);
      return new Order(data);
    }

    if (!Array.isArray(store.orders)) store.orders = [];
    store.orders.unshift(data);
    return new Order(data);
  }

  async findById(orderId) {
    const cleanId = String(orderId).trim();

    if (isMongoConnected()) {
      const record = await OrderModel.findOne({
        $or: [{ order_id: cleanId }, { id: cleanId }],
      }).lean();
      if (!record) return null;
      return new Order(record);
    }

    if (!Array.isArray(store.orders)) store.orders = [];
    const found = store.orders.find((o) => o.order_id === cleanId || o.id === cleanId);
    if (!found) return null;
    return new Order(found);
  }

  async findByPaymentTransactionId(paymentId) {
    const cleanId = String(paymentId || '').trim();
    if (!cleanId) return null;
    if (isMongoConnected()) {
      const record = await OrderModel.findOne({ 'payment.transaction_id': cleanId }).lean();
      return record ? new Order(record) : null;
    }
    const record = (store.orders || []).find((order) => order.payment?.transaction_id === cleanId);
    return record ? new Order(record) : null;
  }

  async listForCheckoutReconciliation({ olderThan, limit = 50 } = {}) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
    if (isMongoConnected()) {
      const records = await OrderModel.find({
        $or: [
          {
            'payment.gateway': 'razorpay',
            'payment.payment_status': 'Pending',
            'fulfillment.status': { $in: ['New', 'Preparing'] },
            ...(olderThan ? { created_at: { $lt: olderThan } } : {}),
          },
          { 'fulfillment.status': 'Cancelled', 'fulfillment.inventory_release_status': 'pending' },
        ],
      }).sort({ created_at: 1 }).limit(safeLimit).lean();
      return records.map((record) => new Order(record));
    }
    return (store.orders || [])
      .filter((order) => (
        (order.payment?.gateway === 'razorpay' && order.payment?.payment_status === 'Pending' &&
          ['New', 'Preparing'].includes(order.fulfillment?.status || 'New') &&
          (!olderThan || new Date(order.created_at) < new Date(olderThan))) ||
        (order.fulfillment?.status === 'Cancelled' && order.fulfillment?.inventory_release_status === 'pending')
      ))
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      .slice(0, safeLimit)
      .map((order) => new Order(order));
  }

  async expirePendingRazorpayOrder(orderId, paymentIntentId, olderThan) {
    const cleanId = String(orderId || '').trim();
    const intentId = String(paymentIntentId || '').trim();
    const now = new Date();
    const label = 'Unpaid Razorpay checkout expired; reserved stock release is pending';
    if (isMongoConnected()) {
      const record = await OrderModel.findOneAndUpdate({
        $or: [{ order_id: cleanId }, { id: cleanId }],
        'payment.gateway': 'razorpay',
        'payment.payment_status': 'Pending',
        'payment.payment_intent_id': intentId,
        'fulfillment.status': { $in: ['New', 'Preparing'] },
        'fulfillment.shiprocket_shipment_id': { $in: ['', null] },
        'fulfillment.awb_code': { $in: ['', null] },
        created_at: { $lt: olderThan },
      }, {
        $set: {
          'payment.gateway_status': 'expired',
          'fulfillment.status': 'Cancelled',
          'fulfillment.cancellation_reason': 'Payment was not completed before the checkout hold expired.',
          'fulfillment.cancelled_at': now,
          'fulfillment.inventory_release_status': 'pending',
          updated_at: now,
        },
        $push: { timeline: { label, timestamp: now, done: true } },
      }, { new: true }).lean();
      return record ? new Order(record) : null;
    }
    const raw = (store.orders || []).find((order) => order.order_id === cleanId || order.id === cleanId);
    if (!raw || raw.payment?.gateway !== 'razorpay' || raw.payment?.payment_status !== 'Pending' ||
        raw.payment?.payment_intent_id !== intentId || !['New', 'Preparing'].includes(raw.fulfillment?.status || 'New') ||
        raw.fulfillment?.shiprocket_shipment_id || raw.fulfillment?.awb_code || new Date(raw.created_at) >= new Date(olderThan)) return null;
    raw.payment = { ...raw.payment, gateway_status: 'expired' };
    raw.fulfillment = {
      ...raw.fulfillment,
      status: 'Cancelled',
      cancellation_reason: 'Payment was not completed before the checkout hold expired.',
      cancelled_at: now.toISOString(),
      inventory_release_status: 'pending',
    };
    raw.timeline = [...(raw.timeline || []), { label, timestamp: now.toISOString(), done: true }];
    raw.updated_at = now.toISOString();
    return new Order(raw);
  }

  async markInventoryReleaseComplete(orderId) {
    const now = new Date();
    const filter = { $or: [{ order_id: String(orderId) }, { id: String(orderId) }], 'fulfillment.status': 'Cancelled' };
    if (isMongoConnected()) {
      await OrderModel.updateOne(filter, { $set: { 'fulfillment.inventory_release_status': 'completed', updated_at: now } });
      return;
    }
    const record = (store.orders || []).find((order) => order.order_id === String(orderId) || order.id === String(orderId));
    if (record?.fulfillment?.status === 'Cancelled') {
      record.fulfillment.inventory_release_status = 'completed';
      record.updated_at = now.toISOString();
    }
  }

  async markPaymentCaptured({ orderId, paymentIntentId, paymentId, paymentSignature = null }) {
    const now = new Date();
    if (isMongoConnected()) {
      const record = await OrderModel.findOneAndUpdate({
        $or: [{ order_id: String(orderId) }, { id: String(orderId) }],
        'payment.payment_intent_id': String(paymentIntentId),
        'payment.payment_status': { $in: ['Pending', 'Failed'] },
        'fulfillment.status': { $nin: ['Cancelled', 'Refunded'] },
      }, {
        $set: {
          'payment.payment_status': 'Paid',
          'payment.gateway_status': 'captured',
          'payment.transaction_id': String(paymentId),
          'payment.payment_signature': paymentSignature,
          'payment.paid_at': now,
          updated_at: now,
        },
        $push: { timeline: { label: 'Payment verified', timestamp: now, done: true } },
      }, { new: true }).lean();
      return record ? new Order(record) : null;
    }
    const record = (store.orders || []).find((order) => order.order_id === String(orderId) || order.id === String(orderId));
    if (!record || record.payment?.payment_intent_id !== String(paymentIntentId) ||
        !['Pending', 'Failed'].includes(record.payment?.payment_status || 'Pending') ||
        ['Cancelled', 'Refunded'].includes(record.fulfillment?.status)) return null;
    record.payment = { ...record.payment, payment_status: 'Paid', gateway_status: 'captured', transaction_id: String(paymentId), payment_signature: paymentSignature, paid_at: now.toISOString() };
    record.timeline = [...(record.timeline || []), { label: 'Payment verified', timestamp: now.toISOString(), done: true }];
    record.updated_at = now.toISOString();
    return new Order(record);
  }

  async findByAwb(awbCode) {
    const awb = String(awbCode || '').trim();
    if (!awb) return null;
    if (isMongoConnected()) {
      const record = await OrderModel.findOne({ $or: [
        { 'fulfillment.awb_code': awb }, { 'fulfillment.tracking_number': awb },
      ] }).lean();
      return record ? new Order(record) : null;
    }
    if (!Array.isArray(store.orders)) return null;
    const record = store.orders.find((item) =>
      item.fulfillment?.awb_code === awb || item.fulfillment?.tracking_number === awb);
    return record ? new Order(record) : null;
  }

  async claimShiprocketShipment(orderId) {
    const cleanId = String(orderId || '').trim();
    if (!cleanId) return null;

    const canClaim = {
      $and: [
        { $or: [{ order_id: cleanId }, { id: cleanId }] },
        { 'fulfillment.status': 'Preparing' },
        { 'fulfillment.shiprocket_shipment_id': { $in: ['', null] } },
        { 'fulfillment.awb_code': { $in: ['', null] } },
        { 'fulfillment.shiprocket_status': { $nin: ['processing', 'needs_review', 'created'] } },
      ],
    };

    if (isMongoConnected()) {
      const record = await OrderModel.findOneAndUpdate(
        canClaim,
        {
          $set: {
            'fulfillment.shiprocket_status': 'processing',
            updated_at: new Date().toISOString(),
          },
        },
        { new: true },
      ).lean();
      return record ? new Order(record) : null;
    }

    if (!Array.isArray(store.orders)) return null;
    const record = store.orders.find((item) => item.order_id === cleanId || item.id === cleanId);
    if (!record || record.fulfillment?.status !== 'Preparing') return null;
    if (record.fulfillment?.shiprocket_shipment_id || record.fulfillment?.awb_code) return null;
    if (['processing', 'needs_review', 'created'].includes(record.fulfillment?.shiprocket_status)) return null;

    record.fulfillment = { ...record.fulfillment, shiprocket_status: 'processing' };
    record.updated_at = new Date().toISOString();
    return new Order(record);
  }

  async claimShiprocketReturn(orderId) {
    const cleanId = String(orderId || '').trim();
    if (!cleanId) return null;
    const canClaim = {
      $and: [
        { $or: [{ order_id: cleanId }, { id: cleanId }] },
        { 'fulfillment.status': 'Return requested' },
        { 'fulfillment.shiprocket_return_shipment_id': { $in: ['', null] } },
        { 'fulfillment.shiprocket_return_awb': { $in: ['', null] } },
        { 'fulfillment.shiprocket_status': { $nin: ['return_processing', 'return_needs_review', 'return_created'] } },
      ],
    };
    if (isMongoConnected()) {
      const record = await OrderModel.findOneAndUpdate(canClaim, {
        $set: { 'fulfillment.shiprocket_status': 'return_processing', updated_at: new Date().toISOString() },
      }, { new: true }).lean();
      return record ? new Order(record) : null;
    }
    const record = (store.orders || []).find((item) => item.order_id === cleanId || item.id === cleanId);
    if (!record || record.fulfillment?.status !== 'Return requested') return null;
    if (record.fulfillment?.shiprocket_return_shipment_id || record.fulfillment?.shiprocket_return_awb || ['return_processing', 'return_needs_review', 'return_created'].includes(record.fulfillment?.shiprocket_status)) return null;
    record.fulfillment = { ...record.fulfillment, shiprocket_status: 'return_processing' };
    record.updated_at = new Date().toISOString();
    return new Order(record);
  }

  async findByIdempotencyKey(key, userId) {
    if (!key) return null;
    const cleanKey = String(key).trim();
    const cleanUserId = String(userId).trim();

    if (isMongoConnected()) {
      const record = await OrderModel.findOne({
        idempotency_key: cleanKey,
        user_id: cleanUserId,
      }).lean();
      if (!record) return null;
      return new Order(record);
    }

    if (!Array.isArray(store.orders)) store.orders = [];
    const found = store.orders.find(
      (o) => o.idempotency_key === cleanKey && String(o.user_id) === cleanUserId,
    );
    if (!found) return null;
    return new Order(found);
  }

  async listByUserId(userId, { page = 1, limit = 20, status } = {}) {
    const cleanUserId = String(userId).trim();
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (safePage - 1) * safeLimit;

    if (isMongoConnected()) {
      const query = { user_id: cleanUserId };
      if (status && status !== 'All' && status !== 'all') {
        const lower = status.toLowerCase();
        if (lower === 'pending') {
          query['fulfillment.status'] = { $in: ['New', 'Preparing'] };
        } else if (lower === 'confirmed') {
          query['fulfillment.status'] = { $in: ['Shipped', 'Delivered'] };
        } else if (lower === 'cancelled') {
          query['fulfillment.status'] = { $in: ['Cancelled', 'Refunded', 'Return requested'] };
        } else {
          query['fulfillment.status'] = status;
        }
      }
      const [records, total] = await Promise.all([
        OrderModel.find(query).sort({ created_at: -1 }).skip(skip).limit(safeLimit).lean(),
        OrderModel.countDocuments(query),
      ]);
      return {
        items: records.map((r) => new Order(r)),
        total,
        page: safePage,
        limit: safeLimit,
        has_more: skip + records.length < total,
      };
    }

    if (!Array.isArray(store.orders)) store.orders = [];
    let filtered = store.orders.filter((o) => String(o.user_id) === cleanUserId);
    if (status && status !== 'All' && status !== 'all') {
      const lower = status.toLowerCase();
      filtered = filtered.filter((o) => {
        const st = (o.fulfillment?.status || o.status || 'New').toString().toLowerCase();
        if (lower === 'pending') return st === 'new' || st === 'preparing';
        if (lower === 'confirmed') return st === 'shipped' || st === 'delivered';
        if (lower === 'cancelled') return st === 'cancelled' || st === 'refunded' || st.includes('return');
        return st === lower;
      });
    }
    filtered.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const total = filtered.length;
    const items = filtered.slice(skip, skip + safeLimit).map((o) => new Order(o));
    return {
      items,
      total,
      page: safePage,
      limit: safeLimit,
      has_more: skip + items.length < total,
    };
  }

  async listAdmin({
    status,
    paymentStatus,
    search,
    fromDate,
    toDate,
    page = 1,
    limit = 50,
  } = {}) {
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const skip = (safePage - 1) * safeLimit;

    if (isMongoConnected()) {
      const andClauses = [];
      if (status && status !== 'All' && status !== 'all') {
        andClauses.push({ 'fulfillment.status': status });
      }
      if (paymentStatus && paymentStatus !== 'All' && paymentStatus !== 'all') {
        andClauses.push({ 'payment.payment_status': paymentStatus });
      }
      if (fromDate) {
        andClauses.push({ created_at: { $gte: new Date(fromDate) } });
      }
      if (toDate) {
        andClauses.push({ created_at: { $lte: new Date(toDate) } });
      }
      if (search && search.trim()) {
        const regex = new RegExp(escapeRegex(search.trim()), 'i');
        andClauses.push({
          $or: [
            { order_id: regex },
            { 'customer.name': regex },
            { 'customer.email': regex },
            { 'customer.phone': regex },
            { 'fulfillment.tracking_number': regex },
            { 'items.title': regex },
          ],
        });
      }

      const query = andClauses.length > 0 ? (andClauses.length === 1 ? andClauses[0] : { $and: andClauses }) : {};
      const [records, total] = await Promise.all([
        OrderModel.find(query).sort({ created_at: -1 }).skip(skip).limit(safeLimit).lean(),
        OrderModel.countDocuments(query),
      ]);

      return {
        items: records.map((r) => new Order(r)),
        total,
        page: safePage,
        limit: safeLimit,
        has_more: skip + records.length < total,
      };
    }

    if (!Array.isArray(store.orders)) store.orders = [];
    let list = [...store.orders];

    if (status && status !== 'All' && status !== 'all') {
      list = list.filter((o) => (o.fulfillment?.status || o.status) === status);
    }
    if (paymentStatus && paymentStatus !== 'All' && paymentStatus !== 'all') {
      list = list.filter((o) => (o.payment?.payment_status || o.payment_status) === paymentStatus);
    }
    if (fromDate) {
      const from = new Date(fromDate).getTime();
      list = list.filter((o) => new Date(o.created_at).getTime() >= from);
    }
    if (toDate) {
      const to = new Date(toDate).getTime();
      list = list.filter((o) => new Date(o.created_at).getTime() <= to);
    }
    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((o) => {
        const id = (o.order_id || o.id || '').toLowerCase();
        const name = (o.customer?.name || '').toLowerCase();
        const email = (o.customer?.email || '').toLowerCase();
        const phone = (o.customer?.phone || '').toLowerCase();
        const tracking = (o.fulfillment?.tracking_number || o.trackingNumber || '').toLowerCase();
        const items = Array.isArray(o.items) ? o.items.map((i) => (i.title || i.name || '').toLowerCase()).join(' ') : '';
        return id.includes(q) || name.includes(q) || email.includes(q) || phone.includes(q) || tracking.includes(q) || items.includes(q);
      });
    }

    list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const total = list.length;
    const items = list.slice(skip, skip + safeLimit).map((o) => new Order(o));
    return {
      items,
      total,
      page: safePage,
      limit: safeLimit,
      has_more: skip + items.length < total,
    };
  }

  async update(orderId, patch) {
    const existing = await this.findById(orderId);
    if (!existing) {
      throw new NotFoundError('Order not found');
    }

    const updatedData = {
      ...existing.toJSON(),
      ...patch,
      updated_at: new Date().toISOString(),
    };
    if (patch.payment) {
      updatedData.payment = { ...existing.payment, ...patch.payment };
      updatedData.payment_status = updatedData.payment.payment_status;
      updatedData.paymentStatus = updatedData.payment.payment_status;
    }
    if (patch.fulfillment) {
      updatedData.fulfillment = { ...existing.fulfillment, ...patch.fulfillment };
      updatedData.fulfillment_status = updatedData.fulfillment.status;
      updatedData.status = updatedData.fulfillment.status;
    }

    const updated = new Order(updatedData);

    if (isMongoConnected()) {
      await OrderModel.findOneAndUpdate(
        { $or: [{ order_id: existing.order_id }, { id: existing.order_id }] },
        { $set: updated.toJSON() },
        { new: true },
      );
      return updated;
    }

    if (!Array.isArray(store.orders)) store.orders = [];
    const idx = store.orders.findIndex((o) => o.order_id === existing.order_id || o.id === existing.order_id);
    if (idx >= 0) {
      store.orders[idx] = updated.toJSON();
    }
    return updated;
  }
}
