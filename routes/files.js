import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { requirePermission } from '../middleware/authorize.js';
import { catchAsync } from '../utils/catchAsync.js';
import { createPresignedUpload } from '../controllers/files.controller.js';

export const filesRouter = Router();

filesRouter.post(
  '/presign',
  authenticate,
  catchAsync(requirePermission('file', 'upload')),
  catchAsync(createPresignedUpload),
);
