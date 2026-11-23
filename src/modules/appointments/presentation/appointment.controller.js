import { BadGatewayError, BadRequestError, ConflictError, NotFoundError } from '../../../shared/errors/index.js';
import { createHash, randomUUID } from 'node:crypto';
import { sendSuccess } from '../../../shared/utils/response.js';
import { sendPushNotification } from '../../notifications/infrastructure/FirebaseAdminMessaging.js';
import { clinicDateTimeParts, isValidTimeZone } from '../domain/clinic-time.js';

const appointmentStatuses = ['Requested', 'Confirmed', 'Arrived', 'In Consultation', 'Completed', 'Cancelled', 'No show'];
const clinicWeekdayNumbers = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
// Keep old Razorpay records provider-managed while all new online payment
// sessions are created through the Cashfree gateway service.
const onlineGatewayMethods = new Set(['cashfree', 'razorpay', 'online', 'online / pre-paid', 'prepaid', 'pre-paid']);

const localParts = (date, timeZone = 'UTC') => clinicDateTimeParts(date, timeZone);

const normalizeStartsAt = (value) => {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) throw new BadRequestError('starts_at must be a valid ISO date-time.');
  return date.toISOString();
};

const dateKeyFor = (startsAt, timeZone = 'UTC') => {
  const parts = localParts(new Date(startsAt), timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
};

const validateDateKey = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

const minutesFromClinicClock = (value) => {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
};

const toClinicSlotKey = (startsAt, timeZone = 'UTC') => {
  const parts = localParts(new Date(startsAt), timeZone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
};

export class AppointmentController {
  constructor({
    appointmentRepository,
    userRepository,
    patientActivityRepository,
    notificationRepository,
    deviceTokenRepository,
    auditEventRepository,
    paymentGatewayService,
    featureFlagRepository,
  }) {
    this.appointmentRepository = appointmentRepository;
    this.userRepository = userRepository;
    this.patientActivityRepository = patientActivityRepository;
    this.notificationRepository = notificationRepository;
    this.deviceTokenRepository = deviceTokenRepository;
    this.auditEventRepository = auditEventRepository;
    this.paymentGatewayService = paymentGatewayService;
    this.featureFlagRepository = featureFlagRepository;
    this._cachedBilling = null;
    this._cachedBillingAt = 0;
    this._cachedSchedule = null;
    this._cachedScheduleAt = 0;
    this._cachedAvailability = new Map();
    this._cachedAvailabilityTtl = 20000;
  }

  invalidateAvailabilityCache = () => {
    this._cachedAvailability?.clear();
  };

  notifyPatient = async ({ userId, appointmentId, title, body }) => {
    if (!this.notificationRepository || !userId) return;
    try {
      const notification = await this.notificationRepository.create({
        userId: Number(userId),
        title,
        body,
        type: 'appointment',
        destination: { type: 'screen', screen: 'clinic_appointment', entityId: appointmentId },
        data: { appointment_id: appointmentId, destination_type: 'screen', screen: 'clinic_appointment' },
      });
      const tokens = await this.deviceTokenRepository?.listByUserId(userId) || [];
      await Promise.all(tokens.map(({ token }) => sendPushNotification({
        token,
        title,
        body,
        data: { notification_id: notification.id, destination_type: 'screen', screen: 'clinic_appointment', entity_id: appointmentId },
      }).catch(() => {})));
    } catch {
      // Appointment/payment state must remain authoritative if notification delivery is unavailable.
    }
  };

  getBillingConfig = async () => {
    if (this._cachedBilling && (Date.now() - this._cachedBillingAt < 60000)) {
      return this._cachedBilling;
    }
    if (this.featureFlagRepository) {
      try {
        const flag = await this.featureFlagRepository.getFlag('clinic_appointment_billing');
        if (flag) {
          const rawFee = flag.metadata?.consultation_fee;
          const fee = typeof rawFee === 'number' || (typeof rawFee === 'string' && rawFee.trim() !== '')
            ? Number(rawFee)
            : 500;
          const configured = flag.metadata?.configured !== false && Number.isFinite(fee) && fee >= 0;
          const pay_at_clinic_enabled = flag.metadata?.pay_at_clinic_enabled != null
            ? Boolean(flag.metadata.pay_at_clinic_enabled)
            : (flag.metadata?.payment_required != null ? !flag.metadata.payment_required : true);
          const online_pay_enabled = flag.metadata?.online_pay_enabled != null
            ? Boolean(flag.metadata.online_pay_enabled)
            : (flag.metadata?.payment_required != null ? Boolean(flag.metadata.payment_required) : true);
          const effectivePayAtClinic = pay_at_clinic_enabled || !online_pay_enabled;
          const effectiveOnlinePay = online_pay_enabled;
          const result = {
            configured,
            pay_at_clinic_enabled: configured ? effectivePayAtClinic : true,
            online_pay_enabled: configured ? effectiveOnlinePay : true,
            payment_required: configured ? (effectiveOnlinePay && !effectivePayAtClinic) : false,
            consultation_fee: configured ? fee : 500,
            currency: String(flag.metadata?.currency ?? 'INR'),
            first_appointment_free: Boolean(flag.metadata?.first_appointment_free ?? false),
          };
          this._cachedBilling = result;
          this._cachedBillingAt = Date.now();
          return result;
        }
      } catch (_) {}
    }
    return {
      configured: true,
      pay_at_clinic_enabled: true,
      online_pay_enabled: true,
      payment_required: false,
      consultation_fee: 500,
      currency: 'INR',
      first_appointment_free: false,
    };
  };

  getScheduleConfig = async () => {
    if (this._cachedSchedule && (Date.now() - this._cachedScheduleAt < 60000)) {
      return this._cachedSchedule;
    }
    const flag = await this.featureFlagRepository?.getFlag('clinic_appointment_schedule');
    const metadata = flag?.metadata;
    const slotInterval = Number(metadata?.slot_interval_minutes || 30);
    const appointmentDuration = Number(metadata?.appointment_duration_minutes || 30);
    const rawSessions = Array.isArray(metadata?.sessions) && metadata.sessions.length > 0
      ? metadata.sessions
      : [
          { label: 'Morning OPD', opens_at: '09:00', closes_at: '13:00' },
          { label: 'Evening OPD', opens_at: '16:00', closes_at: '20:00' },
        ];
    const rawServices = Array.isArray(metadata?.appointment_services) && metadata.appointment_services.length > 0
      ? metadata.appointment_services
      : [
          'General hair & scalp consultation',
          'PRP / GFC Hair Therapy Assessment',
          'Trichoscopy Diagnostic Scan',
          'Hair Loss & Scalp Density Check',
        ];
    const timezone = String(metadata?.timezone || 'Asia/Kolkata');
    const validTz = isValidTimeZone(timezone) ? timezone : 'Asia/Kolkata';

    const result = {
      timezone: validTz,
      booking_window_days: Number(metadata?.booking_window_days) || 30,
      weekly_closed_weekdays: Array.isArray(metadata?.weekly_closed_weekdays) ? metadata.weekly_closed_weekdays : [7],
      slot_interval_minutes: Number.isInteger(slotInterval) && slotInterval >= 5 && slotInterval <= 60 ? slotInterval : 30,
      sessions: rawSessions,
      clinic_name: String(metadata?.clinic_name || 'Dr. Hair & Cosmodent Clinic'),
      clinic_address: String(metadata?.clinic_address || 'SCO 42, Sector 11, Panchkula, Haryana 134109'),
      doctor_name: String(metadata?.doctor_name || 'Dr. Jai Bansal'),
      room: String(metadata?.room || 'Consultation Room 1'),
      appointment_duration_minutes: Number.isInteger(appointmentDuration) && appointmentDuration >= 5 ? appointmentDuration : 30,
      appointment_services: rawServices,
      max_daily_appointments: Number(metadata?.max_daily_appointments ?? metadata?.daily_limit) || 0,
      is_configured: true,
    };
    this._cachedSchedule = result;
    this._cachedScheduleAt = Date.now();
    return result;
  };

  getScheduleConfigAdmin = async (_req, res, next) => {
    try {
      return sendSuccess(res, { data: (await this.getScheduleConfig()) || {
        timezone: 'Asia/Kolkata', booking_window_days: null, weekly_closed_weekdays: [7],
        slot_interval_minutes: null, sessions: [], clinic_name: '', clinic_address: '', doctor_name: '', room: '',
        appointment_duration_minutes: null, appointment_services: [], max_daily_appointments: 0, is_configured: false,
      } });
    } catch (error) { next(error); }
  };

  updateScheduleConfigAdmin = async (req, res, next) => {
    try {
      if (!this.featureFlagRepository) throw new BadRequestError('Clinic schedule settings are not configured.');
      const { booking_window_days, weekly_closed_weekdays, slot_interval_minutes, sessions } = req.body || {};
      const windowDays = Number(booking_window_days);
      const interval = Number(slot_interval_minutes);
      if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 365) {
        throw new BadRequestError('Booking window must be between 1 and 365 days.');
      }
      if (!Number.isInteger(interval) || interval < 5 || interval > 60 || 60 % interval !== 0) {
        throw new BadRequestError('Slot interval must be a whole divisor of 60 between 5 and 60 minutes.');
      }
      if (!Array.isArray(weekly_closed_weekdays) || weekly_closed_weekdays.some((day) => !Number.isInteger(Number(day)) || Number(day) < 1 || Number(day) > 7)) {
        throw new BadRequestError('Closed weekdays must be a list of weekday numbers from 1 (Monday) to 7 (Sunday).');
      }
      if (!Array.isArray(sessions) || sessions.length === 0 || sessions.length > 8) {
        throw new BadRequestError('Add between 1 and 8 clinic sessions.');
      }
      const normalizedSessions = sessions.map((session, index) => {
        const label = String(session?.label || '').trim().slice(0, 50);
        const opensAt = String(session?.opens_at || '');
        const closesAt = String(session?.closes_at || '');
        if (!label || !/^([01]\d|2[0-3]):[0-5]\d$/.test(opensAt) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(closesAt)) {
          throw new BadRequestError(`Session ${index + 1} needs a name and valid 24-hour opening and closing times.`);
        }
        if (minutesFromClinicClock(closesAt) <= minutesFromClinicClock(opensAt)) {
          throw new BadRequestError(`Session ${label} must close after it opens.`);
        }
        return { label, opens_at: opensAt, closes_at: closesAt };
      }).sort((a, b) => minutesFromClinicClock(a.opens_at) - minutesFromClinicClock(b.opens_at));
      for (let index = 1; index < normalizedSessions.length; index += 1) {
        if (minutesFromClinicClock(normalizedSessions[index].opens_at) < minutesFromClinicClock(normalizedSessions[index - 1].closes_at)) {
          throw new BadRequestError('Clinic sessions cannot overlap.');
        }
      }

      const appointmentDuration = Number(req.body?.appointment_duration_minutes);
      if (!Number.isInteger(appointmentDuration) || appointmentDuration < 5 || appointmentDuration > 240) {
        throw new BadRequestError('Appointment duration must be between 5 and 240 minutes.');
      }
      if (interval < appointmentDuration) {
        throw new BadRequestError('Slot interval must be at least as long as the appointment duration to prevent overlapping visits.');
      }
      const appointmentServices = Array.isArray(req.body?.appointment_services)
        ? [...new Set(req.body.appointment_services.map((service) => String(service || '').trim()).filter(Boolean))]
        : [];
      if (appointmentServices.length === 0 || appointmentServices.length > 30 || appointmentServices.some((service) => service.length > 100)) {
        throw new BadRequestError('Add between 1 and 30 appointment services, each no longer than 100 characters.');
      }
      const timezone = String(req.body?.timezone || '').trim();
      if (!timezone || !isValidTimeZone(timezone)) throw new BadRequestError('Choose a valid IANA clinic timezone, such as Asia/Kolkata.');

      const rawMaxDaily = req.body?.max_daily_appointments != null
        ? Number(req.body.max_daily_appointments)
        : (req.body?.daily_limit != null ? Number(req.body.daily_limit) : 0);
      const maxDailyAppointments = Number.isInteger(rawMaxDaily) && rawMaxDaily >= 0 && rawMaxDaily <= 500
        ? rawMaxDaily
        : 0;
      if (req.body?.max_daily_appointments != null && (!Number.isInteger(Number(req.body.max_daily_appointments)) || Number(req.body.max_daily_appointments) < 0 || Number(req.body.max_daily_appointments) > 500)) {
        throw new BadRequestError('Daily appointment limit must be a number between 0 and 500 (0 for unlimited).');
      }

      const actor = req.user?.email || req.user?.login || 'Clinic admin';
      const updated = await this.featureFlagRepository.setFlag('clinic_appointment_schedule', {
        title: 'Clinic Appointment Schedule',
        description: 'Server-owned clinic sessions, booking window, and weekly closed days.',
        group: 'Appointments',
        enabled: true,
        metadata: {
          timezone,
          booking_window_days: windowDays,
          weekly_closed_weekdays: [...new Set(weekly_closed_weekdays.map(Number))].sort((a, b) => a - b),
          slot_interval_minutes: interval,
          sessions: normalizedSessions,
          clinic_name: String(req.body?.clinic_name || '').trim().slice(0, 120),
          clinic_address: String(req.body?.clinic_address || '').trim().slice(0, 300),
          doctor_name: String(req.body?.doctor_name || '').trim().slice(0, 120),
          room: String(req.body?.room || '').trim().slice(0, 120),
          appointment_duration_minutes: appointmentDuration,
          appointment_services: appointmentServices,
          max_daily_appointments: maxDailyAppointments,
        },
        updatedBy: actor,
      });
      this._cachedSchedule = null;
      this._cachedScheduleAt = 0;
      this.invalidateAvailabilityCache();
      if (this.auditEventRepository?.record) await this.auditEventRepository.record({
        actor, action: 'appointment_schedule.updated', target: 'clinic_appointment_schedule',
        metadata: updated.metadata,
      }).catch(() => null);
      return sendSuccess(res, { message: 'Clinic appointment schedule updated.', data: await this.getScheduleConfig() });
    } catch (error) { next(error); }
  };

  getBillingConfigPatient = async (req, res, next) => {
    try {
      const billing = await this.getBillingConfig();
      let isFirstAppointment = true;
      if (req.user?.id) {
        const pastAppointments = await this.appointmentRepository.listByPatient(req.user.id);
        const activeOrCompleted = (pastAppointments || []).filter(
          (apt) => apt.status !== 'Cancelled'
        );
        isFirstAppointment = activeOrCompleted.length === 0;
      }
      const isFirstFree = billing.first_appointment_free && isFirstAppointment;
      const effectiveFee = isFirstFree ? 0 : billing.consultation_fee;
      const effectivePaymentRequired = isFirstFree ? false : billing.payment_required;
      const effectivePayAtClinic = isFirstFree ? true : billing.pay_at_clinic_enabled;
      const effectiveOnlinePay = isFirstFree ? false : billing.online_pay_enabled;

      return sendSuccess(res, {
        data: {
          ...billing,
          is_first_appointment: isFirstAppointment,
          effective_fee: effectiveFee,
          effective_payment_required: effectivePaymentRequired,
          pay_at_clinic_enabled: effectivePayAtClinic,
          online_pay_enabled: effectiveOnlinePay,
        },
      });
    } catch (error) { next(error); }
  };

  getBillingConfigAdmin = async (req, res, next) => {
    try {
      const billing = await this.getBillingConfig();
      return sendSuccess(res, { data: billing });
    } catch (error) { next(error); }
  };

  updateBillingConfigAdmin = async (req, res, next) => {
    try {
      if (!this.featureFlagRepository) throw new BadRequestError('Feature flag repository not configured.');
      const pay_at_clinic_enabled = req.body?.pay_at_clinic_enabled != null
        ? Boolean(req.body.pay_at_clinic_enabled)
        : (req.body?.payment_required != null ? !req.body.payment_required : true);
      const online_pay_enabled = req.body?.online_pay_enabled != null
        ? Boolean(req.body.online_pay_enabled)
        : (req.body?.payment_required != null ? Boolean(req.body.payment_required) : true);

      if (!pay_at_clinic_enabled && !online_pay_enabled) {
        throw new BadRequestError('At least one payment option (Pay at Clinic or Online Payment) must be active.');
      }
      const consultation_fee = Number(req.body?.consultation_fee);
      if (!Number.isFinite(consultation_fee) || consultation_fee < 0) {
        throw new BadRequestError('Set a valid non-negative consultation fee before saving appointment billing.');
      }
      const first_appointment_free = req.body?.first_appointment_free != null ? Boolean(req.body.first_appointment_free) : false;
      const actor = req.user?.email || req.user?.login || 'Super Admin';
      const payment_required = online_pay_enabled && !pay_at_clinic_enabled;

      const updated = await this.featureFlagRepository.setFlag('clinic_appointment_billing', {
        title: 'Clinic Appointment Billing',
        description: 'Payment options (Pay at clinic & online payment) and consultation fee configuration.',
        group: 'Appointments',
        enabled: payment_required,
        metadata: {
          configured: true,
          consultation_fee,
          currency: 'INR',
          pay_at_clinic_enabled,
          online_pay_enabled,
          payment_required,
          first_appointment_free,
        },
        updatedBy: actor,
      });

      this._cachedBilling = null;
      this._cachedBillingAt = 0;
      if (this.auditEventRepository?.record) {
        await this.auditEventRepository.record({
          actor,
          action: 'appointment_billing.updated',
          target: 'clinic_appointment_billing',
          metadata: { pay_at_clinic_enabled, online_pay_enabled, payment_required, consultation_fee, first_appointment_free },
        }).catch(() => null);
      }

      return sendSuccess(res, {
        message: 'Appointment billing settings updated.',
        data: {
          configured: true,
          pay_at_clinic_enabled,
          online_pay_enabled,
          payment_required,
          consultation_fee: Number(updated.metadata?.consultation_fee ?? consultation_fee),
          currency: 'INR',
          first_appointment_free: Boolean(updated.metadata?.first_appointment_free ?? first_appointment_free),
        },
      });
    } catch (error) { next(error); }
  };

  createPaymentIntent = async (req, res, next) => {
    try {
      if (!this.paymentGatewayService) {
        throw new BadRequestError('Payment gateway service is not configured.');
      }
      const starts_at = normalizeStartsAt(req.body?.starts_at);
      const reason = String(req.body?.reason || '').trim().slice(0, 500);
      if (!reason) throw new BadRequestError('Choose an appointment service before creating a payment intent.');
      await this.validateSlot(starts_at, { patientRequest: true });

      const billing = await this.getBillingConfig();
      if (!billing.configured) throw new BadRequestError('Appointment billing has not been configured by the clinic yet.');
      let isFirstAppointment = false;
      if (req.user?.id) {
        const list = await this.appointmentRepository.listByPatient(req.user.id);
        const nonCancelled = (list || []).filter((apt) => apt.status !== 'Cancelled');
        isFirstAppointment = nonCancelled.length === 0;
      }
      if (billing.first_appointment_free && isFirstAppointment) {
        throw new BadRequestError('Your first consultation is free! Online payment is not required.');
      }

      if (!billing.online_pay_enabled) {
        throw new BadRequestError('Online payment is currently disabled. Please choose Pay at clinic.');
      }

      const fee = billing.consultation_fee;
      if (fee <= 0) {
        throw new BadRequestError('Consultation fee is ₹0 or online payment is not required.');
      }

      const patient = await this.userRepository.findById(req.user.id);
      const tempOrderId = `APT-${Date.now()}-${req.user.id}-${randomUUID().slice(0, 8)}`;

      const intent = await this.paymentGatewayService.createPaymentIntent({
        orderId: tempOrderId,
        amount: fee,
        currency: 'INR',
        customer: {
          name: patient?.name || '',
          email: patient?.email || '',
          phone: patient?.phone || '',
        },
        metadata: {
          patient_id: req.user.id,
          app_order_id: tempOrderId,
          starts_at,
          consultation_fee: fee,
          reason,
        },
      });

      return sendSuccess(res, {
        data: {
          orderId: intent.intentId,
          intent_id: intent.intentId,
          order_id: intent.orderId || intent.intentId,
          payment_session_id: intent.payment_session_id || null,
          provider: intent.gateway || this.paymentGatewayService.provider || 'cashfree',
          amount: intent.amount,
          amountFormatted: fee,
          currency: intent.currency || 'INR',
          starts_at,
          tempOrderId,
        },
      });
    } catch (error) { next(error); }
  };

  verifyAndBook = async (req, res, next) => {
    try {
      if (!this.paymentGatewayService) {
        throw new BadRequestError('Payment gateway service is not configured.');
      }
      const {
        starts_at: rawStartsAt,
        reason: rawReason,
        order_id,
        cashfree_order_id,
        payment_id,
      } = req.body || {};

      const effectiveOrderId = cashfree_order_id || order_id || req.body?.cf_order_id;
      const effectivePaymentId = payment_id || req.body?.reference_id || effectiveOrderId;

      if (!effectiveOrderId) {
        throw new BadRequestError('Cashfree order ID is required to verify appointment payment.');
      }

      const starts_at = normalizeStartsAt(rawStartsAt);
      const reason = String(rawReason || '').trim().slice(0, 500);
      if (!reason) throw new BadRequestError('Choose an appointment service before payment verification.');

      const alreadyBooked = effectivePaymentId !== effectiveOrderId
        ? await this.appointmentRepository.findByPaymentTransactionId(effectivePaymentId)
        : null;
      if (alreadyBooked) {
        if (Number(alreadyBooked.userId) !== Number(req.user.id) ||
            alreadyBooked.starts_at !== starts_at) {
          throw new ConflictError('This payment has already been used for another appointment. Contact the clinic before retrying.');
        }
        const existingPatient = await this.userRepository.findById(req.user.id);
        return sendSuccess(res, {
          message: 'This payment was already verified and its appointment is confirmed.',
          data: this.serialize(alreadyBooked, existingPatient),
        });
      }

      const order = await this.paymentGatewayService.getPaymentOrder(effectiveOrderId);
      const orderNotes = order?.order_tags || order?.notes || {};
      const expectedFee = Number(orderNotes.consultation_fee);
      const generatedOrderIdPattern = new RegExp(`^APT-\\d+-${Number(req.user.id)}-[a-f0-9]{8}$`);
      const returnedOrderId = order?.order_id || order?.id;
      const orderAmountInRupees = order?.order_amount !== undefined ? Number(order.order_amount) : Number(order?.amount) / 100;
      const orderCurrency = order?.order_currency || order?.currency || 'INR';

      const orderBelongsToRequest =
        returnedOrderId === effectiveOrderId &&
        String(orderNotes.patient_id || '') === String(req.user.id) &&
        String(orderNotes.starts_at || '') === starts_at &&
        typeof orderNotes.app_order_id === 'string' &&
        generatedOrderIdPattern.test(orderNotes.app_order_id) &&
        Number.isFinite(expectedFee) && expectedFee > 0 &&
        orderAmountInRupees === expectedFee &&
        orderCurrency === 'INR';
      if (!orderBelongsToRequest) {
        throw new BadRequestError('Cashfree payment order does not match this patient, appointment time, or consultation fee.');
      }

      await this.validateSlot(starts_at, { patientRequest: true });
      const verifiedPayment = await this.paymentGatewayService.verifyCapturedPayment({
        orderId: effectiveOrderId,
        paymentId: effectivePaymentId,
        expectedOrderId: effectiveOrderId,
        expectedAmount: expectedFee,
        currency: 'INR',
      });
      const transactionId = verifiedPayment.transaction_id || effectivePaymentId;

      const fee = expectedFee;
      const patient = await this.userRepository.findById(req.user.id);
      const clinicConfig = await this.getScheduleConfig();
      const actor = patient?.patient_code || 'Patient';

      let appointment;
      try {
        appointment = await this.appointmentRepository.create({
          userId: Number(req.user.id),
          patient_code: patient?.patient_code || '',
          starts_at,
          timezone: clinicConfig?.timezone || 'Asia/Kolkata',
          reason,
          doctor_name: clinicConfig?.doctor_name || '',
          room: clinicConfig?.room || '',
          consultation_fee: fee,
          payment_status: 'Paid',
          payment_method: 'Cashfree',
          payment_transaction_id: transactionId,
          payment_order_id: effectiveOrderId,
          payment_time: new Date(),
          source: 'App',
          status: 'Confirmed',
          status_history: [{
            action: `booked via online payment (₹${fee} Paid via Cashfree · Txn: ${transactionId})`,
            status: 'Confirmed',
            changed_by: actor,
            starts_at,
          }],
        });
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error;

        const concurrentRetry = await this.appointmentRepository.findByPaymentTransactionId(transactionId);
        if (concurrentRetry) {
          if (Number(concurrentRetry.userId) === Number(req.user.id) && concurrentRetry.starts_at === starts_at) {
            return sendSuccess(res, {
              message: 'This payment was already verified and its appointment is confirmed.',
              data: this.serialize(concurrentRetry, patient),
            });
          }
          throw new ConflictError('This payment has already been used for another appointment. Contact the clinic before retrying.');
        }

        try {
          const refund = await this.paymentGatewayService.refundCapturedPayment({
            orderId: effectiveOrderId,
            paymentId: transactionId,
            amount: fee,
          });
          if (!refund?.id) throw new Error('Cashfree did not return a refund reference.');
          throw new ConflictError(`That clinic time was just booked. A refund has been initiated for payment ${transactionId} (refund ${refund.id}).`);
        } catch (refundError) {
          if (refundError instanceof ConflictError) throw refundError;
          throw new BadGatewayError(`Payment ${transactionId} was captured, but the clinic time could not be confirmed and refund status could not be verified. Contact the clinic with this payment reference.`);
        }
      }

      await this.patientActivityRepository.record({
        userId: req.user.id,
        patientCode: patient?.patient_code,
        type: 'appointment',
        title: 'Appointment booked (Paid)',
        summary: `${reason} · ${starts_at} · ₹${fee} Paid via Cashfree (${transactionId})`,
        actor: 'Patient app',
        metadata: {
          appointment_id: appointment.id,
          opd_token: appointment.opd_token,
          transaction_id: transactionId,
        },
      });

      if (this.auditEventRepository?.record) {
        await this.auditEventRepository.record({
          actor: patient?.name ? `${patient.name} (${patient?.patient_code || req.user.id})` : 'Patient',
          actorId: String(req.user.id),
          actorName: patient?.name || 'Patient',
          actorRole: 'patient',
          action: 'appointment.booked',
          target: `appointment:${appointment.id}`,
          targetType: 'appointment',
          details: {
            appointment_id: appointment.id,
            opd_token: appointment.opd_token,
            patient_name: patient?.name || 'Patient',
            patient_code: patient?.patient_code,
            reason,
            starts_at,
            consultation_fee: fee,
            payment_status: 'Paid',
            payment_method: 'Cashfree',
            transaction_id: transactionId,
          },
        }).catch(() => {});
      }

      this.invalidateAvailabilityCache();

      if (this.notificationRepository) {
        try {
          const notif = await this.notificationRepository.create({
            userId: Number(req.user.id),
            title: 'Appointment Confirmed & Paid',
            body: `Your clinic sitting for ${reason} is confirmed (Token #${appointment.opd_token || '1'}). Payment of ₹${fee} received.`,
            type: 'appointment',
            destination: {
              type: 'screen',
              screen: 'clinic_appointment',
              entityId: appointment.id,
            },
            data: {
              appointment_id: appointment.id,
              opd_token: String(appointment.opd_token || ''),
              destination_type: 'screen',
              screen: 'clinic_appointment',
            },
          });

          if (this.deviceTokenRepository) {
            const tokens = await this.deviceTokenRepository.listByUserId(req.user.id);
            for (const { token } of tokens) {
              await sendPushNotification({
                token,
                title: notif.title,
                body: notif.body,
                data: {
                  notification_id: notif.id,
                  destination_type: 'screen',
                  screen: 'clinic_appointment',
                  entity_id: appointment.id,
                },
              }).catch(() => {});
            }
          }
        } catch (_) {}
      }

      return sendSuccess(res, {
        message: 'Appointment confirmed and payment verified successfully.',
        data: this.serialize(appointment, patient),
        statusCode: 201,
      });
    } catch (error) { next(error); }
  };

  recoverCapturedPaymentFromWebhook = async (paymentEntity) => {
    const paymentId = String(paymentEntity?.id || '').trim();
    const razorpayOrderId = String(paymentEntity?.order_id || '').trim();
    if (!paymentId || !razorpayOrderId) throw new BadRequestError('Appointment payment event is missing payment references.');

    const existing = await this.appointmentRepository.findByPaymentTransactionId(paymentId);
    if (existing) return existing;

    const providerOrder = await this.paymentGatewayService.getPaymentOrder(razorpayOrderId);
    const notes = providerOrder?.notes || {};
    const patientId = String(notes.patient_id || '').trim();
    const starts_at = normalizeStartsAt(notes.starts_at);
    const reason = String(notes.reason || '').trim().slice(0, 500) || 'General hair & scalp consultation';
    const fee = Number(notes.consultation_fee);
    const generatedOrderIdPattern = new RegExp(`^APT-\\d+-${Number(patientId)}-[a-f0-9]{8}$`);
    if (!/^\d+$/.test(patientId) || !generatedOrderIdPattern.test(String(notes.app_order_id || '')) ||
        providerOrder?.id !== razorpayOrderId || String(paymentEntity.notes?.app_order_id || '') !== String(notes.app_order_id) ||
        String(paymentEntity.notes?.patient_id || '') !== patientId ||
        String(paymentEntity.notes?.starts_at || '') !== starts_at ||
        !Number.isFinite(fee) || fee <= 0 || Number(providerOrder.amount) !== Math.round(fee * 100) ||
        providerOrder.currency !== 'INR' || Number(paymentEntity.amount) !== Math.round(fee * 100) ||
        paymentEntity.currency !== 'INR') {
      throw new BadRequestError('Razorpay appointment order details do not match the captured payment.');
    }

    await this.validateSlot(starts_at, { patientRequest: true });
    await this.paymentGatewayService.verifyCapturedPayment({
      paymentId,
      expectedOrderId: razorpayOrderId,
      expectedAmount: fee,
      currency: 'INR',
    });

    const patient = await this.userRepository.findById(patientId);
    if (!patient) throw new NotFoundError('Appointment patient was not found for the verified payment.');
    const clinicConfig = await this.getScheduleConfig();
    const actor = patient.patient_code || 'Payment webhook';
    const appointment = await this.appointmentRepository.create({
      userId: Number(patientId),
      patient_code: patient.patient_code || '',
      starts_at,
      timezone: clinicConfig?.timezone || 'Asia/Kolkata',
      reason,
      doctor_name: clinicConfig?.doctor_name || '',
      room: clinicConfig?.room || '',
      consultation_fee: fee,
      payment_status: 'Paid',
      payment_method: 'Razorpay',
      payment_transaction_id: paymentId,
      payment_time: new Date(),
      source: 'App payment webhook recovery',
      status: 'Confirmed',
      status_history: [{
        action: `recovered from Razorpay payment webhook (₹${fee} Paid · Txn: ${paymentId})`,
        status: 'Confirmed',
        changed_by: actor,
        starts_at,
      }],
    });

    if (this.patientActivityRepository) {
      await this.patientActivityRepository.record({
        userId: Number(patientId),
        patientCode: patient.patient_code,
        type: 'appointment',
        title: 'Appointment booked (Paid)',
        summary: `${reason} · ${starts_at} · ₹${fee} Paid via Razorpay (${paymentId})`,
        actor: 'Razorpay payment recovery',
        metadata: { appointment_id: appointment.id, opd_token: appointment.opd_token, transaction_id: paymentId },
      }).catch(() => {});
    }
    if (this.notificationRepository) {
      try {
        const title = 'Appointment confirmed';
        const body = `Your ${reason.toLowerCase()} appointment has been confirmed for ${new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: clinicConfig?.timezone || 'Asia/Kolkata' }).format(new Date(starts_at))}.`;
        const notification = await this.notificationRepository.create({
          userId: Number(patientId),
          title,
          body,
          type: 'appointment',
          destination: { type: 'screen', screen: 'clinic_appointment', entityId: appointment.id },
          data: { appointment_id: appointment.id, opd_token: String(appointment.opd_token || ''), destination_type: 'screen', screen: 'clinic_appointment' },
        });
        const tokens = await this.deviceTokenRepository?.listByUserId(patientId) || [];
        await Promise.all(tokens.map(({ token }) => sendPushNotification({
          token,
          title,
          body,
          data: { notification_id: notification.id, destination_type: 'screen', screen: 'clinic_appointment', entity_id: appointment.id },
        }).catch(() => {})));
      } catch {
        // Appointment confirmation must succeed even when push delivery is unavailable.
      }
    }
    return appointment;
  };

  recoverCapturedCashfreePaymentFromWebhook = async (webhookData) => {
    const webhookOrderId = String(webhookData?.order?.order_id || '').trim();
    const webhookPayment = webhookData?.payment || {};
    const paymentId = String(webhookPayment.cf_payment_id || '').trim();
    if (!paymentId || !webhookOrderId) {
      throw new BadRequestError('Cashfree appointment event is missing order or payment references.');
    }
    const existing = await this.appointmentRepository.findByPaymentTransactionId(paymentId);
    if (existing) return existing;

    const order = await this.paymentGatewayService.getPaymentOrder(webhookOrderId);
    const tags = order?.order_tags || {};
    const patientId = String(tags.patient_id || '').trim();
    const starts_at = normalizeStartsAt(tags.starts_at);
    const reason = String(tags.reason || '').trim().slice(0, 500) || 'General hair & scalp consultation';
    const fee = Number(tags.consultation_fee);
    const generatedOrderIdPattern = new RegExp(`^APT-\\d+-${Number(patientId)}-[a-f0-9]{8}$`);
    if (!/^\\d+$/.test(patientId) || order?.order_id !== webhookOrderId ||
        String(tags.app_order_id || '') !== webhookOrderId ||
        !generatedOrderIdPattern.test(webhookOrderId) ||
        !Number.isFinite(fee) || fee <= 0 ||
        Number(order.order_amount) !== fee || order.order_currency !== 'INR' ||
        Number(webhookPayment.payment_amount) !== fee ||
        String(webhookPayment.payment_currency || 'INR') !== 'INR' ||
        String(webhookPayment.payment_status || '').toUpperCase() !== 'SUCCESS') {
      throw new BadRequestError('Cashfree appointment order does not match its verified payment.');
    }
    await this.validateSlot(starts_at, { patientRequest: true });
    const verified = await this.paymentGatewayService.verifyCapturedPayment({
      orderId: webhookOrderId,
      paymentId,
      expectedOrderId: webhookOrderId,
      expectedAmount: fee,
      currency: 'INR',
    });
    const transactionId = verified.transaction_id || paymentId;
    const patient = await this.userRepository.findById(patientId);
    if (!patient) throw new NotFoundError('Appointment patient was not found for the verified Cashfree payment.');
    const clinicConfig = await this.getScheduleConfig();
    const appointment = await this.appointmentRepository.create({
      userId: Number(patientId),
      patient_code: patient.patient_code || '',
      starts_at,
      timezone: clinicConfig?.timezone || 'Asia/Kolkata',
      reason,
      doctor_name: clinicConfig?.doctor_name || '',
      room: clinicConfig?.room || '',
      consultation_fee: fee,
      payment_status: 'Paid',
      payment_method: 'Cashfree',
      payment_transaction_id: transactionId,
      payment_order_id: webhookOrderId,
      payment_time: new Date(),
      source: 'App Cashfree payment webhook',
      status: 'Confirmed',
      status_history: [{
        action: `recovered from Cashfree payment webhook (₹${fee} Paid · Txn: ${transactionId})`,
        status: 'Confirmed',
        changed_by: patient.patient_code || 'Cashfree webhook',
        starts_at,
      }],
    });
    this.invalidateAvailabilityCache();
    return appointment;
  };

  recoverCashfreeRefundEventFromWebhook = async (webhookData) => {
    const orderId = String(webhookData?.order?.order_id || '').trim();
    const refund = webhookData?.refund || {};
    const refundId = String(refund.cf_refund_id || refund.refund_id || '').trim();
    const amount = Number(refund.refund_amount);
    const statusMap = { SUCCESS: 'processed', PROCESSED: 'processed', PENDING: 'pending', FAILED: 'failed' };
    const status = statusMap[String(refund.refund_status || '').toUpperCase()];
    const currency = String(refund.refund_currency || 'INR').toUpperCase();
    if (!orderId || !refundId || !Number.isFinite(amount) || amount <= 0 || currency !== 'INR' || !status) {
      throw new BadRequestError('Cashfree appointment refund event is missing a valid order, refund, amount, or status.');
    }
    const appointment = await this.appointmentRepository.findByPaymentOrderId(orderId);
    if (!appointment || String(appointment.payment_method || '').toLowerCase() !== 'cashfree' ||
        !['Paid', 'Refunded'].includes(appointment.payment_status)) {
      throw new NotFoundError('Cashfree appointment refund does not match a verified appointment payment.');
    }
    const refunds = [...(appointment.refunds || [])];
    const index = refunds.findIndex((entry) => String(entry.id) === refundId);
    const existing = index >= 0 ? refunds[index] : null;
    const stableStatus = ['processed', 'failed'].includes(existing?.status) ? existing.status : status;
    const record = { id: refundId, amount, currency, status: stableStatus, updated_at: new Date().toISOString() };
    if (index >= 0) refunds[index] = { ...existing, ...record };
    else refunds.push(record);
    const refunded = refunds.filter((entry) => entry.status === 'processed').reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
    const pending = refunds.filter((entry) => entry.status === 'pending').reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
    if (refunded + pending > Number(appointment.consultation_fee) + 0.01) {
      throw new BadRequestError('Cashfree appointment refund events exceed the recorded consultation fee.');
    }
    return this.appointmentRepository.update(appointment.id, {
      payment_status: refunded >= Number(appointment.consultation_fee) ? 'Refunded' : appointment.payment_status,
      refund_id: refundId,
      refund_status: pending > 0 ? 'pending' : stableStatus,
      refund_amount: refunded,
      refund_pending_amount: pending,
      refunds,
    }, {
      action: `Cashfree refund ${stableStatus}: ₹${amount} (${refundId})`,
      status: appointment.status,
      changed_by: 'Cashfree refund webhook',
      starts_at: appointment.starts_at,
    });
  };

  recoverRefundEventFromWebhook = async (refundEntity, eventType) => {
    const paymentId = String(refundEntity?.payment_id || '').trim();
    const refundId = String(refundEntity?.id || '').trim();
    const amount = Number(refundEntity?.amount) / 100;
    const currency = String(refundEntity?.currency || 'INR').toUpperCase();
    if (!paymentId || !refundId || !Number.isFinite(amount) || amount <= 0 || currency !== 'INR') {
      throw new BadRequestError('Razorpay appointment refund event is missing a valid payment, refund, or INR amount.');
    }

    const appointment = await this.appointmentRepository.findByPaymentTransactionId(paymentId);
    if (!appointment || String(appointment.payment_method || '').toLowerCase() !== 'razorpay' ||
        !['Paid', 'Refunded'].includes(appointment.payment_status)) {
      throw new NotFoundError('Razorpay appointment refund does not match a verified appointment payment.');
    }

    const statusByEvent = { 'refund.created': 'pending', 'refund.processed': 'processed', 'refund.failed': 'failed' };
    const incomingStatus = statusByEvent[eventType];
    if (!incomingStatus) throw new BadRequestError('Unsupported Razorpay appointment refund event.');
    const refunds = [...(appointment.refunds || [])];
    const refundIndex = refunds.findIndex((refund) => String(refund.id) === refundId);
    const existing = refundIndex >= 0 ? refunds[refundIndex] : null;
    const status = existing?.status === 'processed' || existing?.status === 'failed' ? existing.status : incomingStatus;
    const record = { id: refundId, amount, currency, status, updated_at: new Date().toISOString() };
    if (refundIndex >= 0) refunds[refundIndex] = { ...existing, ...record };
    else refunds.push(record);

    const refundAmount = refunds.filter((refund) => refund.status === 'processed').reduce((sum, refund) => sum + Number(refund.amount || 0), 0);
    const refundPendingAmount = refunds.filter((refund) => refund.status === 'pending').reduce((sum, refund) => sum + Number(refund.amount || 0), 0);
    const consultationFee = Number(appointment.consultation_fee);
    if (!Number.isFinite(consultationFee) || refundAmount + refundPendingAmount > consultationFee + 0.01) {
      throw new BadRequestError('Razorpay appointment refund events exceed the recorded consultation fee.');
    }
    const paymentStatus = refundAmount >= consultationFee ? 'Refunded' : appointment.payment_status;
    const refundStatus = refundPendingAmount > 0 ? 'pending' : status;
    const updated = await this.appointmentRepository.update(appointment.id, {
      payment_status: paymentStatus,
      refund_id: refundId,
      refund_status: refundStatus,
      refund_amount: refundAmount,
      refund_pending_amount: refundPendingAmount,
      refunds,
    }, {
      action: `Razorpay refund ${status}: ₹${amount} (${refundId})`,
      status: appointment.status,
      changed_by: 'Razorpay refund webhook',
      starts_at: appointment.starts_at,
    });
    if (status !== existing?.status && (status === 'processed' || status === 'failed')) {
      await this.notifyPatient({
        userId: appointment.userId,
        appointmentId: appointment.id,
        title: status === 'processed' ? 'Appointment refund processed' : 'Appointment refund needs attention',
        body: status === 'processed'
          ? `A refund of ₹${amount} for your clinic appointment has been processed by the payment provider.`
          : 'The payment provider could not complete your appointment refund. Please contact the clinic.',
      });
    }
    return updated;
  };

  refundAdmin = async (req, res, next) => {
    try {
      const appointment = await this.appointmentRepository.findById(req.params.appointmentId);
      if (!appointment) throw new NotFoundError('Appointment not found.');
      if (String(appointment.payment_method || '').toLowerCase() !== 'cashfree' ||
          !appointment.payment_transaction_id || !appointment.payment_order_id) {
        throw new BadRequestError('Automatic appointment refunds require a verified Cashfree payment. Record offline refunds in the appointment payment panel.');
      }
      if (!this.paymentGatewayService?.refundCapturedPayment) throw new BadGatewayError('Cashfree refund service is not configured.');
      if (!['Paid', 'Refunded'].includes(appointment.payment_status)) {
        throw new BadRequestError('Only a provider-confirmed appointment payment can be refunded.');
      }
      const currentRefunds = appointment.refunds || [];
      const processedTotal = currentRefunds.filter((refund) => refund.status === 'processed').reduce((sum, refund) => sum + Number(refund.amount || 0), 0);
      const pendingTotal = currentRefunds.filter((refund) => refund.status === 'pending').reduce((sum, refund) => sum + Number(refund.amount || 0), 0);
      if (pendingTotal > 0 || appointment.refund_status === 'pending') {
        throw new ConflictError('An appointment refund is already pending provider confirmation.');
      }
      const remaining = Math.max(0, Number(appointment.consultation_fee) - processedTotal);
      const amount = req.body?.amount == null ? remaining : Number(req.body.amount);
      const paise = Math.round(amount * 100);
      if (!Number.isFinite(amount) || amount < 1 || amount > remaining || Math.abs(amount * 100 - paise) > 0.000001) {
        throw new BadRequestError(`Enter a refund amount from ₹1 to ₹${remaining}.`);
      }
      const reason = String(req.body?.reason || 'Clinic appointment refund').trim().slice(0, 200);
      const receipt = `apt_${createHash('sha256').update(`${appointment.id}:${processedTotal.toFixed(2)}:${amount.toFixed(2)}`).digest('hex').slice(0, 28)}`;
      const providerRefund = await this.paymentGatewayService.refundCapturedPayment({
        orderId: appointment.payment_order_id,
        paymentId: appointment.payment_transaction_id,
        amount,
        reason: `${appointment.id}: ${reason}`,
        receipt,
      });
      if (providerRefund.status === 'failed') throw new BadGatewayError('Cashfree rejected this appointment refund. The payment record was not changed.');

      const latest = await this.appointmentRepository.findById(appointment.id) || appointment;
      const refunds = [...(latest.refunds || [])];
      const existingIndex = refunds.findIndex((refund) => String(refund.id) === String(providerRefund.id));
      const refundRecord = {
        id: providerRefund.id,
        amount,
        currency: 'INR',
        status: providerRefund.status,
        updated_at: new Date().toISOString(),
      };
      if (existingIndex >= 0) refunds[existingIndex] = { ...refunds[existingIndex], ...refundRecord };
      else refunds.push(refundRecord);
      const confirmedTotal = refunds.filter((refund) => refund.status === 'processed').reduce((sum, refund) => sum + Number(refund.amount || 0), 0);
      const awaitingTotal = refunds.filter((refund) => refund.status === 'pending').reduce((sum, refund) => sum + Number(refund.amount || 0), 0);
      const paymentStatus = confirmedTotal >= Number(latest.consultation_fee) ? 'Refunded' : latest.payment_status;
      const updated = await this.appointmentRepository.update(appointment.id, {
        payment_status: paymentStatus,
        refund_id: providerRefund.id,
        refund_status: awaitingTotal > 0 ? 'pending' : providerRefund.status,
        refund_amount: confirmedTotal,
        refund_pending_amount: awaitingTotal,
        refunds,
      }, {
        action: `Cashfree appointment refund ${providerRefund.status}: ₹${amount} (${providerRefund.id})`,
        status: latest.status,
        changed_by: String(req.user?.email || req.user?.login || 'Clinic admin'),
        starts_at: latest.starts_at,
      });
      if (!updated) throw new ConflictError('Appointment changed during refund processing. Refresh the payment record.');
      if (this.auditEventRepository?.record) {
        await this.auditEventRepository.record({
          actor: { id: req.user?.id || 'admin', type: 'admin' },
          action: providerRefund.status === 'processed' ? 'appointment.refund.processed' : 'appointment.refund.requested',
          target: `appointment:${appointment.id}`,
          metadata: { amount, refundId: providerRefund.id, providerStatus: providerRefund.status, reason },
        }).catch(() => null);
      }
      await this.notifyPatient({
        userId: updated.userId,
        appointmentId: updated.id,
        title: providerRefund.status === 'processed' ? 'Appointment refund processed' : 'Appointment refund requested',
        body: providerRefund.status === 'processed'
          ? `A refund of ₹${amount} for your clinic appointment has been processed.`
          : `A refund of ₹${amount} for your clinic appointment is awaiting payment provider confirmation.`,
      });
      return sendSuccess(res, { message: 'Appointment refund submitted to Cashfree.', data: this.serialize(updated) });
    } catch (error) { next(error); }
  };

  validateSlot = async (startsAt, { patientRequest = false, exceptId = '' } = {}) => {
    const availability = await this.getScheduleConfig();
    if (!availability) throw new BadRequestError('Clinic appointment schedule is not configured yet.');
    const date = new Date(startsAt);
    const parts = localParts(date, availability.timezone);
    const weekday = clinicWeekdayNumbers[parts.weekday];
    const hour = Number(parts.hour);
    const minute = Number(parts.minute);
    const totalMinutes = hour * 60 + minute;
    const allowed = availability.sessions.some(({ opens_at, closes_at }) => {
      const openingMinutes = minutesFromClinicClock(opens_at);
      const closingMinutes = minutesFromClinicClock(closes_at);
      return totalMinutes >= openingMinutes && totalMinutes + availability.appointment_duration_minutes <= closingMinutes &&
        (totalMinutes - openingMinutes) % availability.slot_interval_minutes === 0;
    });
    if (!allowed) throw new BadRequestError('Choose an available clinic sitting time shown in the appointment calendar.');
    if (availability.weekly_closed_weekdays.includes(weekday)) throw new BadRequestError('The clinic is closed on this weekday. Choose another day.');
    const closedDates = await this.appointmentRepository.listClosedDates();
    if (closedDates.some((item) => item.date === dateKeyFor(startsAt, availability.timezone))) throw new BadRequestError('The clinic is closed on this date. Choose another date.');
    if (availability.max_daily_appointments > 0) {
      const activeOnDate = await this.appointmentRepository.listActiveByClinicDate(dateKeyFor(startsAt, availability.timezone), availability.timezone);
      const activeCount = exceptId
        ? activeOnDate.filter((a) => String(a.id || a._id) !== String(exceptId)).length
        : activeOnDate.length;
      if (activeCount >= availability.max_daily_appointments) {
        throw new BadRequestError('The clinic has reached its maximum appointment limit for this date. Choose another date.');
      }
    }
    if (date.getTime() <= Date.now()) throw new BadRequestError('Choose a future clinic slot.');
    if (patientRequest && date.getTime() > Date.now() + availability.booking_window_days * 24 * 60 * 60 * 1000) throw new BadRequestError(`Choose a clinic slot within the next ${availability.booking_window_days} days.`);
    if (await this.appointmentRepository.findSlot(startsAt, exceptId)) throw new BadRequestError('This sitting is already booked. Choose another time.');
  };

  serialize = (appointment, patient = null) => {
    const timeZone = appointment.timezone || 'Asia/Kolkata';
    const parts = localParts(new Date(appointment.starts_at), timeZone);
    const hour = Number(parts.hour);
    const time = new Intl.DateTimeFormat('en-IN', { timeZone, hour: '2-digit', minute: '2-digit' }).format(new Date(appointment.starts_at));
    const date = new Intl.DateTimeFormat('en-IN', { timeZone, dateStyle: 'medium' }).format(new Date(appointment.starts_at));
    const patientCode = patient?.patient_code || appointment.patient_code || (appointment.userId ? `DHP${String(appointment.userId).padStart(4, '0')}` : '');
    return {
      ...appointment,
      patientId: patientCode || String(appointment.userId || ''),
      patient_code: patientCode,
      customer: patient?.name || 'Patient',
      service: appointment.reason,
      startsAt: appointment.starts_at,
      date: `${date} · ${time}`,
      source: appointment.source,
      type: appointment.type,
      doctorName: appointment.doctor_name,
      room: appointment.room,
      tokenNumber: appointment.opd_token,
      opdStatus: appointment.status,
      consultationFee: appointment.consultation_fee != null ? Number(appointment.consultation_fee) : null,
      paymentStatus: appointment.payment_status || 'Pending',
      paymentMethod: appointment.payment_method || 'UPI',
      paymentTransactionId: appointment.payment_transaction_id || '',
      paymentTime: appointment.payment_time ? new Date(appointment.payment_time).toISOString() : null,
      cancellation_reason: appointment.cancellation_reason || '',
      cancellationReason: appointment.cancellation_reason || '',
      cancelled_by: appointment.cancelled_by || '',
      cancelled_at: appointment.cancelled_at ? new Date(appointment.cancelled_at).toISOString() : null,
      reschedule_reason: appointment.reschedule_reason || '',
      rescheduleReason: appointment.reschedule_reason || '',
      rescheduled_by: appointment.rescheduled_by || '',
      rescheduled_at: appointment.rescheduled_at ? new Date(appointment.rescheduled_at).toISOString() : null,
      _clinicHour: hour,
    };
  };

  serializeMany = async (items) => {
    const patients = await this.userRepository.findByIds(items.map((item) => item.userId));
    const byId = new Map(patients.map((patient) => [Number(patient.id), patient]));
    return items.map((item) => this.serialize(item, byId.get(Number(item.userId))));
  };

  listPatient = async (req, res, next) => {
    try {
      const items = await this.appointmentRepository.listByPatient(req.user.id);
      const serialized = await this.serializeMany(items);
      return sendSuccess(res, { data: { items: serialized } });
    } catch (error) { next(error); }
  };

  createPatient = async (req, res, next) => {
    try {
      const starts_at = normalizeStartsAt(req.body?.starts_at);
      const reason = String(req.body?.reason || '').trim();
      if (!reason || reason.length > 500) throw new BadRequestError('reason is required and must be at most 500 characters.');
      if (req.body?.payment_status === 'Paid') {
        throw new BadRequestError('Online payment verification is not yet integrated for direct requests. In-clinic appointments must be requested as Pending (Pay at clinic).');
      }
      await this.validateSlot(starts_at, { patientRequest: true });
      const clinicConfig = await this.getScheduleConfig();
      const patient = await this.userRepository.findById(req.user.id);
      const actor = patient?.patient_code || 'Patient';

      const billing = await this.getBillingConfig();
      let isFirstAppointment = false;
      if (req.user?.id) {
        const list = await this.appointmentRepository.listByPatient(req.user.id);
        const nonCancelled = (list || []).filter((apt) => apt.status !== 'Cancelled');
        isFirstAppointment = nonCancelled.length === 0;
      }
      const isFirstAppointmentFree = billing.first_appointment_free && isFirstAppointment;
      const isOnlineRequired = billing.online_pay_enabled && !billing.pay_at_clinic_enabled && !isFirstAppointmentFree;

      if (isOnlineRequired) {
        throw new BadRequestError('Online payment is required to book an appointment. Please complete checkout.');
      }
      if (!billing.pay_at_clinic_enabled && !isFirstAppointmentFree) {
        throw new BadRequestError('Pay at clinic is disabled by admin. Please complete online payment to book your appointment.');
      }

      const consultation_fee = isFirstAppointmentFree
        ? 0
        : (billing.consultation_fee != null && Number.isFinite(Number(billing.consultation_fee))
            ? Number(billing.consultation_fee)
            : 500);

      const payment_method = isFirstAppointmentFree
        ? 'Free First Consultation'
        : String(req.body?.payment_method || 'Pay at clinic').trim();
      const payment_status = isFirstAppointmentFree ? 'Waived' : 'Pending';
      const payment_transaction_id = null;

      const appointment = await this.appointmentRepository.create({
        userId: Number(req.user.id),
        patient_code: patient?.patient_code || '',
        starts_at,
        timezone: clinicConfig?.timezone || 'Asia/Kolkata',
        reason,
        doctor_name: clinicConfig?.doctor_name || '',
        room: clinicConfig?.room || '',
        consultation_fee,
        payment_status,
        payment_method,
        payment_transaction_id,
        source: 'App',
        status: 'Requested',
        status_history: [{
          action: `requested from patient app (fee: ₹${consultation_fee}, ${payment_status} via ${payment_method})`,
          status: 'Requested',
          changed_by: actor,
          starts_at,
        }],
      });
      await this.patientActivityRepository?.record({
        userId: req.user.id,
        patientCode: patient?.patient_code,
        type: 'appointment',
        title: 'Appointment requested',
        summary: `${reason} · ${starts_at} · ₹${consultation_fee} (${payment_status})`,
        actor: 'Patient app',
        metadata: { appointment_id: appointment.id, opd_token: appointment.opd_token },
      });

      if (this.auditEventRepository?.record) {
        await this.auditEventRepository.record({
          actor: patient?.name ? `${patient.name} (${patient?.patient_code || req.user.id})` : 'Patient',
          actorId: String(req.user.id),
          actorName: patient?.name || 'Patient',
          actorRole: 'patient',
          action: 'appointment.booked',
          target: `appointment:${appointment.id}`,
          targetType: 'appointment',
          details: {
            appointment_id: appointment.id,
            opd_token: appointment.opd_token,
            patient_name: patient?.name || 'Patient',
            patient_code: patient?.patient_code,
            reason,
            starts_at,
            consultation_fee,
            payment_status,
            payment_method,
          },
        }).catch(() => {});
      }

      this.invalidateAvailabilityCache();

      // Automated push & in-app notification trigger for appointment booking
      if (this.notificationRepository) {
        try {
          const notif = await this.notificationRepository.create({
            userId: Number(req.user.id),
            title: 'Appointment Booked Successfully',
            body: `Your clinic sitting for ${reason} is confirmed (Token #${appointment.opd_token || '1'}). Tap to view details.`,
            type: 'appointment',
            destination: {
              type: 'screen',
              screen: 'clinic_appointment',
              entityId: appointment.id,
            },
            data: {
              appointment_id: appointment.id,
              opd_token: String(appointment.opd_token || ''),
              destination_type: 'screen',
              screen: 'clinic_appointment',
            },
          });

          if (this.deviceTokenRepository) {
            const tokens = await this.deviceTokenRepository.listByUserId(req.user.id);
            for (const { token } of tokens) {
              await sendPushNotification({
                token,
                title: notif.title,
                body: notif.body,
                data: {
                  notification_id: notif.id,
                  destination_type: 'screen',
                  screen: 'clinic_appointment',
                  entity_id: appointment.id,
                },
              }).catch(() => {});
            }
          }
        } catch (_) {}
      }

      return sendSuccess(res, { message: 'Appointment request sent to the clinic.', data: this.serialize(appointment, patient), statusCode: 201 });
    } catch (error) { next(error); }
  };

  updatePatient = async (req, res, next) => {
    try {
      const appointment = await this.appointmentRepository.findById(req.params.appointmentId, req.user.id);
      if (!appointment) throw new NotFoundError('Appointment request not found.');
      if (['Completed', 'Cancelled', 'No show'].includes(appointment.status)) throw new BadRequestError('This appointment can no longer be changed.');
      const action = req.body?.action;
      let patch;
      let event;
      if (action === 'cancel') {
        const cancellationReason = String(req.body?.reason || req.body?.cancellation_reason || 'Cancelled by patient').trim().slice(0, 500);
        patch = {
          status: 'Cancelled',
          cancellation_reason: cancellationReason,
          cancelled_by: appointment.patient_code || 'Patient',
          cancelled_at: new Date(),
        };
        event = { action: `cancelled by patient · Reason: ${cancellationReason}`, status: 'Cancelled', changed_by: appointment.patient_code || 'Patient' };
      } else if (action === 'reschedule') {
        const starts_at = normalizeStartsAt(req.body?.starts_at);
        await this.validateSlot(starts_at, { patientRequest: true, exceptId: appointment.id });
        const schedule = await this.getScheduleConfig();
        patch = { starts_at, timezone: schedule?.timezone || appointment.timezone || 'Asia/Kolkata', status: 'Requested' };
        event = { action: 'rescheduled by patient', status: 'Requested', starts_at, changed_by: appointment.patient_code || 'Patient' };
      } else throw new BadRequestError('action must be cancel or reschedule.');
      const updated = await this.appointmentRepository.update(appointment.id, patch, event, req.user.id);
      await this.patientActivityRepository.record({ userId: req.user.id, patientCode: appointment.patient_code, type: 'appointment', title: action === 'cancel' ? 'Appointment cancelled' : 'Appointment rescheduled', summary: patch.starts_at || appointment.starts_at, actor: 'Patient app', metadata: { appointment_id: appointment.id } });
      const patient = await this.userRepository.findById(appointment.userId);
      this.invalidateAvailabilityCache();
      return sendSuccess(res, { message: action === 'cancel' ? 'Appointment request cancelled.' : 'Reschedule request sent to the clinic.', data: this.serialize(updated, patient) });
    } catch (error) { next(error); }
  };

  listAdmin = async (req, res, next) => {
    try {
      const items = await this.appointmentRepository.list({
        from: req.query.from,
        to: req.query.to,
        status: req.query.status,
        payment_status: req.query.payment_status,
        limit: req.query.limit,
      });
      return sendSuccess(res, { data: { items: await this.serializeMany(items) } });
    } catch (error) { next(error); }
  };

  createAdmin = async (req, res, next) => {
    try {
      const patientId = req.body?.patient_id || req.body?.patient_code;
      const patient = await this.userRepository.findById(patientId);
      if (!patient || patient.role !== 'user') throw new NotFoundError('Patient not found.');
      const starts_at = normalizeStartsAt(req.body?.starts_at);
      await this.validateSlot(starts_at);
      const clinicConfig = await this.getScheduleConfig();
      const reason = String(req.body?.reason || clinicConfig?.appointment_services?.[0] || '').trim().slice(0, 500);
      if (!reason) throw new BadRequestError('Configure an appointment service before scheduling a visit.');
      const actor = String(req.user?.email || req.user?.login || 'Clinic admin');

      const billing = await this.getBillingConfig();
      const allowedPaymentStatuses = ['Pending', 'Paid', 'Refunded', 'Waived'];
      if (req.body?.payment_status && !allowedPaymentStatuses.includes(req.body.payment_status)) {
        throw new BadRequestError('payment_status must be Pending, Paid, Refunded, or Waived.');
      }
      const payment_status = req.body?.payment_status || 'Pending';

      const payment_method = req.body?.payment_method
        ? String(req.body.payment_method).trim().slice(0, 50)
        : (payment_status === 'Paid' ? 'Cash' : 'Pay at clinic');
      if (onlineGatewayMethods.has(payment_method.toLowerCase())) {
        throw new BadRequestError('Clinic staff can record cash or offline payments only. Cashfree payments must be confirmed by the payment verification flow.');
      }
      if (payment_status === 'Paid' && payment_method.toLowerCase() === 'pay at clinic') {
        throw new BadRequestError('Select the offline payment method actually collected before marking the appointment Paid.');
      }
      if (payment_status === 'Refunded') {
        throw new BadRequestError('A new appointment cannot be marked Refunded. Record the payment first, then use the verified refund flow.');
      }

      const isConfigured = Boolean(billing?.configured ?? (billing?.consultation_fee != null));
      if (!isConfigured) {
        if (payment_status === 'Paid' || payment_status === 'Pending') {
          throw new BadRequestError('Appointment billing has not been configured by the clinic yet. Configure billing before scheduling paid or pending appointments.');
        }
      }

      let isFirstAppointment = false;
      if (this.appointmentRepository) {
        const prior = await this.appointmentRepository.listByPatient(patient.id);
        const nonCancelled = prior.filter((a) => !['Cancelled', 'No show'].includes(a.status));
        isFirstAppointment = nonCancelled.length === 0;
      }

      let consultation_fee = null;
      if (req.body?.consultation_fee !== undefined && req.body?.consultation_fee !== null) {
        const numFee = Number(req.body.consultation_fee);
        if (!Number.isFinite(numFee) || numFee < 0) {
          throw new BadRequestError('consultation_fee must be a non-negative number.');
        }
        consultation_fee = Math.round(numFee);
      } else if (isConfigured && billing.consultation_fee !== null) {
        consultation_fee = billing.consultation_fee;
      }

      const isFirstAppointmentFree = Boolean(billing?.first_appointment_free && isFirstAppointment);
      const hasExplicitWaiver = req.body?.fee_waived === true || req.body?.fee_waiver === true || payment_status === 'Waived' || isFirstAppointmentFree;

      if (consultation_fee === 0 && !hasExplicitWaiver) {
        throw new BadRequestError('Consultation fee of ₹0 requires an explicit fee waiver or Waived payment status.');
      }
      const payment_transaction_id = req.body?.payment_transaction_id
        ? String(req.body.payment_transaction_id).trim().slice(0, 100)
        : null;

      const appointment = await this.appointmentRepository.create({
        userId: Number(patient.id),
        patient_code: patient.patient_code,
        starts_at,
        timezone: clinicConfig?.timezone || 'Asia/Kolkata',
        reason,
        doctor_name: clinicConfig?.doctor_name || '',
        room: clinicConfig?.room || '',
        consultation_fee,
        payment_status,
        payment_method,
        payment_transaction_id,
        payment_time: payment_status === 'Paid' ? new Date() : null,
        source: ['App', 'Phone', 'WhatsApp', 'Reception'].includes(req.body?.source) ? req.body.source : 'Reception',
        status: 'Confirmed',
        status_history: [{
          action: `scheduled by clinic (Payment: ${payment_status} · ₹${consultation_fee != null ? consultation_fee : 0} ${payment_method})`,
          status: 'Confirmed',
          changed_by: actor,
          starts_at,
        }],
      });
      await this.patientActivityRepository?.record({
        userId: patient.id,
        patientCode: patient.patient_code,
        type: 'appointment',
        title: 'Clinic appointment scheduled',
        summary: `${reason} · ${starts_at}`,
        actor,
        metadata: { appointment_id: appointment.id },
      });
      if (this.auditEventRepository?.record) {
        await this.auditEventRepository.record({
          actor,
          action: 'appointment.created',
          target: `appointment:${appointment.id}`,
          metadata: { patient_id: patient.id, starts_at, reason, payment_status, consultation_fee },
        }).catch(() => null);
      }
      this.invalidateAvailabilityCache();
      return sendSuccess(res, { message: 'Clinic appointment scheduled.', data: this.serialize(appointment, patient), statusCode: 201 });
    } catch (error) { next(error); }
  };

  updateAdmin = async (req, res, next) => {
    try {
      const appointment = await this.appointmentRepository.findById(req.params.appointmentId);
      if (!appointment) throw new NotFoundError('Appointment not found.');
      const actor = String(req.user?.email || req.user?.login || 'Clinic admin');
      const body = req.body || {};
      let patch = {};
      let event = null;
      if (body.action === 'reschedule') {
        const starts_at = normalizeStartsAt(body.starts_at);
        await this.validateSlot(starts_at, { exceptId: appointment.id });
        const schedule = await this.getScheduleConfig();
        const reason = String(body.reason || body.reschedule_reason || '').trim().slice(0, 500);
        patch = {
          starts_at,
          timezone: schedule?.timezone || appointment.timezone || 'Asia/Kolkata',
          status: 'Confirmed',
          reschedule_reason: reason,
          rescheduled_by: actor,
          rescheduled_at: new Date(),
        };
        event = {
          action: `rescheduled by clinic${reason ? ` · Reason: ${reason}` : ''}`,
          status: 'Confirmed',
          starts_at,
          changed_by: actor,
        };
      } else if (body.status && appointmentStatuses.includes(body.status)) {
        const allowedNext = {
          Requested: ['Confirmed', 'Cancelled'],
          Confirmed: ['Arrived', 'In Consultation', 'Completed', 'Cancelled', 'No show'],
          Arrived: ['In Consultation', 'Completed', 'Cancelled', 'No show'],
          'In Consultation': ['Completed'],
          Completed: [],
          Cancelled: [],
          'No show': [],
        };
        if (!allowedNext[appointment.status]?.includes(body.status)) {
          throw new BadRequestError(`Appointment status cannot move from ${appointment.status} to ${body.status}.`);
        }
        if (body.status === 'No show' && new Date(appointment.starts_at).getTime() > Date.now()) throw new BadRequestError('A future appointment cannot be marked as no show.');
        patch.status = body.status;
        if (body.status === 'Cancelled') {
          const cancellationReason = String(body.cancellation_reason || body.reason || 'Cancelled by clinic administration').trim().slice(0, 500);
          patch.cancellation_reason = cancellationReason;
          patch.cancelled_by = actor;
          patch.cancelled_at = new Date();
          event = { action: `cancelled by clinic · Reason: ${cancellationReason}`, status: 'Cancelled', changed_by: actor };
        } else {
          event = { action: `status changed to ${body.status}`, status: body.status, changed_by: actor };
        }
      } else if (!body.payment_status && !body.payment_method && body.consultation_fee == null) {
        throw new BadRequestError('Provide a valid appointment status, payment_status, or action=reschedule.');
      }

      if (body.payment_status) {
        if (!['Pending', 'Paid', 'Refunded', 'Waived'].includes(body.payment_status)) {
          throw new BadRequestError('payment_status must be Pending, Paid, Refunded, or Waived.');
        }
        const effectivePaymentMethod = String(body.payment_method || appointment.payment_method || '').trim();
        const storedGatewayPayment = onlineGatewayMethods.has(String(appointment.payment_method || '').trim().toLowerCase());
        const isGatewayPayment = onlineGatewayMethods.has(effectivePaymentMethod.toLowerCase()) || storedGatewayPayment;
        if (isGatewayPayment && (body.payment_status !== 'Paid' || appointment.payment_status !== 'Paid' ||
          (body.payment_method != null && String(body.payment_method).trim() !== String(appointment.payment_method || '').trim()) ||
          (body.payment_transaction_id !== undefined && String(body.payment_transaction_id || '') !== String(appointment.payment_transaction_id || '')) ||
          (body.consultation_fee != null && Number(body.consultation_fee) !== Number(appointment.consultation_fee)))) {
          throw new BadRequestError('Cashfree appointment payment state is provider-managed and cannot be edited manually.');
        }
        if (body.payment_status === 'Paid' && onlineGatewayMethods.has(effectivePaymentMethod.toLowerCase()) && appointment.payment_status !== 'Paid') {
          throw new BadRequestError('Cashfree payments must be confirmed by the payment verification flow before marking Paid.');
        }
        if (body.payment_status === 'Paid' && effectivePaymentMethod.toLowerCase() === 'pay at clinic') {
          throw new BadRequestError('Select the offline payment method actually collected before marking the appointment Paid.');
        }
        if (body.payment_status === 'Refunded' && (!['Paid', 'Refunded'].includes(appointment.payment_status) || isGatewayPayment)) {
          throw new BadRequestError(isGatewayPayment
            ? 'Online payment refunds must be confirmed by a verified provider webhook.'
            : 'Only a previously paid offline appointment can be recorded as refunded.');
        }
        patch.payment_status = body.payment_status;
        if (body.payment_status === 'Paid') {
          patch.payment_time = new Date();
        }
        if (body.payment_status === 'Refunded' && !isGatewayPayment) {
          patch.refund_status = 'processed';
          patch.refund_amount = Number(appointment.consultation_fee) || 0;
          patch.refund_pending_amount = 0;
          patch.refunds = appointment.payment_status === 'Refunded'
            ? (appointment.refunds || [])
            : [...(appointment.refunds || []), {
              id: `offline-refund-${appointment.id}-${Date.now()}`,
              amount: Number(appointment.consultation_fee) || 0,
              currency: 'INR',
              status: 'processed',
              updated_at: new Date().toISOString(),
            }];
        }
        if (body.payment_method && body.payment_status !== 'Refunded') {
          patch.payment_method = String(body.payment_method).trim().slice(0, 50);
        }
        if (body.payment_transaction_id !== undefined) {
          patch.payment_transaction_id = body.payment_transaction_id ? String(body.payment_transaction_id).trim().slice(0, 100) : null;
        }
        if (body.consultation_fee != null) {
          patch.consultation_fee = Math.max(0, Number(body.consultation_fee));
        }
        const payAction = `payment marked ${body.payment_status}${body.payment_method ? ` via ${body.payment_method}` : ''}${body.payment_transaction_id ? ` (Txn: ${body.payment_transaction_id})` : ''}`;
        event = event
          ? { ...event, action: `${event.action} · ${payAction}` }
          : { action: payAction, status: appointment.status, changed_by: actor };
      } else if (body.payment_method || body.consultation_fee != null) {
        if (onlineGatewayMethods.has(String(appointment.payment_method || '').trim().toLowerCase()) &&
          (String(body.payment_method || appointment.payment_method).trim() !== String(appointment.payment_method).trim() ||
            (body.consultation_fee != null && Number(body.consultation_fee) !== Number(appointment.consultation_fee)))) {
          throw new BadRequestError('Online appointment payment details are provider-managed and cannot be edited manually.');
        }
        if (body.payment_method) patch.payment_method = String(body.payment_method).trim().slice(0, 50);
        if (body.consultation_fee != null) patch.consultation_fee = Math.max(0, Number(body.consultation_fee));
        event = event || { action: 'payment details updated', status: appointment.status, changed_by: actor };
      }
      const previousStatus = appointment.status;
      const previousPaymentStatus = appointment.payment_status;
      const updated = await this.appointmentRepository.update(appointment.id, patch, event);
      await this.patientActivityRepository.record({ userId: appointment.userId, patientCode: appointment.patient_code, type: 'appointment', title: event.action, summary: patch.starts_at || appointment.starts_at, actor, metadata: { appointment_id: appointment.id } });
      if (this.auditEventRepository?.record) {
        await this.auditEventRepository.record({
          actor,
          action: body.action === 'reschedule' ? 'appointment.rescheduled' : 'appointment.updated',
          target: `appointment:${appointment.id}`,
          metadata: { status: updated.status, payment_status: updated.payment_status, starts_at: updated.starts_at },
        }).catch(() => null);
      }

      // Automated push & in-app notification trigger when appointment is cancelled or rescheduled by admin
      if (this.notificationRepository && appointment.userId) {
        try {
          const timeZone = appointment.timezone || 'Asia/Kolkata';
          if (patch.status === 'Cancelled') {
            const reasonText = patch.cancellation_reason || 'Cancelled by clinic administration';
            const aptDate = new Date(appointment.starts_at).toLocaleDateString('en-IN', {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
              timeZone,
            });
            const aptTime = new Date(appointment.starts_at).toLocaleTimeString('en-IN', {
              hour: '2-digit',
              minute: '2-digit',
              timeZone,
            });
            const notifTitle = 'Clinic Appointment Cancelled';
            const notifBody = `Your appointment for ${aptDate} at ${aptTime} was cancelled. Reason: ${reasonText}`;

            const notif = await this.notificationRepository.create({
              userId: appointment.userId,
              user_id: appointment.userId,
              title: notifTitle,
              body: notifBody,
              type: 'appointment',
              data: {
                appointment_id: appointment.id,
                status: 'Cancelled',
                cancellation_reason: reasonText,
                destination_type: 'screen',
                screen: 'clinic_appointment',
              },
            });

            if (this.deviceTokenRepository) {
              const tokens = await this.deviceTokenRepository.listByUserId(appointment.userId);
              for (const { token } of (tokens || [])) {
                await sendPushNotification({
                  token,
                  title: notifTitle,
                  body: notifBody,
                  data: {
                    notification_id: notif?.id || '',
                    type: 'appointment',
                    destination_type: 'screen',
                    screen: 'clinic_appointment',
                    entity_id: appointment.id,
                    status: 'Cancelled',
                    cancellation_reason: reasonText,
                  },
                }).catch(() => {});
              }
            }
          } else if (body.action === 'reschedule') {
            const reasonSuffix = patch.reschedule_reason ? ` Reason: ${patch.reschedule_reason}` : '';
            const newDate = new Date(patch.starts_at).toLocaleDateString('en-IN', {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
              timeZone,
            });
            const newTime = new Date(patch.starts_at).toLocaleTimeString('en-IN', {
              hour: '2-digit',
              minute: '2-digit',
              timeZone,
            });
            const notifTitle = 'Clinic Appointment Rescheduled';
            const notifBody = `Your appointment has been rescheduled to ${newDate} at ${newTime}.${reasonSuffix}`;

            const notif = await this.notificationRepository.create({
              userId: appointment.userId,
              user_id: appointment.userId,
              title: notifTitle,
              body: notifBody,
              type: 'appointment',
              data: {
                appointment_id: appointment.id,
                status: 'Confirmed',
                starts_at: patch.starts_at,
                reschedule_reason: patch.reschedule_reason || '',
                destination_type: 'screen',
                screen: 'clinic_appointment',
              },
            });

            if (this.deviceTokenRepository) {
              const tokens = await this.deviceTokenRepository.listByUserId(appointment.userId);
              for (const { token } of (tokens || [])) {
                await sendPushNotification({
                  token,
                  title: notifTitle,
                  body: notifBody,
                  data: {
                    notification_id: notif?.id || '',
                    type: 'appointment',
                    destination_type: 'screen',
                    screen: 'clinic_appointment',
                    entity_id: appointment.id,
                    status: 'Confirmed',
                    starts_at: patch.starts_at,
                    reschedule_reason: patch.reschedule_reason || '',
                  },
                }).catch(() => {});
              }
            }
          } else if (updated.status !== previousStatus &&
              ['Confirmed', 'Completed', 'No show'].includes(updated.status)) {
            const statusMessages = {
              Confirmed: {
                title: 'Appointment confirmed',
                body: `Your clinic appointment is confirmed for ${new Date(updated.starts_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone })}.`,
              },
              Completed: {
                title: 'Appointment completed',
                body: 'Your clinic appointment is marked complete. You can review your care plan in the app.',
              },
              'No show': {
                title: 'Appointment update',
                body: 'The clinic marked this appointment as missed. Please contact the clinic if you need help rebooking.',
              },
            };
            const { title: statusTitle, body: statusBody } = statusMessages[updated.status];
            const notif = await this.notificationRepository.create({
              userId: appointment.userId,
              user_id: appointment.userId,
              title: statusTitle,
              body: statusBody,
              type: 'appointment',
              destination: { type: 'screen', screen: 'clinic_appointment', entityId: appointment.id },
              data: { appointment_id: appointment.id, status: updated.status, destination_type: 'screen', screen: 'clinic_appointment' },
            });
            const tokens = await this.deviceTokenRepository?.listByUserId(appointment.userId) || [];
            await Promise.all(tokens.map(({ token }) => sendPushNotification({
              token,
              title: statusTitle,
              body: statusBody,
              data: { notification_id: notif?.id || '', type: 'appointment', destination_type: 'screen', screen: 'clinic_appointment', entity_id: appointment.id, status: updated.status },
            }).catch(() => {})));
          } else if (body.payment_status && body.payment_status !== previousPaymentStatus &&
              ['Paid', 'Refunded'].includes(updated.payment_status)) {
            const paymentTitle = updated.payment_status === 'Paid' ? 'Appointment payment recorded' : 'Appointment refund recorded';
            const paymentBody = updated.payment_status === 'Paid'
              ? `₹${Number(updated.consultation_fee || 0)} was recorded as received via ${updated.payment_method || 'offline payment'} for your clinic appointment.`
              : `A ₹${Number(updated.refund_amount || updated.consultation_fee || 0)} refund was recorded for your clinic appointment.`;
            const notif = await this.notificationRepository.create({
              userId: appointment.userId,
              user_id: appointment.userId,
              title: paymentTitle,
              body: paymentBody,
              type: 'appointment',
              destination: { type: 'screen', screen: 'clinic_appointment', entityId: appointment.id },
              data: { appointment_id: appointment.id, payment_status: updated.payment_status, destination_type: 'screen', screen: 'clinic_appointment' },
            });
            const tokens = await this.deviceTokenRepository?.listByUserId(appointment.userId) || [];
            await Promise.all(tokens.map(({ token }) => sendPushNotification({
              token,
              title: paymentTitle,
              body: paymentBody,
              data: { notification_id: notif?.id || '', type: 'appointment', destination_type: 'screen', screen: 'clinic_appointment', entity_id: appointment.id },
            }).catch(() => {})));
          }
        } catch (_) {}
      }

      const patient = await this.userRepository.findById(appointment.userId);
      this.invalidateAvailabilityCache();
      return sendSuccess(res, { message: 'Appointment updated.', data: this.serialize(updated, patient) });
    } catch (error) { next(error); }
  };

  listClosedDates = async (_req, res, next) => {
    try { return sendSuccess(res, { data: { items: await this.appointmentRepository.listClosedDates() } }); }
    catch (error) { next(error); }
  };

  getPatientAvailability = async (req, res, next) => {
    try {
      const from = String(req.query?.from || '');
      const to = String(req.query?.to || '');
      if (!validateDateKey(from) || !validateDateKey(to) || to < from) {
        throw new BadRequestError('from and to must be valid YYYY-MM-DD dates with from on or before to.');
      }
      const fromUtc = Date.parse(`${from}T00:00:00Z`);
      const toUtc = Date.parse(`${to}T00:00:00Z`);
      const rangeDays = Math.round((toUtc - fromUtc) / (24 * 60 * 60 * 1000));
      if (rangeDays > 40) throw new BadRequestError('Availability range cannot exceed 41 calendar days.');

      const cacheKey = `${from}_${to}`;
      const cached = this._cachedAvailability.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp < this._cachedAvailabilityTtl)) {
        return sendSuccess(res, { data: cached.data });
      }

      const [closedDates, schedule] = await Promise.all([
        this.appointmentRepository.listClosedDates(),
        this.getScheduleConfig(),
      ]);
      const bookedAppointments = schedule
        ? await this.appointmentRepository.listActiveSlotTimesInRange(from, to, schedule.timezone)
        : [];
      const closedDateSet = new Set(
        closedDates
          .filter((item) => item.date >= from && item.date <= to)
          .map((item) => item.date)
      );

      const limitReachedDates = [];
      if (schedule?.max_daily_appointments > 0) {
        const dailyCounts = new Map();
        for (const item of bookedAppointments) {
          const dKey = dateKeyFor(item.starts_at, schedule.timezone);
          dailyCounts.set(dKey, (dailyCounts.get(dKey) || 0) + 1);
        }
        for (const [date, count] of dailyCounts.entries()) {
          if (count >= schedule.max_daily_appointments && !closedDateSet.has(date)) {
            limitReachedDates.push(date);
          }
        }
      }

      const closedDateItems = [
        ...Array.from(closedDateSet).map((date) => ({ date })),
        ...limitReachedDates.map((date) => ({ date, reason: 'Daily appointment limit reached' })),
      ].sort((a, b) => a.date.localeCompare(b.date));
      const bookedSlots = bookedAppointments.map((item) => toClinicSlotKey(item.starts_at, schedule.timezone));
      const responseData = {
        ...(schedule || {
          timezone: 'Asia/Kolkata', booking_window_days: null, weekly_closed_weekdays: [7],
          slot_interval_minutes: null, sessions: [], clinic_name: '', clinic_address: '', doctor_name: '', room: '',
          appointment_duration_minutes: null, appointment_services: [], is_configured: false,
          max_daily_appointments: 0,
        }),
        from,
        to,
        closed_dates: closedDateItems,
        booked_slots: bookedSlots,
      };
      this._cachedAvailability.set(cacheKey, { timestamp: Date.now(), data: responseData });
      return sendSuccess(res, { data: responseData });
    } catch (error) { next(error); }
  };

  createClosedDate = async (req, res, next) => {
    try {
      const date = String(req.body?.date || '');
      if (!validateDateKey(date)) throw new BadRequestError('date must use YYYY-MM-DD format.');
      const schedule = await this.getScheduleConfig();
      const existingAppointments = await this.appointmentRepository.listActiveByClinicDate(date, schedule?.timezone || 'UTC');
      if (existingAppointments.length) {
        throw new ConflictError('Move or cancel the scheduled appointments before closing this date.', {
          appointments: existingAppointments.map(({ id, patient_code, starts_at, status }) => ({ id, patient_code, starts_at, status })),
        });
      }
      const actor = String(req.user?.email || req.user?.login || 'Clinic admin');
      const record = await this.appointmentRepository.addClosedDate({ date, reason: String(req.body?.reason || '').trim().slice(0, 200), created_by: actor });
      this.invalidateAvailabilityCache();
      if (this.auditEventRepository?.record) {
        await this.auditEventRepository.record({
          actor,
          action: 'clinic_availability.closed',
          target: `date:${date}`,
          metadata: { date, reason: req.body?.reason },
        }).catch(() => null);
      }
      return sendSuccess(res, { message: 'Clinic date closed for new appointments.', data: record, statusCode: 201 });
    } catch (error) { next(error); }
  };

  deleteClosedDate = async (req, res, next) => {
    try {
      if (!validateDateKey(req.params.date)) throw new BadRequestError('date must use YYYY-MM-DD format.');
      const removed = await this.appointmentRepository.removeClosedDate(req.params.date);
      if (!removed) throw new NotFoundError('Closed date not found.');
      this.invalidateAvailabilityCache();
      const actor = String(req.user?.email || req.user?.login || 'Clinic admin');
      if (this.auditEventRepository?.record) {
        await this.auditEventRepository.record({
          actor,
          action: 'clinic_availability.reopened',
          target: `date:${req.params.date}`,
          metadata: { date: req.params.date },
        }).catch(() => null);
      }
      return sendSuccess(res, { message: 'Clinic date reopened for new appointments.' });
    } catch (error) { next(error); }
  };
}
