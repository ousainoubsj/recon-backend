#!/usr/bin/env node
// Sets the CORS policy on the R2 bucket (read from .env) so the browser can PUT
// directly to R2 using presigned URLs (see controllers/files.controller.js). This is
// bucket-level config, invisible to the Express `cors()` middleware in server.js,
// which only governs requests to our own API.
//
// Usage:
//   node scripts/configure-r2-cors.js [--origin "https://extra-origin.com"]... [--yes]
//
// Always includes FRONTEND_URL from .env; pass --origin to add more (e.g. a staging
// URL or localhost for local testing against the same bucket). The target bucket is
// whatever R2_ENDPOINT/R2_BUCKET_NAME resolve to in .env — NOT which machine you run
// this from — so it prompts with the resolved bucket/origins before writing. Pass
// --yes to skip the prompt (e.g. in CI). Safe to re-run — PutBucketCorsCommand
// replaces the whole policy each time.

import 'dotenv/config'
import readline from 'node:readline/promises'
import { S3Client, PutBucketCorsCommand, GetBucketCorsCommand } from '@aws-sdk/client-s3'

function parseArgs(argv) {
  const origins = []
  let yes = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--origin') origins.push(argv[++i])
    else if (argv[i] === '--yes') yes = true
    else {
      console.error(`Unknown argument: ${argv[i]}`)
      process.exit(1)
    }
  }
  return { origins, yes }
}

async function main() {
  const { origins: extraOrigins, yes } = parseArgs(process.argv.slice(2))

  const endpoint = process.env.R2_ENDPOINT
  const bucket = process.env.R2_BUCKET_NAME
  if (!endpoint || !bucket || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.error('R2_ENDPOINT / R2_BUCKET_NAME / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY must be set in .env.')
    process.exit(1)
  }

  const origins = [...new Set([process.env.FRONTEND_URL, ...extraOrigins].filter(Boolean))]
  if (origins.length === 0) {
    console.error('No origins to allow — set FRONTEND_URL in .env or pass --origin.')
    process.exit(1)
  }

  const client = new S3Client({
    region: 'auto',
    endpoint,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  })

  console.log(`Bucket: "${bucket}" (${endpoint})`)
  console.log(`Allowed origins: ${origins.join(', ')}`)

  if (!yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question('\nThis will REPLACE the CORS policy on the bucket above. Type APPLY to continue: ')
    rl.close()
    if (answer.trim() !== 'APPLY') {
      console.log('Aborted.')
      process.exit(1)
    }
  }

  await client.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: origins,
            AllowedMethods: ['PUT'],
            AllowedHeaders: ['*'],
            MaxAgeSeconds: 3600,
          },
        ],
      },
    })
  )

  const check = await client.send(new GetBucketCorsCommand({ Bucket: bucket }))
  console.log('\nApplied. Current bucket CORS policy:')
  console.log(JSON.stringify(check.CORSRules, null, 2))
}

main().catch((err) => {
  console.error('\nFailed to configure R2 CORS:', err.message)
  process.exit(1)
})
