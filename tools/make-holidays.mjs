#!/usr/bin/env node
/* 生成 js/holidays.js —— 中国大陆法定节假日与调休安排
 *
 * 数据来源：https://github.com/NateScarlet/holiday-cn
 * （按国务院办公厅每年发布的通知整理，JSON 一年一个文件）
 *
 * 走 GitHub API 而不是 raw.githubusercontent.com：后者在部分网络下会被重置。
 *
 * 用法：node tools/make-holidays.mjs [年份...]
 *      默认抓取 2024–2027，拿不到的年份跳过。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'js', 'holidays.js');

const REPO = 'NateScarlet/holiday-cn';
const years = process.argv.slice(2).map(Number).filter(Boolean);
const YEARS = years.length ? years : [2024, 2025, 2026, 2027];

async function fetchYear(year) {
  const url = `https://api.github.com/repos/${REPO}/contents/${year}.json`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'LifeBoard-build', Accept: 'application/vnd.github+json' }
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const text = Buffer.from(body.content, 'base64').toString('utf8');
  return JSON.parse(text);
}

const merged = {};
const got = [];

for (const year of YEARS) {
  try {
    const data = await fetchYear(year);
    if (!data || !Array.isArray(data.days) || !data.days.length) {
      console.log(`${year}  没有数据，跳过`);
      continue;
    }
    let off = 0, work = 0;
    for (const d of data.days) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) continue;
      merged[d.date] = { name: String(d.name || '').slice(0, 20), off: !!d.isOffDay };
      d.isOffDay ? off++ : work++;
    }
    got.push(year);
    console.log(`${year}  OK  放假 ${off} 天，调休上班 ${work} 天`);
  } catch (err) {
    console.log(`${year}  失败：${err.message}`);
  }
}

const dates = Object.keys(merged).sort();
if (!dates.length) {
  console.error('一条数据都没拿到，不覆盖已有文件');
  process.exit(1);
}

// 按“放假连休的第一天”标注节日名：台历上也是这么印的，不必每天都写
function isRunStart(date) {
  const d = new Date(date + 'T00:00:00');
  d.setDate(d.getDate() - 1);
  const prev = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const p = merged[prev];
  return !(p && p.off && p.name === merged[date].name);
}

const lines = dates.map((date) => {
  const h = merged[date];
  const first = h.off && isRunStart(date) ? ', first: true' : '';
  return `  "${date}": { name: "${h.name}", off: ${h.off}${first} }`;
});

const body = `/* LifeBoard · 中国大陆法定节假日与调休安排
 *
 * 数据来源：https://github.com/${REPO}
 * 由国务院办公厅每年发布的通知整理。生成脚本：tools/make-holidays.mjs
 *
 *   off: true   放假（法定节假日，以及调休形成的连休）
 *   off: false  调休上班（通常落在周末，但那天要上班）
 *   first: true 这一段连休的第一天，台历上会标出节日名
 *
 * 覆盖年份：${got.join('、')}
 * 生成时间：${new Date().toISOString()}
 *
 * 新的一年公布后，重新跑一次生成脚本即可。
 */
(function (global) {
  'use strict';
  global.LB_HOLIDAYS = {
${lines.join(',\n')}
  };
})(window);
`;

fs.writeFileSync(OUT, body, 'utf8');
console.log(`\n写入 ${path.relative(path.join(HERE, '..'), OUT)}：${dates.length} 天，${got.length} 个年份，${fs.statSync(OUT).size} 字节`);
