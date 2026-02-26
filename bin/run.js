#!/usr/bin/env node

const path = require('path')

async function main() {
  const {run} = require('@oclif/core')
  await run(process.argv.slice(2), {root: path.join(__dirname, '..')})
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
