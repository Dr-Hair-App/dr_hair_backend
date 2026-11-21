/**
 * Review Domain Entity
 */
export class Review {
  constructor({
    id,
    name,
    rating,
    category,
    message,
    avatar,
    media_assets = null,
    is_verified = false,
    consent_verified = false,
    treatment = '',
    duration = '',
    review_type = 'doctor',
    status = 'pending',
    page = 'home',
    created_at = new Date().toISOString(),
    updated_at = created_at,
  }) {
    this.id = id;
    this.name = name;
    this.rating = Number(rating);
    this.category = category;
    this.message = message;
    this.avatar = avatar;
    this.media_assets = media_assets;
    this.is_verified = Boolean(is_verified);
    this.consent_verified = Boolean(consent_verified);
    this.treatment = treatment;
    this.duration = duration;
    this.review_type = review_type;
    this.status = status;
    this.page = page;
    this.created_at = created_at;
    this.updated_at = updated_at;
  }

  toPublicResponse() {
    return {
      id: this.id,
      name: this.name,
      rating: this.rating,
      category: this.category,
      message: this.message,
      avatar: this.avatar,
      is_verified: this.is_verified,
    };
  }
}

