import { ValidationError } from '../errors.js';
import * as supportService from '../services/supportService.js';

const MAX_MESSAGE_LENGTH = 4000;

export const sendRequest = async (req, res) => {
  const message = req.body?.message?.trim();
  if (!message) throw new ValidationError('Message is required', [{ field: 'message', message: 'Message is required' }]);
  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new ValidationError('Message is too long', [{ field: 'message', message: `Must be ${MAX_MESSAGE_LENGTH} characters or fewer` }]);
  }

  await supportService.sendHelpRequest(req.session.user.id, message);
  res.status(204).end();
};
