import {
  AppointmentModel,
  HairTestModel,
  OrderModel,
  TreatmentModel,
  UserModel,
} from '../../../shared/database/models.js';
import { isDatabaseConnected } from '../../../shared/database/database.js';
import { store } from '../../../shared/database/store.js';

export const PATIENT_SEGMENTS = Object.freeze({
  accounts_assessments: 'accounts_assessments',
  product_customers: 'product_customers',
  appointment_treatment: 'appointment_treatment',
});

const uniqueIds = (ids) => [...new Set(ids.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
export const ACTIVE_APP_USER_WINDOW_DAYS = 30;
const recentLoginCutoff = () => new Date(Date.now() - ACTIVE_APP_USER_WINDOW_DAYS * 24 * 60 * 60 * 1000);

export async function getPatientSegmentUserIds(segment) {
  if (segment === PATIENT_SEGMENTS.accounts_assessments) {
    if (isDatabaseConnected()) return uniqueIds(await UserModel.distinct('id', { role: 'user' }));
    return uniqueIds((store.users || []).filter((user) => (user.role || 'user') === 'user').map((user) => user.id));
  }

  if (isDatabaseConnected()) {
    if (segment === PATIENT_SEGMENTS.product_customers) {
      const purchasedIds = uniqueIds(await OrderModel.distinct('user_id', {
        user_id: { $ne: null },
        $or: [
          { 'payment.payment_status': { $in: ['Paid', 'Partially refunded'] } },
          { payment_status: { $in: ['Paid', 'Partially refunded'] } },
          { paymentStatus: { $in: ['Paid', 'Partially refunded'] } },
        ],
        'fulfillment.status': { $nin: ['Cancelled', 'Refunded'] },
      }));
      if (!purchasedIds.length) return [];
      const cutoff = recentLoginCutoff();
      const activeIds = await UserModel.distinct('id', {
        id: { $in: purchasedIds },
        role: 'user',
        last_login_at: { $gte: cutoff },
      });
      return uniqueIds(activeIds);
    }

    if (segment === PATIENT_SEGMENTS.appointment_treatment) {
      const [appointmentIds, treatmentIds] = await Promise.all([
        AppointmentModel.distinct('userId', { userId: { $ne: null }, status: { $nin: ['Cancelled', 'No-show'] } }),
        TreatmentModel.distinct('userId', { userId: { $ne: null } }),
      ]);
      const treated = new Set(uniqueIds(treatmentIds));
      return uniqueIds(appointmentIds).filter((id) => treated.has(id));
    }
    if (segment === 'assessed') {
      return uniqueIds(await HairTestModel.distinct('userId', { userId: { $ne: null }, status: { $nin: ['draft', 'Draft'] } }));
    }
    return [];
  }

  if (segment === PATIENT_SEGMENTS.product_customers) {
    const purchasedIds = uniqueIds((store.orders || [])
      .filter((order) => ['Paid', 'Partially refunded'].includes(order.payment?.payment_status || order.payment_status || order.paymentStatus)
        && !['Cancelled', 'Refunded'].includes(order.fulfillment?.status || order.fulfillment_status || order.status))
      .map((order) => order.userId ?? order.user_id));
    const cutoff = recentLoginCutoff().getTime();
    const activeIds = new Set((store.users || [])
      .filter((user) => (user.role || 'user') === 'user' && new Date(user.last_login_at || 0).getTime() >= cutoff)
      .map((user) => Number(user.id)));
    return purchasedIds.filter((id) => activeIds.has(id));
  }
  if (segment === PATIENT_SEGMENTS.appointment_treatment) {
    const appointmentUsers = new Set(uniqueIds((store.appointments || [])
      .filter((appointment) => !['Cancelled', 'No-show'].includes(appointment.status))
      .map((appointment) => appointment.userId)));
    const treatmentUsers = new Set(uniqueIds((store.treatments || []).map((treatment) => treatment.userId)));
    return [...appointmentUsers].filter((id) => treatmentUsers.has(id));
  }
  if (segment === 'assessed') {
    return uniqueIds((store.hairTests || [])
      .filter((test) => !['draft', 'Draft'].includes(test.status))
      .map((test) => test.userId));
  }
  return [];
}

export async function getPatientSegmentSummary() {
  if (isDatabaseConnected()) {
    const [registeredIds, productCustomers, appointmentTreatment] = await Promise.all([
      UserModel.distinct('id', { role: 'user' }),
      getPatientSegmentUserIds(PATIENT_SEGMENTS.product_customers),
      getPatientSegmentUserIds(PATIENT_SEGMENTS.appointment_treatment),
    ]);
    const accountIds = new Set(uniqueIds(registeredIds));
    const assessedIds = await getPatientSegmentUserIds('assessed');
    const completedAssessment = assessedIds.filter((id) => accountIds.has(id));
    const accounts = accountIds.size;
    return {
      accounts_assessments: { total: accounts, assessed: completedAssessment.length, not_assessed: Math.max(0, accounts - completedAssessment.length) },
      product_customers: { total: productCustomers.length, active_within_days: ACTIVE_APP_USER_WINDOW_DAYS },
      appointment_treatment: { total: appointmentTreatment.length },
    };
  }
  const registeredIds = new Set(uniqueIds((store.users || []).filter((user) => (user.role || 'user') === 'user').map((user) => user.id)));
  const accounts = registeredIds.size;
  const assessed = (await getPatientSegmentUserIds('assessed')).filter((id) => registeredIds.has(id));
  const products = await getPatientSegmentUserIds(PATIENT_SEGMENTS.product_customers);
  const care = await getPatientSegmentUserIds(PATIENT_SEGMENTS.appointment_treatment);
  return {
    accounts_assessments: { total: accounts, assessed: assessed.length, not_assessed: Math.max(0, accounts - assessed.length) },
    product_customers: { total: products.length, active_within_days: ACTIVE_APP_USER_WINDOW_DAYS },
    appointment_treatment: { total: care.length },
  };
}
