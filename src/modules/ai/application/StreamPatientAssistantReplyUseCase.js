import { BadRequestError } from '../../../shared/errors/index.js';

const MAX_MESSAGES = 12;
const MAX_MESSAGE_LENGTH = 1200;
const MAX_HISTORY_LENGTH = 6000;
const ALLOWED_SCREENS = new Set([
  'home', 'assessment', 'assessment_result', 'profile', 'settings', 'routine',
  'diet_plan', 'reminders', 'appointments', 'orders', 'order_tracking',
  'products', 'cart', 'notifications', 'videos', 'reviews', 'assistant_history',
]);

const boundedText = (value, maxLength) => {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
};

export const normalizeAssistantAction = (input = {}) => {
  const kind = ['navigate', 'routine', 'diet_plan', 'reminder'].includes(input.kind)
    ? input.kind
    : '';
  const message = boundedText(input.message, 240);
  if (!kind || !message) return null;
  const action = { kind, message };

  if (kind === 'navigate') {
    const screen = boundedText(input.screen, 40).toLowerCase().replaceAll('-', '_');
    if (!ALLOWED_SCREENS.has(screen)) return null;
    action.screen = screen;
  }

  if (kind === 'routine') {
    const operation = ['add', 'remove'].includes(input.operation) ? input.operation : 'add';
    action.operation = operation;
    action.routineTitle = boundedText(input.routineTitle, 80);
    if (!action.routineTitle) return null;
    if (operation === 'add') {
      action.routineDetail = boundedText(input.routineDetail, 180);
      action.routineCategory = ['Clinical Topical', 'Lifestyle', 'Nutrition', 'Hair Wash', 'Supplement', 'Other']
        .includes(input.routineCategory) ? input.routineCategory : 'Lifestyle';
      action.routineTime = ['Morning', 'Afternoon', 'Evening', 'Night', 'Daily']
        .includes(input.routineTime) ? input.routineTime : 'Daily';
    }
  }

  if (kind === 'diet_plan') {
    action.planTitle = boundedText(input.planTitle, 80);
    const meals = Array.isArray(input.meals) ? input.meals.slice(0, 12) : [];
    action.meals = meals.map((meal) => ({
      type: boundedText(meal?.type, 24),
      name: boundedText(meal?.name, 100),
      nutrients: boundedText(meal?.nutrients, 100),
      benefit: boundedText(meal?.benefit, 160),
    })).filter((meal) => meal.name);
    if (!action.planTitle || !action.meals.length) return null;
  }

  if (kind === 'reminder') {
    action.reminderTitle = boundedText(input.reminderTitle, 80);
    action.reminderDetail = boundedText(input.reminderDetail, 180);
    action.reminderTime = boundedText(input.reminderTime, 5);
    action.reminderType = ['Topical Serum', 'Supplement', 'Hair Wash', 'Lifestyle', 'Other']
      .includes(input.reminderType) ? input.reminderType : 'Lifestyle';
    const repeatDays = Array.isArray(input.repeatDays) ? input.repeatDays : [];
    action.repeatDays = [...new Set(repeatDays.map(Number).filter((day) => Number.isInteger(day) && day >= 1 && day <= 7))].sort();
    if (!action.reminderTitle || !/^([01]\d|2[0-3]):[0-5]\d$/.test(action.reminderTime) || !action.repeatDays.length) {
      return null;
    }
  }

  return action;
};

export class StreamPatientAssistantReplyUseCase {
  constructor({ geminiAiService }) {
    this.geminiAiService = geminiAiService;
  }

  normalizeMessages(input) {
    if (!Array.isArray(input) || input.length === 0 || input.length > MAX_MESSAGES) {
      throw new BadRequestError(`messages must contain between 1 and ${MAX_MESSAGES} entries.`);
    }

    const messages = input.map((item) => {
      const role = item?.role === 'assistant' ? 'assistant' : item?.role === 'user' ? 'user' : '';
      const content = typeof item?.content === 'string' ? item.content.trim() : '';
      if (!role || !content || content.length > MAX_MESSAGE_LENGTH) {
        throw new BadRequestError('Each message needs a supported role and text up to 1200 characters.');
      }
      return { role, content };
    });

    if (messages[0].role !== 'user' || messages.at(-1).role !== 'user') {
      throw new BadRequestError('Conversation must start with a user message and end with a user message.');
    }
    for (let index = 1; index < messages.length; index += 1) {
      if (messages[index].role === messages[index - 1].role) {
        throw new BadRequestError('Conversation messages must alternate between user and assistant.');
      }
    }
    if (messages.reduce((sum, message) => sum + message.content.length, 0) > MAX_HISTORY_LENGTH) {
      throw new BadRequestError('Conversation history is too long. Start a new chat and try again.');
    }
    return messages;
  }

  async execute({ messages, onToken, onAction, signal, patientContext }) {
    const normalizedMessages = this.normalizeMessages(messages);
    return this.geminiAiService.streamAssistantReply({
      messages: normalizedMessages,
      onToken,
      signal,
      patientContext,
      onAction: async (candidate) => {
        const action = normalizeAssistantAction(candidate);
        if (action && typeof onAction === 'function') await onAction(action);
      },
    });
  }
}
