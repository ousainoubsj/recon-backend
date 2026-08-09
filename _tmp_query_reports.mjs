import dotenv from 'dotenv';
dotenv.config();
const { prisma } = await import('./config/prisma.config.js');

const reports = await prisma.report.findMany({
  where: {
    OR: [
      { fileAName: { contains: 'AFTAB', mode: 'insensitive' } },
      { fileBName: { contains: 'AFTAB', mode: 'insensitive' } },
      { name: { contains: 'AFTAB', mode: 'insensitive' } },
    ],
  },
  select: {
    id: true, name: true, status: true, fileAName: true, fileBName: true, fileAKey: true, fileBKey: true,
    userId: true, organizationId: true, columnMapping: true, config: true, totalRows: true, createdAt: true,
  },
  orderBy: { createdAt: 'desc' },
  take: 5,
});
console.log(JSON.stringify(reports, null, 2));
process.exit(0);
