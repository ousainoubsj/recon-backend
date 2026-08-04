import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { catchAsync } from '../utils/catchAsync.js';
import * as supportController from '../controllers/support.controller.js';

// No RBAC resource — any authenticated user, regardless of role, can send a
// help request (same "per-recipient, not org-scoped" reasoning as notifications).
export const supportRouter = Router();

supportRouter.post('/', authenticate, catchAsync(supportController.sendRequest));
