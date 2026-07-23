import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { FileTooLargeError, ValidationError } from '../errors.js';
import { logAuditSafely } from '../services/auditLogService.js';

const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const ALLOWED_CONTENT_TYPES = new Set([
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

export const createPresignedUpload = async (req, res) => {
  const { filename, contentType, size } = req.body;

  if (typeof size !== 'number' || size > 50 * 1024 * 1024) {
    throw new FileTooLargeError();
  }
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new ValidationError('Only CSV and XLSX files are accepted');
  }

  const key = `uploads/${req.session.user.id}/${Date.now()}-${filename}`;
  const presignedUrl = await getSignedUrl(
    r2,
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      ContentType: contentType,
    }),
    { expiresIn: 300 },
  );

  res.json({ url: presignedUrl, key });

  // Only confirms the presign was issued, not that the browser's direct-to-R2
  // PUT actually succeeded afterward — the backend never learns that, by design.
  await logAuditSafely(req.session.user.id, {
    action: 'file.upload_initiated',
    entityType: 'file',
    status: 'info',
    ip: req.ip,
    metadata: { filename, contentType },
  });
};
