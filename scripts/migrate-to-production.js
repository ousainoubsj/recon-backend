#!/usr/bin/env node
// Copies all application data from the current DATABASE_URL (source, read from .env)
// into a production database (target, passed explicitly — never defaulted, so this
// can never accidentally run against the wrong database).
//
// Usage:
//   node scripts/migrate-to-production.js --target "postgresql://...prod-host.../db?sslmode=require" [--dry-run] [--yes]
//
// What it does:
//   1. Runs `prisma migrate deploy` against the target so its schema matches source exactly.
//   2. Introspects the live Postgres catalog on the target (real table/column names,
//      honoring Prisma's @@map/@map overrides) and topologically sorts tables so
//      parents are inserted before the children that reference them via FK.
//   3. Copies every row per table inside one transaction, batched, using
//      `ON CONFLICT (<primary key>) DO NOTHING` — safe to re-run without duplicating rows.
//
// It does NOT touch the source database and does NOT delete/truncate the target
// unless you pass --truncate-target (wipes app tables on target before copying).

import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import readline from 'node:readline/promises'
import pg from 'pg'

const { Pool } = pg

const BATCH_SIZE = 500
const SKIP_TABLES = new Set(['_prisma_migrations'])

function parseArgs(argv) {
  const args = { dryRun: false, yes: false, truncateTarget: false, target: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--target') args.target = argv[++i]
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--yes') args.yes = true
    else if (a === '--truncate-target') args.truncateTarget = true
    else {
      console.error(`Unknown argument: ${a}`)
      process.exit(1)
    }
  }
  if (!args.target) {
    console.error('Missing required --target "<production DATABASE_URL>"')
    process.exit(1)
  }
  return args
}

function redact(url) {
  return url.replace(/:\/\/([^:]+):[^@]+@/, '://$1:****@')
}

async function getTablesInDependencyOrder(pool) {
  const { rows: tables } = await pool.query(`
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  `)
  const names = tables.map((t) => t.table_name).filter((t) => !SKIP_TABLES.has(t))

  const { rows: fks } = await pool.query(`
    SELECT
      tc.table_name AS child,
      ccu.table_name AS parent
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
  `)

  const dependsOn = new Map(names.map((n) => [n, new Set()]))
  for (const { child, parent } of fks) {
    if (child === parent) continue // self-referencing FK, ignore for ordering
    if (dependsOn.has(child) && dependsOn.has(parent)) dependsOn.get(child).add(parent)
  }

  const ordered = []
  const visited = new Set()
  const visiting = new Set()

  function visit(name, path) {
    if (visited.has(name)) return
    if (visiting.has(name)) {
      throw new Error(`Circular foreign-key dependency detected: ${[...path, name].join(' -> ')}`)
    }
    visiting.add(name)
    for (const dep of dependsOn.get(name) ?? []) visit(dep, [...path, name])
    visiting.delete(name)
    visited.add(name)
    ordered.push(name)
  }

  for (const name of names) visit(name, [])
  return ordered
}

async function getColumns(pool, table) {
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table]
  )
  return rows.map((r) => r.column_name)
}

async function getPrimaryKeyColumns(pool, table) {
  const { rows } = await pool.query(
    `SELECT a.attname AS column_name
     FROM pg_index i
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = $1::regclass AND i.indisprimary`,
    [`"${table}"`]
  )
  return rows.map((r) => r.column_name)
}

function quoteIdent(name) {
  return `"${name.replace(/"/g, '""')}"`
}

async function copyTable(sourcePool, targetPool, table, { dryRun }) {
  const columns = await getColumns(sourcePool, table)
  const pkColumns = await getPrimaryKeyColumns(targetPool, table)
  const colList = columns.map(quoteIdent).join(', ')

  const { rows: countRows } = await sourcePool.query(`SELECT count(*)::int AS n FROM ${quoteIdent(table)}`)
  const total = countRows[0].n
  if (total === 0) {
    console.log(`  ${table}: 0 rows, skipping`)
    return { table, copied: 0 }
  }

  if (dryRun) {
    console.log(`  ${table}: ${total} rows (dry run, not copied)`)
    return { table, copied: 0 }
  }

  let copied = 0
  for (let offset = 0; offset < total; offset += BATCH_SIZE) {
    const { rows } = await sourcePool.query(
      `SELECT ${colList} FROM ${quoteIdent(table)} ORDER BY ${pkColumns.length ? pkColumns.map(quoteIdent).join(', ') : '1'} LIMIT $1 OFFSET $2`,
      [BATCH_SIZE, offset]
    )
    if (rows.length === 0) break

    const values = []
    const tuples = rows.map((row, i) => {
      const placeholders = columns.map((_, j) => `$${i * columns.length + j + 1}`)
      for (const col of columns) values.push(row[col])
      return `(${placeholders.join(', ')})`
    })

    const conflictClause = pkColumns.length ? `ON CONFLICT (${pkColumns.map(quoteIdent).join(', ')}) DO NOTHING` : ''

    await targetPool.query(
      `INSERT INTO ${quoteIdent(table)} (${colList}) VALUES ${tuples.join(', ')} ${conflictClause}`,
      values
    )
    copied += rows.length
  }

  console.log(`  ${table}: copied ${copied}/${total} rows`)
  return { table, copied }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const sourceUrl = process.env.DATABASE_URL
  if (!sourceUrl) {
    console.error('DATABASE_URL is not set (expected in recon-backend/.env) — this is the migration source.')
    process.exit(1)
  }
  if (sourceUrl.trim() === args.target.trim()) {
    console.error('--target is identical to the source DATABASE_URL. Refusing to run.')
    process.exit(1)
  }

  console.log(`Source (dev):   ${redact(sourceUrl)}`)
  console.log(`Target (prod):  ${redact(args.target)}`)
  console.log(args.dryRun ? 'Mode: DRY RUN (no writes)' : 'Mode: LIVE — this will write to the target database')
  if (args.truncateTarget) console.log('--truncate-target set: app tables on target will be wiped before copying')

  if (!args.dryRun && !args.yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question('Type MIGRATE to continue: ')
    rl.close()
    if (answer.trim() !== 'MIGRATE') {
      console.log('Aborted.')
      process.exit(1)
    }
  }

  if (!args.dryRun) {
    console.log('\nRunning `prisma migrate deploy` against target...')
    const result = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: args.target },
    })
    if (result.status !== 0) {
      console.error('prisma migrate deploy failed, aborting before touching data.')
      process.exit(1)
    }
  }

  const sourcePool = new Pool({ connectionString: sourceUrl })
  const targetPool = new Pool({ connectionString: args.target })

  try {
    const order = await getTablesInDependencyOrder(targetPool)
    console.log(`\nTable order (${order.length} tables):\n  ${order.join(', ')}`)

    if (args.truncateTarget && !args.dryRun) {
      console.log('\nTruncating target tables...')
      await targetPool.query(`TRUNCATE TABLE ${order.map(quoteIdent).join(', ')} CASCADE`)
    }

    console.log('\nCopying data...')
    const client = await targetPool.connect()
    const summary = []
    try {
      if (!args.dryRun) await client.query('BEGIN')
      for (const table of order) {
        const result = await copyTable(sourcePool, args.dryRun ? targetPool : { query: (...a) => client.query(...a) }, table, args)
        summary.push(result)
      }
      if (!args.dryRun) await client.query('COMMIT')
    } catch (err) {
      if (!args.dryRun) await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    console.log('\nDone.')
    if (!args.dryRun) {
      const totalCopied = summary.reduce((sum, s) => sum + s.copied, 0)
      console.log(`Copied ${totalCopied} rows across ${summary.length} tables.`)
    }
  } finally {
    await sourcePool.end()
    await targetPool.end()
  }
}

main().catch((err) => {
  console.error('\nMigration failed:', err.message)
  process.exit(1)
})
