import { D1Model } from './D1Model.js';

// D1 keeps the existing domain document shape in JSON while indexed fields are
// exposed through SQLite expression indexes in migrations/.
export const UserModel = new D1Model('users');
export const AdminAccountModel = new D1Model('admin_accounts', { hidden: ['passwordHash'] });
export const OtpModel = new D1Model('otps', { hidden: ['otpHash'] });
export const SupportInquiryModel = new D1Model('support_inquiries');
export const CouponModel = new D1Model('coupons');
export const CategoryModel = new D1Model('categories');
export const HairTestModel = new D1Model('hair_tests');
export const HairTestDraftModel = new D1Model('hair_test_drafts');
export const TreatmentModel = new D1Model('treatments');
export const ClinicalReportModel = new D1Model('clinical_reports');
export const AppointmentModel = new D1Model('clinic_appointments');
export const ClinicClosedDateModel = new D1Model('clinic_closed_dates');
export const PatientActivityModel = new D1Model('patient_activity');
export const PatientCareEventModel = new D1Model('patient_care_events');
export const ProgressCheckInModel = new D1Model('patient_progress_checkins');
export const ReviewModel = new D1Model('reviews');
export const DeviceTokenModel = new D1Model('device_tokens');
export const NotificationModel = new D1Model('notifications');
export const NotificationCampaignModel = new D1Model('notification_campaigns');
export const ContentItemModel = new D1Model('content_items');
export const VideoModel = new D1Model('videos');
export const ProductModel = new D1Model('products');
export const CartModel = new D1Model('carts');
export const AddressModel = new D1Model('addresses');
export const InventoryLedgerModel = new D1Model('inventory_ledgers');
export const InventoryOperationModel = new D1Model('inventory_operations');
export const OrderModel = new D1Model('orders');
export const ProviderWebhookEventModel = new D1Model('provider_webhook_events');
export const SessionModel = new D1Model('auth_sessions');
export const AuditEventModel = new D1Model('audit_events');
export const RateLimitCounterModel = new D1Model('rate_limit_counters');
export const FeatureFlagModel = new D1Model('feature_flags');
export const AppReleasePolicyModel = new D1Model('app_release_policies');

const CounterModel = new D1Model('counters');

export const nextUserId = async () => {
  const highest = await UserModel.findOne().sort({ id: -1 }).select('id').lean();
  if (highest?.id) await CounterModel.updateOne({ _id: 'users' }, { $max: { seq: highest.id } }, { upsert: true });
  return nextId('users');
};

export const nextId = async (counterName, offset = 0) => {
  const counter = await CounterModel.findOneAndUpdate(
    { _id: String(counterName) },
    { $inc: { seq: 1 } },
    { upsert: true, new: true },
  );
  return Number(counter?.seq || 0) + offset;
};
