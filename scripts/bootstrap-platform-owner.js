#!/usr/bin/env node
// Creates the one platform owner (docs/SUPER_ADMIN_PLAN.md), or promotes an existing account that belongs to no
// company, then emails them a set-password link. Refuses if an owner already exists.
//
// Usage:
//   PLATFORM_OWNER_EMAIL=owner@example.com PLATFORM_OWNER_NAME="Jane Doe" npm run platform:bootstrap-owner
//
// The target database and email sender are whatever .env points at.

import 'dotenv/config'
import { generateId } from 'better-auth'
import { prisma } from '../config/prisma.config.js'
import { auth } from '../auth.js'

const email = process.env.PLATFORM_OWNER_EMAIL?.trim().toLowerCase()
const name = process.env.PLATFORM_OWNER_NAME?.trim()
if (!email || !name) {
  console.error('Set PLATFORM_OWNER_EMAIL and PLATFORM_OWNER_NAME before running this script.')
  process.exit(1)
}
if (!process.env.FRONTEND_URL) {
  console.error('FRONTEND_URL must be set: the set-password link points there.')
  process.exit(1)
}

try {
  const owner = await prisma.user.findFirst({ where: { platformRole: 'owner' }, select: { email: true } })
  if (owner) throw new Error(`A platform owner already exists (${owner.email}).`)

  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true, members: { where: { isSupport: false }, select: { id: true } } },
  })
  if (existing && existing.members.length > 0) {
    throw new Error(`${email} belongs to a company. The owner must be an account with no company membership.`)
  }

  if (existing) {
    await prisma.user.update({ where: { id: existing.id }, data: { platformRole: 'owner', platformStatus: 'active', name } })
    console.log(`Promoted ${email} to platform owner.`)
  } else {
    await prisma.user.create({
      data: { id: generateId(), email, name, emailVerified: true, platformRole: 'owner', platformStatus: 'active' },
    })
    console.log(`Created platform owner ${email}.`)
  }

  await auth.api.requestPasswordReset({ body: { email, redirectTo: `${process.env.FRONTEND_URL}/` } })
  console.log('Set-password email sent.')
} catch (err) {
  console.error(err.message)
  process.exitCode = 1
} finally {
  await prisma.$disconnect()
  process.exit()
}
