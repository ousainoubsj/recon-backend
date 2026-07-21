import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { requirePermission } from '../middleware/authorize.js';
import { catchAsync } from '../utils/catchAsync.js';
import * as searchController from '../controllers/search.controller.js';

export const searchRouter = Router();

// Gated by report:read (all three roles have it) since results include
// report data — effectively every authenticated org member can search.
searchRouter.get(
  '/',
  authenticate,
  catchAsync(requirePermission('report', 'read')),
  catchAsync(searchController.search),
);
