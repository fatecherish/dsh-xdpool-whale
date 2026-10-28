#!/usr/bin/env node
// 用 GitHub REST API 创建 Release。token 从环境变量 GITHUB_TOKEN 读，不落盘。
// 用法：GITHUB_TOKEN=xxx node scripts/create-release.mjs <tag> <notes-file> [title]
import { readFileSync } from 'node:fs'

const [tag, notesFile, title] = process.argv.slice(2)
const token = process.env.GITHUB_TOKEN

if (!token) {
  console.error('缺少 GITHUB_TOKEN 环境变量')
  process.exit(1)
}
if (!tag || !notesFile) {
  console.error('用法: GITHUB_TOKEN=xxx node scripts/create-release.mjs <tag> <notes-file> [title]')
  process.exit(1)
}

const owner = 'fatecherish'
const repo = 'dsh-xdpool-whale'

const body = {
  tag_name: tag,
  name: title || tag,
  body: readFileSync(notesFile, 'utf8'),
  draft: false,
  prerelease: false,
  generate_release_notes: false,
}

const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dsh-xdpool-whale',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(body),
})

const json = await res.json()

if (!res.ok) {
  console.error(`创建失败 HTTP ${res.status}`)
  console.error(JSON.stringify(json, null, 2))
  process.exit(1)
}

console.log('✓ Release 创建成功')
console.log(`  标题: ${json.name}`)
console.log(`  tag : ${json.tag_name}`)
console.log(`  状态: ${json.draft ? '草稿' : '已发布'}${json.prerelease ? ' / 预发布' : ''}`)
console.log(`  地址: ${json.html_url}`)
