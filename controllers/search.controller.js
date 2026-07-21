import * as searchService from '../services/searchService.js';

export const search = async (req, res) => {
  const results = await searchService.search(req.session.user.id, req.query.q);
  res.json(results);
};
