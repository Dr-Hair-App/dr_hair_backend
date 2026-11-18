# 📖 Dr. Hair - Complete Backend API Documentation

**Base URL:** Use the backend origin configured for the active deployment (Cloudflare staging or production).
**Local Development URL:** `http://localhost:5001`  
**Architecture:** Modular Monolith + Clean Architecture  
**Authentication Scheme:** Bearer JWT (`Authorization: Bearer <token>`)

---

## 📑 Table of Contents
1. [System Health & Status](#1-system-health--status)
2. [Authentication Flow (Patient Mobile OTP)](#2-authentication-flow-patient-mobile-otp)
3. [User & Patient Profile](#3-user--patient-profile)
4. [Hair Assessment & Clinical Records](#4-hair-assessment--clinical-records)
5. [Care Plans & Patient Progress Check-ins](#5-care-plans--patient-progress-check-ins)
6. [Clinic Appointments](#6-clinic-appointments)
7. [Services & Products Catalog](#7-services--products-catalog)
8. [Reviews & Published Videos](#8-reviews--published-videos)
9. [Media & Document Uploads](#9-media--document-uploads)
10. [Admin Portal Authentication & Management](#10-admin-portal-authentication--management)

---

## 1. System Health & Status

### `GET /health`
Returns runtime database connectivity, uptime, and system status.
- **Headers:** None
- **Response (200 OK):**
```json
{
  "status": "ok",
  "database": "connected",
  "uptime": 142.5,
  "timestamp": "2026-11-02T06:25:00.000Z"
}
```

---

## 2. Authentication Flow (Patient Mobile OTP)

### `POST /api/v1/auth/send_login_otp`
*(Alias: `POST /auth/send_login_otp`)*  
Requests a 6-digit OTP code for a 10-digit mobile number or email address.
- **Body (`application/json`):**
```json
{
  "login": "9876543210"
}
```
- **Response (200 OK):**
```json
{
  "status": "success",
  "message": "If this destination can receive a code, a verification code has been sent."
}
```
> **Reviewer / Evaluation Note:** Default test numbers (e.g. `9876543210`, `9999999999`) accept test code `123456` without requiring carrier SMS delivery.

---

### `POST /api/v1/auth/verify_login_otp`
*(Alias: `POST /auth/verify_login_otp`)*  
Verifies the submitted 6-digit OTP and returns an authenticated Bearer JWT session token.
- **Body (`application/json`):**
```json
{
  "login": "9876543210",
  "otp": "123456"
}
```
- **Response (200 OK):**
```json
{
  "status": "success",
  "message": "Login successful",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "6724a1b2c3d4e5f6a7b8c9d0",
    "login": "9876543210",
    "name": "Sunil Sharma",
    "isRegistered": true
  }
}
```

---

## 3. User & Patient Profile

### `POST /api/v1/users/get_profile`
Retrieves the authenticated patient's profile details.
- **Headers:** `Authorization: Bearer <token>`
- **Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "id": "6724a1b2c3d4e5f6a7b8c9d0",
    "name": "Sunil Sharma",
    "phone": "9876543210",
    "email": "patient@example.com",
    "age": 28,
    "gender": "male",
    "city": "Jaipur",
    "occupation": "Software Engineer",
    "profile_url": "https://api.example.com/api/v1/media/assets/..."
  }
}
```

### `POST /api/v1/users/updateProfile`
Updates the authenticated patient's demographics.
- **Headers:** `Authorization: Bearer <token>`
- **Body (`application/json`):**
```json
{
  "name": "Sunil Sharma",
  "age": 29,
  "gender": "male",
  "city": "Jaipur",
  "occupation": "Lead Engineer"
}
```

### `POST /api/v1/users/deleteAccount` or `DELETE /api/v1/users/deleteAccount`
Permanently deletes the authenticated patient's account and personal authentication credentials.
- **Headers:** `Authorization: Bearer <token>`
- **Compliance & Data Privacy:** Clears phone, email, name, profile URL, device push tokens, and active verification OTPs. Clinical reports and doctor treatment plans are preserved for medical compliance and clinical record-keeping.
- **Response (`200 OK`):**
```json
{
  "status": true,
  "message": "Your account has been deleted successfully.",
  "data": {
    "deleted": true
  }
}
```

---

## 4. Hair Assessment & Clinical Records

### `POST /HairTest/submit_form`
Submits the questionnaire and up to five original scalp images (with optional optimized derivatives) together in one multipart request. Files stream to private R2 storage, then the server generates and saves the AI assessment before responding. The app can show one loading screen and render/cache the returned result without another polling request. If the AI provider is unavailable, the API returns and stores its deterministic fallback result. Patients may submit up to ten assessments per India-local day.
- **Headers:** `Authorization: Bearer <token>`
- **Body (`multipart/form-data`; complete request maximum 90 MiB, each file maximum 25 MiB):** Use `photo_front`, `photo_top`, `photo_left`, `photo_right`, or `photo_back` for original image parts. An optional `photo_<position>_optimized` part can accompany an original. Questionnaire answers are regular form fields, up to 64 fields of 16 KiB each and 80 total multipart parts; `scalp_photos` URL references remain supported for older clients.
```json
{
  "gender": "male",
  "age_group": "25-34",
  "hair_loss_stage": "Stage 2 - Receding Temples",
  "duration": "1-2 years",
  "family_history": "yes",
  "dandruff": "mild",
  "lifestyle": "high_stress",
    "scalp_photos": ["https://api.example.com/api/v1/media/assets/..."]
}
```
- **Response (200 OK):**
```json
{
  "status": "success",
  "message": "Hair test submitted successfully",
  "data": {
    "reference_no": "HT-20261102-4821",
    "stage": "Stage 2 - Receding Temples",
    "summary": "Moderate early stage thinning detected. Recommended clinical regimen created.",
    "ai_assessment_status": "ready",
    "ai_assessment": { "summary": "...", "severity": "moderate" }
  }
}
```

### `GET /api/v1/patient/clinical-record`
Fetches verified doctor assessments, prescription treatment plans, and medical laboratory reports.
- **Headers:** `Authorization: Bearer <token>`
- **Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "assessments": [...],
    "treatments": [...],
    "reports": [...]
  }
}
```

---

## 5. Care Plans & Patient Progress Check-ins

### `GET /api/v1/patient/progress-checkins`
Fetches monthly progress photo check-ins submitted by the patient.
- **Headers:** `Authorization: Bearer <token>`
- **Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "items": [
      {
        "id": "chk_1",
        "month": 1,
        "date": "2026-11-01",
        "scalpPhotos": {
          "front": "https://...",
          "top": "https://...",
          "crown": "https://..."
        },
        "notes": "Noticing less shedding during wash."
      }
    ]
  }
}
```

### `POST /api/v1/patient/progress-checkins`
Creates a monthly photo check-in.
- **Headers:** `Authorization: Bearer <token>`
- **Body (`application/json`):**
```json
{
  "month": 2,
  "scalpPhotos": {
    "front": "https://...",
    "crown": "https://..."
  },
  "notes": "Hair density feels thicker around hairline."
}
```

---

## 6. Clinic Appointments

### `GET /api/v1/appointments/closed-dates` *(Public)*
Retrieves clinic holidays and unavailable booking dates.
- **Headers:** None
- **Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "items": ["2026-11-15", "2026-12-25"]
  }
}
```

### `POST /api/v1/patient/appointments`
Books an in-clinic consultation at the Jaipur Clinic.
- **Headers:** `Authorization: Bearer <token>`
- **Body (`application/json`):**
```json
{
  "date": "2026-11-10",
  "slot": "10:30 AM",
  "service": "Trichologist In-Clinic Consultation",
  "notes": "Follow-up for hair treatment plan."
}
```
- **Response (201 Created):**
```json
{
  "status": "success",
  "message": "Appointment booked successfully",
  "data": {
    "id": "apt_8912",
    "clinic": "Dr. Hair & Cosmodent Clinic, Jaipur",
    "status": "confirmed"
  }
}
```

---

## 7. Services & Products Catalog

### `GET /services` *(Alias: `/api/v1/services`)*
Returns the clinic treatments and services catalog.
- **Headers:** None
- **Response (200 OK):**
```json
[
  {
    "id": "srv_assessment",
    "title": "AI Hair & Scalp Assessment",
    "description": "Comprehensive evaluation of hair loss pattern and scalp health.",
    "imageUrl": "",
    "rating": 4.9,
    "reviewsCount": 340,
    "price": "Free"
  },
  {
    "id": "srv_prp",
    "title": "PRP Hair Therapy",
    "description": "Advanced Platelet-Rich Plasma therapy designed to stimulate active follicles.",
    "imageUrl": "",
    "rating": 4.8,
    "reviewsCount": 195,
    "price": "₹4,500"
  }
]
```

---

## 8. Reviews & Published Videos

### `GET /Review/review_get`
Fetches verified customer reviews.
- **Headers:** None
- **Response (200 OK):**
```json
{
  "status": "success",
  "data": [
    {
      "id": "rev_1",
      "author": "Rahul M.",
      "rating": 5,
      "treatment": "PRP + Minoxidil Regimen",
      "comment": "Visible reduction in hair fall within 60 days."
    }
  ]
}
```

### `GET /api/v1/videos`
Fetches published video stories and clinical case demonstrations.
- **Headers:** None
- **Response (200 OK):**
```json
{
  "status": "success",
  "data": []
}
```

---

## 9. Media & Document Uploads

### `POST /api/v1/media/upload`
Shared authenticated endpoint for uploading one to ten images per request to R2. Each file is limited to 25 MiB, the full request to 90 MiB, and multipart text to 64 fields of at most 16 KiB each (80 total parts). The API checks the actual image signature and bounded header dimensions (maximum 40 megapixels), preserves the uploaded original bytes, computes a SHA-256 checksum, and streams large files to R2 with bounded memory. It does not gzip image files. Browser/app optimization may send original and derivative files together; each remains a separately addressed R2 asset.
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: multipart/form-data`
- **Purpose:** `X-Media-Purpose: general | profile | assessment | progress | content | product` (optional; defaults to `general`)
- **Fields:**
  - `file` or `files`: JPEG, PNG, WebP, AVIF, HEIC, HEIF, or GIF image parts. GIF animation is preserved.
- **Response (201 Created):**
```json
{
  "status": "success",
  "data": {
    "items": [{
      "asset_id": "drhair/images/user-123/assessment/uuid.webp",
      "public_id": "drhair/images/user-123/assessment/uuid.webp",
      "url": "https://api.example.com/api/v1/media/assets/...",
      "format": "webp",
      "mime_type": "image/webp",
      "bytes": 245100,
      "original_bytes": 245100,
      "sha256": "<64-character checksum>",
      "processing_status": "original_preserved"
    }]
  }
}
```

Clinical reports are uploaded by the authenticated admin route `POST /api/v1/admin/users/{userId}/reports`. It accepts PDF, DOC/DOCX, XLS/XLSX, PPT/PPTX, TXT, JPEG, PNG, WebP, GIF, AVIF, HEIC, and HEIF files up to 25 MiB, with multipart text limited to 64 fields of at most 16 KiB each and 80 total parts (including the report title). It streams files to private R2, records metadata/checksum in the existing D1 report record, and returns `scanning_status`. Reports remain `not_scanned` unless an actual malware scanner adapter is configured; an infected or failed scan rejects the upload rather than marking the file safe.

Uploads use the existing authenticated Worker APIs and stream parts to the configured `MEDIA_BUCKET` binding. This Worker binding does not mint S3 presigned PUT URLs; enabling direct-to-R2 uploads would require restricted R2 S3 credentials and a separate security/configuration change. Existing assessment, product, content, and report records already persist asset references/metadata, so this flow adds no duplicate upload table or migration.

---

## 10. Admin Portal Authentication & Management

### `POST /api/v1/admin-auth/login`
Authenticates clinical or super admins with email and password.
- **Body (`application/json`):**
```json
{
  "email": "dr.hair@admin",
  "password": "<secure-password>"
}
```
- **Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "admin": {
      "id": "bootstrap:dr.hair@admin",
      "name": "Dr. Hair Super Admin",
      "email": "dr.hair@admin",
      "role": "super_admin"
    }
  }
}
```

---

## 11. In-Clinic Appointments & Consultation Fee Payment

### `POST /api/v1/patient/appointments`
Books an in-clinic OPD consultation slot with payment details.
- **Headers:** `Authorization: Bearer <token>`
- **Body (`application/json`):**
```json
{
  "starts_at": "2026-11-10T10:30:00+05:30",
  "reason": "Crown hair thinning consultation",
  "consultation_fee": 500,
  "payment_method": "UPI",
  "payment_status": "Paid",
  "payment_transaction_id": "UPI-TXN-99887766"
}
```
- **Response (`201 Created`):**
```json
{
  "status": "success",
  "message": "Appointment request sent to the clinic.",
  "data": {
    "id": "APT-2026-0014",
    "opd_token": "OPD-0014",
    "customer": "Rohit Verma",
    "startsAt": "2026-11-10T05:00:00.000Z",
    "date": "10 Nov 2026 · 10:30 am",
    "status": "Requested",
    "consultationFee": 500,
    "paymentStatus": "Paid",
    "paymentMethod": "UPI",
    "paymentTransactionId": "UPI-TXN-99887766"
  }
}
```

### `GET /api/v1/patient/appointments`
Returns all scheduled and past clinic appointments for the authenticated patient with OPD token and payment status.
- **Headers:** `Authorization: Bearer <token>`

### `PATCH /api/v1/patient/appointments/:appointmentId`
Reschedules (`action: "reschedule"`, `starts_at`) or cancels (`action: "cancel"`) an existing appointment.
- **Headers:** `Authorization: Bearer <token>`
