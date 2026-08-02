#!/usr/bin/env node
// Copies every object from the current R2 bucket (source, read from .env) into a
// production R2 bucket (target). Complements migrate-to-production.js, which only
// moves Postgres data — uploaded files, exports, and org logos live in R2, not the DB.
//
// Usage:
//   # Same Cloudflare account, new prod bucket — reuses source credentials/endpoint:
//   node scripts/migrate-r2-to-production.js --target-bucket prod-bucket-name [--dry-run] [--yes]
//
//   # Separate Cloudflare account for prod:
//   node scripts/migrate-r2-to-production.js --target-bucket prod-bucket-name \
//     --target-endpoint "https://<prod-account-id>.r2.cloudflarestorage.com" \
//     --target-access-key-id "..." --target-secret-access-key "..."
//
// Safe to re-run: objects that already exist on the target with a matching size are
// skipped, so an interrupted or repeated run only copies what's missing.

import 'dotenv/config'
import readline from 'node:readline/promises'
import {
  S3Client,
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3'

function parseArgs(argv) {
  const args = { dryRun: false, yes: false, targetBucket: null, targetEndpoint: null, targetAccessKeyId: null, targetSecretAccessKey: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--target-bucket') args.targetBucket = argv[++i]
    else if (a === '--target-endpoint') args.targetEndpoint = argv[++i]
    else if (a === '--target-access-key-id') args.targetAccessKeyId = argv[++i]
    else if (a === '--target-secret-access-key') args.targetSecretAccessKey = argv[++i]
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--yes') args.yes = true
    else {
      console.error(`Unknown argument: ${a}`)
      process.exit(1)
    }
  }
  if (!args.targetBucket) {
    console.error('Missing required --target-bucket "<production bucket name>"')
    process.exit(1)
  }
  return args
}

async function listAllObjects(client, bucket) {
  const objects = []
  let ContinuationToken
  do {
    const res = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken }))
    objects.push(...(res.Contents ?? []))
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined
  } while (ContinuationToken)
  return objects
}

async function targetHasMatchingObject(targetClient, bucket, key, size) {
  try {
    const head = await targetClient.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    return head.ContentLength === size
  } catch (err) {
    if (err.$metadata?.httpStatusCode === 404 || err.name === 'NotFound') return false
    throw err
  }
}

async function copyObject(sourceClient, sourceBucket, targetClient, targetBucket, key) {
  const got = await sourceClient.send(new GetObjectCommand({ Bucket: sourceBucket, Key: key }))
  const body = await got.Body.transformToByteArray()
  await targetClient.send(
    new PutObjectCommand({
      Bucket: targetBucket,
      Key: key,
      Body: Buffer.from(body),
      ContentType: got.ContentType,
    })
  )
  return body.length
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  const sourceEndpoint = process.env.R2_ENDPOINT
  const sourceBucket = process.env.R2_BUCKET_NAME
  if (!sourceEndpoint || !sourceBucket || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.error('R2_ENDPOINT / R2_BUCKET_NAME / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY must be set in .env (migration source).')
    process.exit(1)
  }

  const sourceClient = new S3Client({
    region: 'auto',
    endpoint: sourceEndpoint,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  })

  const reusingSourceCreds = !args.targetEndpoint && !args.targetAccessKeyId
  const targetEndpoint = args.targetEndpoint ?? sourceEndpoint
  const targetClient = reusingSourceCreds
    ? sourceClient
    : new S3Client({
        region: 'auto',
        endpoint: targetEndpoint,
        credentials: {
          accessKeyId: args.targetAccessKeyId ?? process.env.R2_ACCESS_KEY_ID,
          secretAccessKey: args.targetSecretAccessKey ?? process.env.R2_SECRET_ACCESS_KEY,
        },
      })

  if (targetEndpoint === sourceEndpoint && args.targetBucket === sourceBucket) {
    console.error('Target bucket is identical to the source bucket (same endpoint + name). Refusing to run.')
    process.exit(1)
  }

  console.log(`Source: ${sourceEndpoint} / bucket "${sourceBucket}"`)
  console.log(`Target: ${targetEndpoint} / bucket "${args.targetBucket}"${reusingSourceCreds ? ' (reusing source credentials)' : ''}`)
  console.log(args.dryRun ? 'Mode: DRY RUN (no writes)' : 'Mode: LIVE — this will write to the target bucket')

  console.log('\nListing source objects...')
  const objects = await listAllObjects(sourceClient, sourceBucket)
  const totalBytes = objects.reduce((sum, o) => sum + (o.Size ?? 0), 0)
  console.log(`Found ${objects.length} objects, ${(totalBytes / 1024 / 1024).toFixed(1)} MB total`)

  if (!args.dryRun && !args.yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question('Type MIGRATE to continue: ')
    rl.close()
    if (answer.trim() !== 'MIGRATE') {
      console.log('Aborted.')
      process.exit(1)
    }
  }

  let copied = 0
  let skipped = 0
  let failed = 0
  let bytesCopied = 0

  for (const obj of objects) {
    const key = obj.Key
    try {
      const exists = await targetHasMatchingObject(targetClient, args.targetBucket, key, obj.Size)
      if (exists) {
        skipped++
        continue
      }
      if (args.dryRun) {
        console.log(`  would copy: ${key} (${obj.Size} bytes)`)
        continue
      }
      const size = await copyObject(sourceClient, sourceBucket, targetClient, args.targetBucket, key)
      bytesCopied += size
      copied++
      if (copied % 25 === 0) console.log(`  ...${copied} copied so far`)
    } catch (err) {
      failed++
      console.error(`  FAILED: ${key} — ${err.message}`)
    }
  }

  console.log('\nDone.')
  if (args.dryRun) {
    console.log(`Would copy ${objects.length - skipped} objects (${skipped} already present on target).`)
  } else {
    console.log(`Copied ${copied} objects (${(bytesCopied / 1024 / 1024).toFixed(1)} MB), skipped ${skipped} already present, ${failed} failed.`)
    if (failed > 0) {
      console.log('Re-run the same command to retry failed objects — already-copied ones will be skipped.')
      process.exit(1)
    }
  }
}

main().catch((err) => {
  console.error('\nMigration failed:', err.message)
  process.exit(1)
})
